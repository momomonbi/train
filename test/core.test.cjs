const test = require("node:test"),
  assert = require("node:assert/strict"),
  C = require("../train-core.js");
const { params, providerRoute, timetable } = require("./fixtures.cjs");
test("日本時間の午前・日付またぎ・不正日付", () => {
  assert.deepEqual(C.tokyoParts(new Date("2026-10-07T23:00:00Z")), {
    date: "2026-10-08",
    time: "08:00",
    seconds: "00",
  });
  assert.equal(C.shift("2026-10-09", "23:58", 5).date, "2026-10-10");
  assert.equal(C.shift("2026-10-09", "00:02", -5).date, "2026-10-08");
  assert.ok(Number.isNaN(C.epoch("2026-02-30", "09:00")));
  assert.equal(C.normalizeDateTime("2026-02-30T09:00:00+09:00"), null);
  assert.equal(C.normalizeDateTime("2026-10-09T24:00:00+09:00"), null);
});
test("無料検索は日時・到着／始発／終電・経由・除外を保持", () => {
  for (const [type, value] of Object.entries({
    departure: "1",
    arrival: "4",
    first: "3",
    last: "2",
  })) {
    const u = new URL(
      C.yahooUrl({
        ...params,
        timeType: type,
        via: "春日部",
        excluded: ["bus", "shinkansen"],
      }),
    );
    assert.equal(u.searchParams.get("type"), value);
    assert.equal(u.searchParams.get("via"), "春日部");
    assert.equal(u.searchParams.get("d"), "09");
    assert.equal(u.searchParams.get("hh"), "09");
    assert.equal(u.searchParams.get("shin"), "0");
    assert.equal(u.searchParams.get("lb"), "0");
  }
  assert.throws(() => C.yahooUrl({ ...params, via: "春日部、北千住" }), /1駅/);
  // Confirmed against Yahoo's rendered result links: 安=s=1, 楽=s=2.
  assert.equal(
    new URL(C.yahooUrl({ ...params, priority: "cheap" })).searchParams.get("s"),
    "1",
  );
  assert.equal(
    new URL(
      C.yahooUrl({ ...params, priority: "less_transfer" }),
    ).searchParams.get("s"),
    "2",
  );
});
test("不明金額をゼロにしない・課金単位を捏造しない", () => {
  assert.equal(C.money("要確認"), null);
  assert.equal(C.money(""), null);
  assert.equal(C.money("1,200円"), 1200);
  assert.equal(C.money("0"), 0);
  const r = C.normalizeEkispert(
    providerRoute({ fare: null, charge: null }),
    params,
  ).routes[0];
  assert.equal(r.fareAmount, null);
  assert.equal(r.chargeAmount, null);
  assert.equal(r.fare, "要確認");
});
test("ダイヤの単一区間応答と選択IC運賃を正規化", () => {
  const r = C.normalizeEkispert(providerRoute(), params).routes[0];
  assert.equal(r.fareAmount, 377);
  assert.equal(r.icFare, "377円");
  assert.equal(r.transfers, 0);
  assert.equal(r.duration, "36分");
  assert.equal(r.segments[0].fromPlatform, "1番線");
  assert.equal(r.source.onTimetable, true);
});
test("ダイヤ外・平均時刻・目的地部分一致・経由欠落は不採用", () => {
  const data = providerRoute();
  data.ResultSet.Course.dataType = "plain";
  assert.equal(C.normalizeEkispert(data, params).routes.length, 0);
  assert.equal(
    C.normalizeEkispert(providerRoute({ reliability: "outside" }), params)
      .routes.length,
    0,
  );
  assert.equal(
    C.normalizeEkispert(providerRoute({ reliability: "average" }), params)
      .routes.length,
    0,
  );
  assert.equal(
    C.normalizeEkispert(providerRoute({ to: "新大阪" }), {
      ...params,
      to: "大阪",
    }).routes.length,
    0,
  );
  assert.equal(
    C.normalizeEkispert(providerRoute(), { ...params, viaIds: ["3"] }).routes
      .length,
    0,
  );
});
test("指定した出発・到着条件を満たさない応答は不採用", () => {
  assert.equal(
    C.normalizeEkispert(providerRoute(), { ...params, time: "09:10" }).routes
      .length,
    0,
  );
  assert.equal(
    C.normalizeEkispert(providerRoute(), {
      ...params,
      timeType: "arrival",
      time: "09:40",
    }).routes.length,
    0,
  );
  assert.equal(
    C.normalizeEkispert(providerRoute(), {
      ...params,
      timeType: "arrival",
      time: "10:00",
    }).routes.length,
    1,
  );
});
test("日付またぎ到着と絶対時刻アラーム", () => {
  const r = C.normalizeEkispert(
    providerRoute({
      departure: "2026-10-09T23:58:00+09:00",
      arrival: "2026-10-10T00:20:00+09:00",
    }),
    params,
  ).routes[0];
  assert.equal(r.duration, "22分");
  assert.equal(
    C.alarmAt(r, 3, Date.parse("2026-10-09T23:55:00+09:00")),
    Date.parse("2026-10-10T00:17:00+09:00"),
  );
  assert.throws(
    () => C.alarmAt(r, 3, Date.parse("2026-10-10T00:18:00+09:00")),
    /過ぎ/,
  );
  assert.throws(() => C.alarmAt({ ...r, source: {} }, 3), /ダイヤ/);
});
test("区間の待ち時間から乗換回数を増やさない", () => {
  const d = providerRoute();
  const route = d.ResultSet.Course.Route;
  route.Point.splice(1, 0, { Station: { code: "3", Name: "春日部" } });
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
  const r = C.normalizeEkispert(d, { ...params, viaIds: ["3"] }).routes[0];
  assert.equal(r.transfers, 0);
  assert.equal(r.segments[1].minutes, 2);
  route.Line[1].DepartureState.Datetime.text = "2026-10-09T09:19:00+09:00";
  assert.equal(C.normalizeEkispert(d, params).routes.length, 0);
});
test("ODPT多言語・期限不明は平常と推測しない", () => {
  const i = C.trainInfo({
    "odpt:trainInformationText": { ja: "遅延しています。" },
    "odpt:railway": "test",
  });
  assert.equal(i.body, "遅延しています。");
  assert.equal(i.status, "");
  assert.equal(i.stale, true);
});
test("選択日の祝日・方向・指定時刻で時刻表を絞る", () => {
  assert.equal(
    C.timetableCalendar("2026-10-12", ["2026-10-12"], [2026]),
    "holiday",
  );
  assert.equal(C.timetableCalendar("2026-10-10", [], [2026]), "saturday");
  assert.equal(C.timetableCalendar("2028-10-12", [], [2026]), null);
  const tables = [
    timetable(),
    timetable("Weekday", "B"),
    timetable("SundayHoliday"),
  ];
  const matched = C.filterTimetables(
    tables,
    "weekday",
    "odpt.Railway:Toei.Asakusa|A",
    "09:00",
  );
  assert.equal(matched.length, 1);
  assert.deepEqual(
    matched[0]["odpt:stationTimetableObject"].map(
      (o) => o["odpt:departureTime"],
    ),
    ["09:30", "24:10"],
  );
  assert.equal(C.filterTimetables(tables, "weekday", "", "09:00").length, 0);
});
test("Responsesの本文と安全な引用だけを取り出す", () => {
  const d = {
    output: [
      { type: "web_search_call" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "参考情報",
            annotations: [
              { type: "url_citation", url: "javascript:alert(1)" },
              {
                type: "url_citation",
                url: "https://example.com/",
                title: "公式",
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(C.responseText(d), "参考情報");
  assert.equal(C.citations(d).length, 1);
  assert.equal(C.safeUrl("data:text/html,test"), null);
  assert.equal(C.safeUrl("https://key@example.com"), null);
});
test("キャッシュキーに全条件を含める", () => {
  assert.notEqual(
    C.cacheKey(params),
    C.cacheKey({ ...params, timeType: "arrival" }),
  );
  assert.notEqual(C.cacheKey(params), C.cacheKey({ ...params, via: "春日部" }));
  assert.notEqual(
    C.cacheKey(params),
    C.cacheKey({ ...params, excluded: ["bus"] }),
  );
});
