// Small deterministic mutation checks for the regressions fixed in this repair.
const fs = require("node:fs"),
  vm = require("node:vm"),
  assert = require("node:assert/strict");
const { params, providerRoute } = require("./fixtures.cjs");
const original = fs.readFileSync(require.resolve("../train-core.js"), "utf8");
function load(source) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, URL, URLSearchParams, Intl, Date });
  return module.exports;
}
const cases = [
  [
    "日本時間をUTCに戻す",
    'timeZone: "Asia/Tokyo"',
    'timeZone: "UTC"',
    (c) =>
      assert.equal(
        c.tokyoParts(new Date("2026-10-07T23:00:00Z")).date,
        "2026-10-08",
      ),
  ],
  [
    "不明金額を0円にする",
    ": null;\n  }\n  function safeUrl",
    ": 0;\n  }\n  function safeUrl",
    (c) => assert.equal(c.money("要確認"), null),
  ],
  [
    "到着指定を出発指定にする",
    'arrival: "4"',
    'arrival: "1"',
    (c) =>
      assert.equal(
        new URL(
          c.yahooUrl({ ...params, timeType: "arrival" }),
        ).searchParams.get("type"),
        "4",
      ),
  ],
  [
    "平均時刻をダイヤとして採用する",
    'if (!walking && text(line.TimeReliability) !== "onTimetable")',
    "if (false)",
    (c) =>
      assert.equal(
        c.normalizeEkispert(providerRoute({ reliability: "average" }), params)
          .routes.length,
        0,
      ),
  ],
  [
    "キャッシュの条件を捨てる",
    /function cacheKey\(p\) \{[\s\S]*?\n  \}/,
    "function cacheKey(p){return JSON.stringify([p.from,p.to]);}",
    (c) =>
      assert.notEqual(
        c.cacheKey(params),
        c.cacheKey({ ...params, timeType: "arrival" }),
      ),
  ],
  [
    "到着時刻に代えて今から3分で鳴らす",
    "const t = Date.parse(value) - minutes * 60000",
    "const t=now+minutes*60000",
    (c) => {
      const r = c.normalizeEkispert(providerRoute(), params).routes[0];
      assert.equal(
        c.alarmAt(r, 3, Date.parse("2026-10-09T09:00:00+09:00")),
        Date.parse("2026-10-09T09:42:00+09:00"),
      );
    },
  ],
];
const baseline = load(original);
cases.forEach((c) => c[3](baseline));
let detected = 0;
for (const [name, oldCode, newCode, check] of cases) {
  assert.ok(
    typeof oldCode === "string"
      ? original.includes(oldCode)
      : oldCode.test(original),
    "mutation target missing: " + name,
  );
  const mutant = load(original.replace(oldCode, newCode));
  let failed = false;
  try {
    check(mutant);
  } catch (error) {
    if (error instanceof assert.AssertionError) failed = true;
    else throw error;
  }
  assert.ok(failed, "mutation escaped: " + name);
  detected++;
  console.log("検出: " + name);
}
console.log(
  `変異試験 ${detected}/${cases.length} 検出（元コードは全条件に合格）`,
);
