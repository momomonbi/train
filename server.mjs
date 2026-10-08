import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProviders, ServiceError } from "./providers.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/train-core.js", "train-core.js"],
  ["/holidays.js", "holidays.js"],
  ["/test_api.html", "test_api.html"],
  ["/test-api.js", "test-api.js"],
]);
export function createTrainServer({
  fetchImpl = fetch,
  initialKeys = {},
} = {}) {
  const token = randomBytes(32).toString("hex");
  const keys = {
    openai: initialKeys.openai || "",
    odpt: initialKeys.odpt || "",
    ekispert: initialKeys.ekispert || "",
  };
  const services = createProviders(fetchImpl);
  let aiBusy = false;
  const config = () => ({
    csrf: token,
    openaiEnabled: Boolean(keys.openai),
    odptEnabled: Boolean(keys.odpt),
    ekispertEnabled: Boolean(keys.ekispert),
  });
  const send = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const expectedHost = "127.0.0.1:" + server.address().port;
    if (req.headers.host !== expectedHost)
      return send(res, 403, {
        error: "このPCのローカルアドレスからアクセスしてください。",
      });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api-public.odpt.org https://express.heartrails.com; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (req.method === "GET") {
        if (req.url === "/api/config") return send(res, 200, config());
        const file = files.get(req.url);
        if (file) {
          const data = await readFile(join(directory, file));
          res.writeHead(200, {
            "Content-Type": file.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/html; charset=utf-8",
          });
          return res.end(data);
        }
        return send(res, 404, { error: "見つかりません。" });
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== "http://" + expectedHost ||
        req.headers["x-train-token"] !== token ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return send(res, 403, { error: "画面を開き直してください。" });
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new ServiceError("入力が大きすぎます。", 413);
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/api/settings") {
        for (const field of Object.keys(keys))
          if (Object.hasOwn(input, field)) {
            const value = input[field];
            if (
              typeof value !== "string" ||
              value.length > 600 ||
              /\s/.test(value.trim())
            )
              throw new ServiceError("APIキーの入力を確認してください。");
          }
        for (const field of Object.keys(keys))
          if (Object.hasOwn(input, field)) keys[field] = input[field].trim();
        return send(res, 200, config());
      }
      const controller = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.on("close", onClose);
      const timer = setTimeout(
        () => controller.abort(),
        req.url === "/api/responses" ? 120000 : 30000,
      );
      try {
        let result;
        if (req.url === "/api/route")
          result = await services.route(
            input,
            keys.ekispert,
            controller.signal,
          );
        else if (req.url === "/api/odpt")
          result = await services.odpt(
            input.type,
            input.station,
            keys.odpt,
            controller.signal,
          );
        else if (req.url === "/api/responses") {
          if (aiBusy)
            throw new ServiceError(
              "AI検索が進行中です。終了を待ってください。",
              409,
            );
          aiBusy = true;
          try {
            result = await services.responses(
              input,
              keys.openai,
              controller.signal,
            );
          } finally {
            aiBusy = false;
          }
        } else return send(res, 404, { error: "見つかりません。" });
        // Return only provider data. Authentication fields never enter request logs or exports.
        return send(res, 200, result);
      } finally {
        clearTimeout(timer);
        res.removeListener("close", onClose);
      }
    } catch (error) {
      if (res.destroyed) return;
      const isAbort = error?.name === "AbortError";
      const known = error instanceof ServiceError;
      send(res, known ? error.status : isAbort ? 504 : 500, {
        error: known
          ? error.message
          : isAbort
            ? "取得を中止、またはタイムアウトしました。"
            : "取得に失敗しました。入力と接続を確認してください。",
        ...(known ? error.details : {}),
      });
    }
  });
  server.on("close", () => {
    Object.keys(keys).forEach((k) => (keys[k] = ""));
  });
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = Number(process.env.TRAIN_PORT || 8780);
  const server = createTrainServer({
    initialKeys: {
      openai: process.env.OPENAI_API_KEY,
      odpt: process.env.ODPT_API_KEY,
      ekispert: process.env.EKISPERT_API_KEY,
    },
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`乗換案内: http://127.0.0.1:${port}`),
  );
  process.on("SIGINT", () => server.close());
  process.on("SIGTERM", () => server.close());
}
