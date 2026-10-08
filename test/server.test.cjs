const test = require("node:test"),
  assert = require("node:assert/strict");
test("ローカルサーバーはOrigin・トークン・Hostを確認し、キーを返さない", async (t) => {
  const { createTrainServer } = await import("../server.mjs");
  let calls = 0;
  const server = createTrainServer({
    fetchImpl: async () => {
      calls++;
      throw new Error("No upstream calls expected");
    },
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const config = await fetch(base + "/api/config").then((r) => r.json());
  const send = (headers, body) =>
    fetch(base + "/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await send({}, { openai: "fixture-secret" })).status, 403);
  assert.equal(
    (
      await send(
        { Origin: "https://attacker.example", "X-Train-Token": config.csrf },
        { openai: "fixture-secret" },
      )
    ).status,
    403,
  );
  const accepted = await send(
    { Origin: base, "X-Train-Token": config.csrf },
    { openai: "fixture-secret" },
  );
  assert.equal(accepted.status, 200);
  const summary = await accepted.text();
  assert.ok(!summary.includes("fixture-secret"));
  assert.equal(JSON.parse(summary).openaiEnabled, true);
  assert.equal((await fetch(base + "/providers.mjs")).status, 404);
  const badHost = await new Promise((resolve, reject) => {
    require("node:http")
      .get(
        base + "/",
        { headers: { Host: "attacker.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(badHost, 403);
  assert.equal(calls, 0);
  const clear = await send(
    { Origin: base, "X-Train-Token": config.csrf },
    { openai: "" },
  );
  assert.equal((await clear.json()).openaiEnabled, false);
});
test("ブラウザー検索の中止が上流取得へ伝わる", async (t) => {
  const { createTrainServer } = await import("../server.mjs");
  let upstreamSignal, started;
  const wait = new Promise((resolve) => (started = resolve));
  const server = createTrainServer({
    fetchImpl: async (url, { signal }) => {
      upstreamSignal = signal;
      started();
      return new Promise((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        ),
      );
    },
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const base = "http://127.0.0.1:" + server.address().port,
    config = await fetch(base + "/api/config").then((r) => r.json());
  const controller = new AbortController();
  const request = fetch(base + "/api/odpt", {
    method: "POST",
    headers: {
      Origin: base,
      "Content-Type": "application/json",
      "X-Train-Token": config.csrf,
    },
    body: JSON.stringify({ type: "info" }),
    signal: controller.signal,
  }).catch((e) => e);
  await wait;
  controller.abort();
  await request;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(upstreamSignal.aborted, true);
});
