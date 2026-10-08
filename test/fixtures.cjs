const params = {
  from: "川間",
  to: "大宮",
  date: "2026-10-09",
  time: "09:00",
  timeType: "departure",
  priority: "recommended",
  via: "",
  walkSpeed: "normal",
  excluded: [],
  specialTicket: "none",
  provider: "ekispert",
};
function providerRoute({
  from = "川間",
  to = "大宮",
  fromId = "1",
  toId = "2",
  departure = "2026-10-09T09:09:00+09:00",
  arrival = "2026-10-09T09:45:00+09:00",
  fare = "377",
  charge = "0",
  reliability = "onTimetable",
} = {}) {
  const prices = [
    ...(fare == null
      ? []
      : [
          { kind: "FareSummary", Oneway: fare },
          { kind: "Fare", selected: "true", Type: "FareICCard", Oneway: fare },
        ]),
    ...(charge == null ? [] : [{ kind: "ChargeSummary", Oneway: charge }]),
  ];
  const line = {
    Type: "train",
    Name: "東武アーバンパークライン",
    TimeReliability: reliability,
    DepartureState: {
      no: "1",
      Datetime: { text: departure, operation: "today" },
    },
    ArrivalState: { Datetime: { text: arrival, operation: "today" } },
  };
  const route = {
    transferCount: "0",
    Point: [
      { Station: { code: fromId, Name: from } },
      { Station: { code: toId, Name: to } },
    ],
    Line: line,
  };
  return {
    ResultSet: {
      engineVersion: "fixture",
      Course: { dataType: "onTimetable", Price: prices, Route: route },
    },
  };
}
function timetable(
  calendar = "Weekday",
  direction = "A",
  times = ["08:00", "09:30", "24:10"],
) {
  return {
    "odpt:railway": "odpt.Railway:Toei.Asakusa",
    "odpt:railDirection": direction,
    "odpt:calendar": "odpt.Calendar:" + calendar,
    "odpt:stationTimetableObject": times.map((t) => ({
      "odpt:departureTime": t,
      "odpt:destinationStation": ["odpt.Station:Toei.Asakusa.NishiMagome"],
    })),
  };
}
module.exports = { params, providerRoute, timetable };
