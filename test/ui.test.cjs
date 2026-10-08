const test = require("node:test"),
  assert = require("node:assert/strict");
const { runtime } = require("./ui-harness.cjs"),
  C = require("../train-core.js"),
  { params, providerRoute, timetable } = require("./fixtures.cjs");
function fill(r, values = params) {
  for (const [key, id] of Object.entries({
    from: "fromStation",
    to: "toStation",
    date: "date",
    time: "time",
    timeType: "timeType",
    walkSpeed: "walkSpeed",
    provider: "routeProvider",
  }))
    r.nodes.get(id).value = values[key];
}
test("検索は指定日時を変えず、無料検索にOpenAIキーを要求しない", async () => {
  const r = runtime();
  fill(r, { ...params, provider: "yahoo", timeType: "arrival" });
  await r.run("searchRoute()");
  assert.equal(r.nodes.get("date").value, "2026-10-09");
  assert.equal(r.nodes.get("time").value, "09:00");
  assert.match(r.nodes.get("results").innerHTML, /type=4/);
  assert.equal(r.nodes.get("searchBtn").disabled, false);
  assert.equal(r.nodes.get("alarmBtn").hidden, true);
});
test("ODPTの成功・例外で取得中状態を必ず解除", async () => {
  for (const failing of [false, true]) {
    const r = runtime();
    r.run(
      "fetchOdpt=async()=>" +
        (failing
          ? ' {throw new Error("fixture error")}'
          : JSON.stringify([timetable()])),
    );
    fill(r);
    r.run('setMode("timetable")');
    await r.run("searchTimetable()");
    assert.equal(r.nodes.get("searchBtn").disabled, false);
    assert.equal(r.nodes.get("cancelSearch").hidden, true);
    if (failing)
      assert.match(r.nodes.get("results").innerHTML, /fixture error/);
    else assert.match(r.nodes.get("results").innerHTML, /川間/);
  }
});
test("モード変更後に遅い応答が画面を上書きしない", async () => {
  const r = runtime();
  let resolve;
  r.run('setMode("timetable")');
  fill(r);
  r.run("fetchOdpt=()=>new Promise(done=>{globalResolver=done})");
  const searching = r.run("searchTimetable()");
  r.run('setMode("route")');
  r.run("globalResolver(" + JSON.stringify([timetable()]) + ")");
  await searching;
  assert.equal(r.nodes.get("results").innerHTML, "");
  assert.equal(r.nodes.get("searchBtn").textContent, "経路を検索");
  assert.equal(r.nodes.get("searchBtn").disabled, false);
});
test("中止後の応答・旧検索のfinallyが新検索を壊さない", async () => {
  const r = runtime();
  fill(r);
  r.run(
    'fetchOdpt=()=>new Promise(done=>{resolvers.push(done)});var resolvers=[];setMode("timetable")',
  );
  const first = r.run("searchTimetable()");
  r.run("cancelSearch()");
  const second = r.run("searchTimetable()");
  r.run("resolvers[0](" + JSON.stringify([timetable()]) + ")");
  await first;
  assert.equal(r.nodes.get("searchBtn").disabled, true);
  r.run("resolvers[1](" + JSON.stringify([timetable()]) + ")");
  await second;
  assert.equal(r.nodes.get("searchBtn").disabled, false);
});
test("タイムアウト時に成功結果を表示しない", async () => {
  const r = runtime();
  fill(r);
  r.run(
    'setMode("timetable");fetchOdpt=()=>new Promise(done=>{globalResolver=done})',
  );
  const search = r.run("searchTimetable()");
  const timer = [...r.pendingTimers.values()][0];
  timer();
  r.run("globalResolver(" + JSON.stringify([timetable()]) + ")");
  await search;
  assert.doesNotMatch(r.nodes.get("results").innerHTML, /ttDirection/);
  assert.equal(r.nodes.get("searchBtn").disabled, false);
});
test("選択経路の表示・コピー・キャッシュが同じデータを使う", () => {
  const r = runtime();
  const first = C.normalizeEkispert(providerRoute(), params).routes[0],
    second = C.normalizeEkispert(
      providerRoute({ arrival: "2026-10-09T09:55:00+09:00", fare: "450" }),
      params,
    ).routes[0];
  r.run(
    "lastSearchParams=" +
      JSON.stringify(params) +
      ";routeData=" +
      JSON.stringify({
        routes: [first, second],
        retrievedAt: new Date().toISOString(),
      }) +
      ";selectedRouteIndex=1;renderRoutes();saveCache()",
  );
  assert.match(r.run("lastResultText"), /09:55/);
  assert.match(r.run("lastResultText"), /450円/);
  const cache = JSON.parse(r.memory.get("route_cache_v2"));
  assert.equal(cache.selected, 1);
  assert.equal(cache.data.routes[1].fareAmount, 450);
  const restored = runtime({
    storage: { route_cache_v2: r.memory.get("route_cache_v2") },
  });
  assert.equal(restored.nodes.get("date").value, params.date);
  assert.match(restored.run("lastResultText"), /09:55/);
  assert.match(restored.nodes.get("verifyBadge").textContent, /保存された/);
});
test("破損した保存データでも画面が初期化できる", () => {
  const r = runtime({
    storage: {
      route_history: "invalid",
      route_favs: "{}",
      expenses: "invalid",
      route_cache_v2: "invalid",
    },
  });
  assert.equal(r.nodes.get("searchBtn").disabled, false);
  assert.equal(r.nodes.get("expenseBar").hidden, true);
});
test("APIキーを画面・保存データ・コピーに再利用しない", async () => {
  const secret = "fixture-secret",
    r = runtime({ storage: { openai_api_key: secret } });
  await r.flush();
  assert.equal(r.nodes.get("apiKey").value, "");
  r.nodes.get("apiKey").value = secret;
  await r.run("saveSettings()");
  assert.equal(r.nodes.get("apiKey").value, "");
  assert.equal(r.memory.has("openai_api_key"), false);
  assert.ok(!r.nodes.get("settingsStatus").textContent.includes(secret));
  assert.ok(!r.run("lastResultText").includes(secret));
});
