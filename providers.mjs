import Core from "./train-core.js";

export class ServiceError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
async function jsonResponse(response, label) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ServiceError(
      `${label}の取得に失敗しました（HTTP ${response.status}）。`,
      502,
    );
  }
  const data = await response.json();
  return data;
}
export function createProviders(fetchImpl = fetch) {
  async function ekispert(path, params, key, signal) {
    const query = new URLSearchParams({ ...params, key });
    const data = await jsonResponse(
      await fetchImpl("https://api.ekispert.jp/v1/json/" + path + "?" + query, {
        signal,
      }),
      "乗換API",
    );
    if (data?.ResultSet?.Error)
      throw new ServiceError(
        "乗換APIの設定・契約範囲・検索条件を確認してください。",
        502,
      );
    return data;
  }
  async function resolveStation(name, code, key, signal, field) {
    const data = await ekispert(
      "station",
      code ? { code } : { name, type: "train", limit: "100" },
      key,
      signal,
    );
    const points = Core.asArray(data?.ResultSet?.Point);
    const candidates = points
      .map((p) => ({
        code: String(p.Station?.code || ""),
        name: Core.text(p.Station?.Name),
        prefecture: Core.text(p.Prefecture?.Name),
      }))
      .filter((p) => p.code && p.name);
    const exact = candidates.filter(
      (p) => Core.stationName(p.name) === Core.stationName(name),
    );
    if (exact.length === 1) return exact[0];
    if (!exact.length && !code)
      throw new ServiceError(`「${name}」の駅を選択してください。`, 422, {
        stationChoices: { field, candidates: candidates.slice(0, 20) },
      });
    if (!exact.length)
      throw new ServiceError(
        "駅名と選択した駅コードが一致しません。駅を選び直してください。",
        422,
      );
    throw new ServiceError(`「${name}」の駅を選択してください。`, 422, {
      stationChoices: { field, candidates: exact },
    });
  }
  async function route(params, key, signal) {
    if (!key)
      throw new ServiceError(
        "アプリ内表示には駅すぱあとAPIのダイヤ探索用キーが必要です。無料の乗換検索を利用できます。",
        503,
      );
    try {
      Core.validateParams(params);
    } catch (error) {
      throw new ServiceError(error.message);
    }
    // These conditions require a dedicated provider condition adapter. Never silently drop them.
    if (
      params.barrierFree ||
      params.avoidDelay ||
      params.commuterPass ||
      params.trainName ||
      (params.specialTicket && params.specialTicket !== "none") ||
      params.excluded?.length ||
      params.walkSpeed !== "normal"
    )
      throw new ServiceError(
        "このAPI接続の追加条件にはまだ対応していません。検索先で条件を確認してください。",
        422,
        { unsupportedConditions: true },
      );
    const names = [
      params.from,
      ...(params.via || "")
        .split(/[,、，]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      params.to,
    ];
    const resolved = [];
    for (let i = 0; i < names.length; i++) {
      const field =
        i === 0
          ? "from"
          : i === names.length - 1
            ? "to"
            : "via:" + String(i - 1);
      const code =
        i === 0
          ? params.fromId
          : i === names.length - 1
            ? params.toId
            : (params.viaIds || [])[i - 1];
      if (code && !/^\d{1,8}$/.test(String(code)))
        throw new ServiceError("駅コードが不正です。");
      resolved.push(await resolveStation(names[i], code, key, signal, field));
    }
    const resolvedParams = {
      ...params,
      fromId: resolved[0].code,
      toId: resolved.at(-1).code,
      viaIds: resolved.slice(1, -1).map((x) => x.code),
    };
    const data = await ekispert(
      "search/course/extreme",
      {
        viaList: resolved.map((x) => x.code).join(":"),
        date: params.date.replaceAll("-", ""),
        time: params.time.replace(":", ""),
        searchType: {
          departure: "departure",
          arrival: "arrival",
          first: "firstTrain",
          last: "lastTrain",
        }[params.timeType],
        sort:
          {
            recommended: "ekispert",
            fast: "time",
            cheap: "price",
            less_transfer: "transfer",
          }[params.priority] || "ekispert",
        answerCount: "3",
      },
      key,
      signal,
    );
    const result = Core.normalizeEkispert(data, resolvedParams);
    return { ...result, conditions: resolvedParams, stations: resolved };
  }
  async function odpt(type, stationName, key, signal) {
    const base = key
      ? "https://api.odpt.org/api/v4/"
      : "https://api-public.odpt.org/api/v4/";
    const call = async (path, query = {}) => {
      const q = new URLSearchParams(query);
      if (key) q.set("acl:consumerKey", key);
      const data = await jsonResponse(
        await fetchImpl(base + path + "?" + q, { signal }),
        "ODPT",
      );
      if (!Array.isArray(data))
        throw new ServiceError("ODPTの応答形式を確認できません。", 502);
      return data;
    };
    if (type === "info") return call("odpt:TrainInformation");
    if (
      type !== "timetable" ||
      typeof stationName !== "string" ||
      !stationName.trim() ||
      stationName.length > 100
    )
      throw new ServiceError("駅名を確認してください。");
    const stations = await call("odpt:Station", { "dc:title": stationName });
    const result = [];
    for (const s of stations.slice(0, 5))
      if (Core.text(s["owl:sameAs"]))
        result.push(
          ...(await call("odpt:StationTimetable", {
            "odpt:station": s["owl:sameAs"],
          })),
        );
    return result;
  }
  async function responses(
    { input, model = "gpt-6-luna", searchContext = "medium", maxTokens = 4000 },
    key,
    signal,
  ) {
    if (!key)
      throw new ServiceError("API設定でOpenAIキーを入力してください。", 503);
    if (!["gpt-6-luna", "gpt-6.1-sol"].includes(model))
      throw new ServiceError("対応していないモデルです。");
    if (typeof input !== "string" || !input.trim() || input.length > 12000)
      throw new ServiceError("検索内容を確認してください。");
    const body = {
      model,
      input,
      reasoning: { effort: "low" },
      tools: [
        {
          type: "web_search",
          search_context_size: ["low", "medium", "high"].includes(searchContext)
            ? searchContext
            : "medium",
          user_location: { type: "approximate", country: "JP" },
        },
      ],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      max_tool_calls: 4,
      max_output_tokens: Math.min(
        8000,
        Math.max(512, Number(maxTokens) || 4000),
      ),
      store: false,
    };
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(
        {
          401: "APIキーを認証できません。",
          403: "モデルへのアクセス権を確認してください。",
          429: "APIの利用上限・残高を確認してください。",
        }[response.status] ||
          `OpenAI APIの取得に失敗しました（HTTP ${response.status}）。`,
        502,
      );
    }
    const data = await response.json();
    if (data.status !== "completed")
      throw new ServiceError(
        "AIの応答が完了していません。再実行する前に利用状況を確認してください。",
        502,
      );
    return {
      status: data.status,
      model: data.model,
      output: data.output,
      output_text: Core.responseText(data),
      usage: data.usage,
    };
  }
  return { route, odpt, responses };
}
