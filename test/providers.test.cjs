const test = require("node:test"),
  assert = require("node:assert/strict");
const { params, providerRoute } = require("./fixtures.cjs");
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
test("専用APIキーなしでは外部呼び出しをしない", async () => {
  const { createProviders } = await import("../providers.mjs");
  let count = 0;
  const p = createProviders(async () => {
    count++;
  });
  await assert.rejects(
    p.route(params, "", new AbortController().signal),
    /キー/,
  );
  assert.equal(count, 0);
});
test("同名駅を選ぶまで経路探索しない・追加条件も黙って捨てない", async () => {
  const { createProviders } = await import("../providers.mjs");
  let count = 0;
  const p = createProviders(async () => {
    count++;
    return json({
      ResultSet: {
        Point: [
          {
            Station: { code: "1", Name: "川間" },
            Prefecture: { Name: "千葉県" },
          },
          {
            Station: { code: "9", Name: "川間" },
            Prefecture: { Name: "他県" },
          },
        ],
      },
    });
  });
  await assert.rejects(
    p.route(params, "fixture-key"),
    (e) => e.status === 422 && e.details.stationChoices.candidates.length === 2,
  );
  assert.equal(count, 1);
  await assert.rejects(
    p.route({ ...params, avoidDelay: true }, "fixture-key"),
    /追加条件/,
  );
  assert.equal(count, 1);
});
test("駅コード・日時・到着条件・経由を単一の全体探索へ渡す", async () => {
  const { createProviders } = await import("../providers.mjs");
  const seen = [];
  const p = createProviders(async (input) => {
    const u = new URL(input);
    seen.push(u);
    if (u.pathname.endsWith("/station")) {
      const name = u.searchParams.get("name");
      return json({
        ResultSet: {
          Point: {
            Station: {
              Name: name,
              code: { 川間: "1", 春日部: "3", 大宮: "2" }[name],
            },
          },
        },
      });
    }
    const d = providerRoute();
    const route = d.ResultSet.Course.Route;
    route.Point.splice(1, 0, { Station: { Name: "春日部", code: "3" } });
    route.Line = [
      {
        ...route.Line,
        ArrivalState: { Datetime: { text: "2026-10-09T09:20:00+09:00" } },
      },
      {
        ...route.Line,
        DepartureState: { Datetime: { text: "2026-10-09T09:22:00+09:00" } },
      },
    ];
    return json(d);
  });
  const result = await p.route(
    { ...params, via: "春日部", timeType: "arrival", time: "10:00" },
    "fixture-key",
  );
  assert.equal(result.routes.length, 1);
  const q = seen.at(-1).searchParams;
  assert.equal(q.get("viaList"), "1:3:2");
  assert.equal(q.get("date"), "20261009");
  assert.equal(q.get("time"), "1000");
  assert.equal(q.get("searchType"), "arrival");
  assert.equal(seen.filter((u) => u.pathname.endsWith("/extreme")).length, 1);
});
test("Responsesへ現行モデル・検索・store:falseを1回送る", async () => {
  const { createProviders } = await import("../providers.mjs");
  let called = 0;
  const p = createProviders(async (url, options) => {
    called++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const b = JSON.parse(options.body);
    assert.equal(b.model, "gpt-6-luna");
    assert.equal(b.tool_choice, "required");
    assert.equal(b.store, false);
    assert.equal(b.temperature, undefined);
    return json({
      status: "completed",
      model: b.model,
      output: [
        { type: "message", content: [{ type: "output_text", text: "参考" }] },
      ],
    });
  });
  const result = await p.responses(
    { input: "公式サイトを検索" },
    "fixture-key",
  );
  assert.equal(called, 1);
  assert.equal(result.output_text, "参考");
});
test("APIエラーや未完了を成功にしない・キーをエラーへ出さない", async () => {
  const { createProviders } = await import("../providers.mjs");
  const key = "private-fixture-key";
  const p = createProviders(
    async () =>
      new Response(JSON.stringify({ error: { message: key } }), {
        status: 401,
      }),
  );
  await assert.rejects(
    p.responses({ input: "test" }, key),
    (e) => !e.message.includes(key) && e.message.includes("認証"),
  );
  const incomplete = createProviders(async () =>
    json({ status: "incomplete", output: [] }),
  );
  await assert.rejects(incomplete.responses({ input: "test" }, key), /完了/);
});
