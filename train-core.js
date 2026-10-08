(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TrainCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const text = (v) =>
    typeof v === "string"
      ? v
      : typeof v?.text === "string"
        ? v.text
        : typeof v?.ja === "string"
          ? v.ja
          : "";
  const stationName = (v) =>
    text(v).normalize("NFKC").trim().replace(/駅$/, "");
  function tokyoParts(value = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(value)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`,
      seconds: parts.second,
    };
  }
  function epoch(date, time) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !/^([0-3]\d|4[0-7]):[0-5]\d$/.test(time || "")
    )
      return NaN;
    const day = Date.parse(date + "T00:00:00+09:00");
    if (!Number.isFinite(day) || tokyoParts(new Date(day)).date !== date)
      return NaN;
    const [h, m] = time.split(":").map(Number);
    return day + (h * 60 + m) * 60000;
  }
  function shift(date, time, minutes) {
    const t = epoch(date, time);
    if (!Number.isFinite(t) || !Number.isFinite(minutes))
      throw new Error("日付・時刻を確認してください。");
    return tokyoParts(new Date(t + minutes * 60000));
  }
  function money(v) {
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
    const m = text(v).match(
      /^\s*(?:¥|￥)?([0-9]+(?:,[0-9]{3})*)\s*(?:円)?\s*$/,
    );
    return m ? Number(m[1].replaceAll(",", "")) : null;
  }
  function safeUrl(v) {
    try {
      const u = new URL(v);
      return ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password
        ? u.href
        : null;
    } catch {
      return null;
    }
  }
  function validateParams(p) {
    if (!p || !text(p.from).trim() || !text(p.to).trim())
      throw new Error("出発駅と到着駅を入力してください。");
    if (
      [p.from, p.to, p.via || ""].some(
        (s) =>
          typeof s !== "string" || s.length > 100 || /[\u0000-\u001f]/.test(s),
      )
    )
      throw new Error("駅名を確認してください。");
    if (
      !Number.isFinite(epoch(p.date, p.time)) ||
      Number(p.time.slice(0, 2)) > 23
    )
      throw new Error("日付・時刻を確認してください。");
    if (!["departure", "arrival", "first", "last"].includes(p.timeType))
      throw new Error("出発・到着などの条件を確認してください。");
    if (
      !["recommended", "fast", "cheap", "less_transfer"].includes(p.priority) ||
      !["slow", "slightly_slow", "normal", "slightly_fast", "fast"].includes(
        p.walkSpeed,
      )
    )
      throw new Error("優先条件・歩く速さを確認してください。");
    if ((p.via || "").split(/[,、，]+/).filter((s) => s.trim()).length > 3)
      throw new Error("経由駅は3駅まで指定できます。");
    return p;
  }
  function yahooUrl(input) {
    const p = validateParams(input),
      [y, m, d] = p.date.split("-"),
      [hh, mm] = p.time.split(":");
    if ((p.via || "").split(/[,、，]+/).filter((s) => s.trim()).length > 1)
      throw new Error(
        "無料の検索リンクでは経由駅を1駅にしてください。複数経由の反映は確認できていません。",
      );
    const q = new URLSearchParams({
      from: p.from,
      to: p.to,
      y,
      m,
      d,
      hh,
      m1: mm[0],
      m2: mm[1],
      type: { departure: "1", arrival: "4", first: "3", last: "2" }[p.timeType],
      ticket: "ic",
      expkind: "1",
      s:
        { recommended: "0", fast: "0", cheap: "1", less_transfer: "2" }[
          p.priority
        ] || "0",
      ws:
        {
          slow: "4",
          slightly_slow: "3",
          normal: "3",
          slightly_fast: "2",
          fast: "1",
        }[p.walkSpeed] || "3",
    });
    const excluded = p.excluded || [];
    for (const [key, value] of Object.entries({
      airplane: "al",
      shinkansen: "shin",
      express: "ex",
      highwaybus: "hb",
      bus: "lb",
      ferry: "sr",
    }))
      q.set(value, excluded.includes(key) ? "0" : "1");
    (p.via || "")
      .split(/[,、，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((v, i) =>
        q.set(i ? "via" + String(i + 1).padStart(2, "0") : "via", v),
      );
    return "https://transit.yahoo.co.jp/search/result?" + q;
  }
  function cacheKey(p) {
    return JSON.stringify(
      Object.keys(p || {})
        .sort()
        .map((k) => [k, p[k]]),
    );
  }
  function parseJson(body) {
    try {
      const clean = text(body)
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      return JSON.parse(clean);
    } catch {
      return null;
    }
  }
  function responseText(data) {
    return asArray(data?.output)
      .filter((x) => x.type === "message")
      .flatMap((x) => asArray(x.content))
      .filter((x) => x.type === "output_text")
      .map((x) => text(x.text))
      .join("\n");
  }
  function citations(data) {
    return asArray(data?.output)
      .filter((x) => x.type === "message")
      .flatMap((x) => asArray(x.content))
      .flatMap((x) => asArray(x.annotations))
      .filter((x) => x.type === "url_citation" && safeUrl(x.url))
      .map((x) => ({ url: safeUrl(x.url), title: text(x.title) || x.url }));
  }
  function normalizeDateTime(v) {
    const s = text(v);
    return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      s,
    ) &&
      Number.isFinite(Date.parse(s)) &&
      Number.isFinite(epoch(s.slice(0, 10), "00:00"))
      ? s
      : null;
  }
  function alarmAt(route, minutes, now = Date.now()) {
    if (!route || !route.source?.onTimetable)
      throw new Error("ダイヤに基づく経路を選択してください。");
    const value = normalizeDateTime(route.arrivalDateTime);
    if (!value) throw new Error("到着日時を確認できません。");
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120)
      throw new Error("0〜120分で指定してください。");
    const t = Date.parse(value) - minutes * 60000;
    if (t <= now) throw new Error("アラーム時刻が過ぎています。");
    return t;
  }
  function checkEndpoints(route, p) {
    const rides = asArray(route.segments).filter(
      (s) => s.type === "ride" || s.type === "walk",
    );
    const first = rides[0],
      last = rides.at(-1);
    return Boolean(
      first &&
      last &&
      (p.fromId
        ? String(first.fromId) === String(p.fromId)
        : stationName(first.from) === stationName(p.from)) &&
      (p.toId
        ? String(last.toId) === String(p.toId)
        : stationName(last.to) === stationName(p.to)),
    );
  }
  function selectedPrice(prices, kind) {
    const item = asArray(prices).find((p) => p.kind === kind);
    return item ? money(item.Oneway) : null;
  }
  function normalizeEkispert(data, params) {
    const routes = [];
    for (const course of asArray(data?.ResultSet?.Course)) {
      if (course.dataType !== "onTimetable") continue;
      const lines = asArray(course.Route?.Line),
        points = asArray(course.Route?.Point);
      if (!lines.length || points.length !== lines.length + 1) continue;
      const segments = [];
      let malformed = false;
      lines.forEach((line, i) => {
        const from = points[i].Station || points[i],
          to = points[i + 1].Station || points[i + 1];
        const departureDateTime = normalizeDateTime(
            line.DepartureState?.Datetime,
          ),
          arrivalDateTime = normalizeDateTime(line.ArrivalState?.Datetime);
        const walking =
          text(line.Type) === "walk" || text(line.Name) === "徒歩";
        if (!walking && text(line.TimeReliability) !== "onTimetable") {
          malformed = true;
          return;
        }
        if (
          !departureDateTime ||
          !arrivalDateTime ||
          Date.parse(arrivalDateTime) < Date.parse(departureDateTime) ||
          !text(from.Name) ||
          !text(to.Name)
        ) {
          malformed = true;
          return;
        }
        const previous = segments.at(-1);
        if (previous) {
          const gap =
            (Date.parse(departureDateTime) -
              Date.parse(previous.arrivalDateTime)) /
            60000;
          if (gap < 0) {
            malformed = true;
            return;
          }
          if (gap > 0)
            segments.push({
              type: "transfer",
              station: text(from.Name),
              minutes: gap,
            });
        }
        // A gap can be a through-train stop. It is displayed as waiting time, never counted as a transfer.
        segments.push({
          type: walking ? "walk" : "ride",
          from: text(from.Name),
          to: text(to.Name),
          fromId: String(from.code || ""),
          toId: String(to.code || ""),
          line: text(line.Name),
          lineCode: text(asArray(line.LineSymbol)[0]?.Name),
          direction: text(line.Destination),
          departureDateTime,
          arrivalDateTime,
          departureTime: tokyoParts(new Date(departureDateTime)).time,
          arrivalTime: tokyoParts(new Date(arrivalDateTime)).time,
          fromPlatform: line.DepartureState?.no
            ? String(line.DepartureState.no) + "番線"
            : "",
          toPlatform: line.ArrivalState?.no
            ? String(line.ArrivalState.no) + "番線"
            : "",
          stops: [],
          delay: null,
        });
      });
      if (malformed || !segments.length) continue;
      const start = segments[0],
        end = segments.at(-1),
        minutes =
          (Date.parse(end.arrivalDateTime) -
            Date.parse(start.departureDateTime)) /
          60000;
      const fare = selectedPrice(course.Price, "FareSummary"),
        charge = selectedPrice(course.Price, "ChargeSummary");
      const count = course.Route.transferCount,
        transfers =
          count !== null &&
          count !== undefined &&
          String(count).trim() !== "" &&
          Number.isInteger(Number(count)) &&
          Number(count) >= 0
            ? Number(count)
            : null;
      const r = {
        departure: start.departureTime,
        arrival: end.arrivalTime,
        departureDateTime: start.departureDateTime,
        arrivalDateTime: end.arrivalDateTime,
        duration:
          minutes >= 60
            ? `${Math.floor(minutes / 60)}時間${minutes % 60}分`
            : `${minutes}分`,
        transfers,
        fare: fare == null ? "要確認" : `${fare}円`,
        icFare: null,
        expressFare: charge == null ? null : `${charge}円`,
        fareAmount: fare,
        chargeAmount: charge,
        segments,
        notes: [],
        source: {
          provider: "駅すぱあとAPI",
          onTimetable: true,
          estimatedWalk: segments.some((s) => s.type === "walk"),
          engineVersion: data.ResultSet.engineVersion,
        },
        serializeData: text(course.SerializeData),
      };
      // FareSummary reflects provider-selected fare. It is not necessarily an IC fare.
      const fareItems = asArray(course.Price).filter(
        (x) => x.kind === "Fare" && String(x.selected) === "true",
      );
      if (
        fareItems.length &&
        fareItems.every((x) => text(x.Type) === "FareICCard")
      )
        r.icFare = r.fare;
      const pointIds = points.map((p) => String(p.Station?.code || ""));
      let index = 0;
      let viaMatches = true;
      for (const id of params.viaIds || []) {
        index = pointIds.indexOf(String(id), index);
        if (index < 0) {
          viaMatches = false;
          break;
        }
        index++;
      }
      const requested = epoch(params.date, params.time),
        timeMatches =
          params.timeType === "departure"
            ? Date.parse(r.departureDateTime) >= requested
            : params.timeType === "arrival"
              ? Date.parse(r.arrivalDateTime) <= requested
              : true;
      if (checkEndpoints(r, params) && viaMatches && timeMatches)
        routes.push(r);
    }
    return {
      routes,
      serviceInfo: "運行状況は別途確認してください。",
      provider: "駅すぱあとAPI",
      retrievedAt: new Date().toISOString(),
    };
  }
  function trainInfo(item, now = Date.now()) {
    const body = text(item["odpt:trainInformationText"]),
      status = text(item["odpt:trainInformationStatus"]);
    const expiry = Date.parse(item["dct:valid"]),
      issued = Date.parse(item["dc:date"]);
    return {
      body,
      status,
      railway: text(item["odpt:railway"]),
      issued: text(item["dc:date"]),
      expiry: text(item["dct:valid"]),
      stale:
        !Number.isFinite(expiry) || expiry < now || !Number.isFinite(issued),
    };
  }
  function timetableCalendar(date, holidayDates, coveredYears) {
    const day = epoch(date, "12:00");
    if (
      !Number.isFinite(day) ||
      !coveredYears.includes(Number(date.slice(0, 4)))
    )
      return null;
    const weekday = new Date(day + 9 * 3600000).getUTCDay();
    return holidayDates.includes(date) || weekday === 0
      ? "holiday"
      : weekday === 6
        ? "saturday"
        : "weekday";
  }
  function filterTimetables(data, calendar, direction, time) {
    if (!calendar || !direction) return [];
    const accepted = {
      weekday: ["Weekday"],
      saturday: ["Saturday", "SaturdayHoliday"],
      holiday: ["SundayHoliday", "Sunday", "Holiday", "SaturdayHoliday"],
    }[calendar] || [calendar];
    const matched = asArray(data).filter(
      (x) =>
        accepted.includes(text(x["odpt:calendar"]).split(/[.:]/).at(-1)) &&
        `${x["odpt:railway"]}|${x["odpt:railDirection"]}` === direction,
    );
    const exact = matched.filter(
      (x) => text(x["odpt:calendar"]).split(/[.:]/).at(-1) === accepted[0],
    );
    return (exact.length ? exact : matched)
      .map((tt) => ({
        ...tt,
        "odpt:stationTimetableObject": asArray(
          tt["odpt:stationTimetableObject"],
        )
          .filter((o) => {
            const t = text(o["odpt:departureTime"]);
            return (
              /^([0-3]\d|4[0-7]):[0-5]\d$/.test(t) &&
              Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) >=
                Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
            );
          })
          .sort((a, b) =>
            text(a["odpt:departureTime"]).localeCompare(
              text(b["odpt:departureTime"]),
            ),
          )
          .slice(0, 20),
      }))
      .filter((tt) => tt["odpt:stationTimetableObject"].length);
  }
  return {
    asArray,
    text,
    stationName,
    tokyoParts,
    epoch,
    shift,
    money,
    safeUrl,
    validateParams,
    yahooUrl,
    cacheKey,
    parseJson,
    responseText,
    citations,
    normalizeDateTime,
    alarmAt,
    checkEndpoints,
    normalizeEkispert,
    trainInfo,
    timetableCalendar,
    filterTimetables,
  };
});
