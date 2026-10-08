"use strict";
const C = TrainCore;
const $ = (id) => document.getElementById(id);
let currentMode = "route",
  lastSearchParams = null,
  lastResultText = "",
  routeData = null,
  selectedRouteIndex = 0;
let activeSearch = null,
  searchSerial = 0,
  alarmTimer = null,
  alarmDeadline = null,
  gateway = null,
  timetableState = null;
const labels = {
  route: "経路を検索",
  timetable: "時刻表を検索",
  commuter: "定期券の検索先を表示",
  status: "運行情報を取得",
};
function showToolbar(routeLike, alarm = false, commuter = false) {
  $("toolbar").hidden = false;
  for (const id of ["walkBtn", "favBtn", "expenseBtn"])
    $(id).hidden = !routeLike;
  $("shiftBack").hidden = !routeLike || commuter;
  $("shiftForward").hidden = !routeLike || commuter;
  $("alarmBtn").hidden = !alarm;
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ],
  );
function readStore(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function stringList(key) {
  const value = readStore(key, []);
  return Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
}
function removeStore(key) {
  try {
    localStorage.removeItem(key);
  } catch {}
}
function updateNow() {
  const now = C.tokyoParts();
  $("date").value = now.date;
  $("time").value = now.time;
}
function showError(message) {
  $("results").innerHTML = `<div class="error-msg">${esc(message)}</div>`;
}
function banner(message) {
  $("infoBanner").textContent = message;
  $("infoBanner").classList.toggle("show", Boolean(message));
}
function toggleSettings() {
  const open = $("settingsPanel").classList.toggle("open");
  $("settingsToggle").setAttribute("aria-expanded", String(open));
}
function settingsSummary() {
  return gateway
    ? `設定済み：乗換API ${gateway.ekispertEnabled ? "あり" : "なし"} / ODPT ${gateway.odptEnabled ? "あり" : "なし"} / OpenAI ${gateway.openaiEnabled ? "あり" : "なし"}`
    : "キーを使う場合は start.ps1 でローカルサーバーを起動してください。";
}
async function loadConfig() {
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    if (typeof d.csrf === "string") gateway = d;
  } catch {}
  $("settingsStatus").textContent = settingsSummary();
  updateProviderHint();
}
const configReady = loadConfig();
async function post(path, body, signal) {
  await configReady;
  if (!gateway)
    throw new Error("start.ps1 でローカルサーバーを起動してください。");
  const r = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Train-Token": gateway.csrf,
    },
    body: JSON.stringify(body),
    signal,
  });
  const d = await r.json();
  if (!r.ok) {
    const error = new Error(d.error || "取得できませんでした。");
    error.details = d;
    throw error;
  }
  return d;
}
async function saveSettings() {
  const fields = { openai: "apiKey", odpt: "odptKey", ekispert: "ekispertKey" },
    input = {};
  for (const [key, id] of Object.entries(fields))
    if ($(id).value.trim()) input[key] = $(id).value.trim();
  if (!Object.keys(input).length) {
    $("settingsStatus").textContent = "使うキーを入力してください。";
    return;
  }
  try {
    gateway = await post("/api/settings", input);
    Object.values(fields).forEach((id) => ($(id).value = ""));
    if (input.openai) removeStore("openai_api_key");
    if (input.odpt) removeStore("odpt_api_key");
    $("settingsStatus").textContent =
      settingsSummary() + "（接続テストは別途実行してください）";
    updateProviderHint();
  } catch (e) {
    $("settingsStatus").textContent = e.message;
  }
}
async function clearSettings() {
  try {
    gateway = await post("/api/settings", {
      openai: "",
      odpt: "",
      ekispert: "",
    });
  } catch (e) {
    $("settingsStatus").textContent = e.message;
    return;
  }
  ["apiKey", "odptKey", "ekispertKey"].forEach((id) => ($(id).value = ""));
  ["openai_api_key", "odpt_api_key"].forEach(removeStore);
  $("settingsStatus").textContent =
    "サーバーとブラウザーに残っていたキーを消去しました。";
  updateProviderHint();
}
function updateProviderHint() {
  $("providerHint").textContent =
    $("routeProvider").value === "yahoo"
      ? "入力条件を渡す検索リンクを作ります。結果はYahoo!乗換案内で確認できます。"
      : gateway?.ekispertEnabled
        ? "ダイヤ探索の結果を表示します。実際の遅延は運行情報で確認してください。"
        : "駅すぱあとAPIの契約・キーが必要です。API設定から入力してください。";
}
function setMode(mode) {
  if (!Object.hasOwn(labels, mode)) return;
  cancelSearch(false);
  currentMode = mode;
  routeData = null;
  timetableState = null;
  lastResultText = "";
  lastSearchParams = null;
  $("results").replaceChildren();
  $("toolbar").hidden = true;
  $("verifyBadge").style.display = "none";
  banner("");
  for (const [key, id] of Object.entries({
    route: "modeRoute",
    timetable: "modeTimetable",
    commuter: "modeCommuter",
    status: "modeStatus",
  })) {
    $(id).classList.toggle("active", key === mode);
    $(id).setAttribute("aria-pressed", String(key === mode));
  }
  $("stationRow").hidden = mode === "status";
  $("toCol").hidden = mode === "timetable";
  $("swapBtn").hidden = mode === "timetable";
  $("fromLabel").textContent =
    mode === "timetable" ? "時刻表を調べる駅" : "出発駅";
  $("optionsGrid").hidden = mode === "status";
  $("timeTypeField").hidden = mode === "timetable";
  $("priorityField").hidden = mode === "timetable";
  $("routeOptions").hidden = mode !== "route";
  $("modeHint").textContent = {
    route: "",
    timetable:
      "ODPTが公開する駅・方向・曜日ダイヤが対象です。方向を選んでから表示します。",
    commuter: "検索先で通勤・通学の区分と定期券料金を確認してください。",
    status: "公開ODPTの対象は主に都営交通です。全国の運行状況は網羅しません。",
  }[mode];
  setLoading(false);
}
function setLoading(on) {
  $("searchBtn").disabled = on;
  $("searchBtn").textContent = on ? "取得中…" : labels[currentMode];
  $("cancelSearch").hidden = !on;
  $("results").setAttribute("aria-busy", String(on));
}
function cancelSearch(message = true) {
  searchSerial++;
  activeSearch?.controller.abort();
  activeSearch = null;
  setLoading(false);
  if (message) {
    $("toolbar").hidden = true;
    $("verifyBadge").style.display = "none";
    showError("検索を中止しました。");
  }
}
async function searchJob(work) {
  cancelSearch(false);
  const id = searchSerial,
    controller = new AbortController();
  activeSearch = { id, controller };
  const seconds = Math.max(
    10,
    Math.min(120, Number($("timeoutSec").value) || 120),
  );
  const timer = setTimeout(() => controller.abort("timeout"), seconds * 1000);
  routeData = null;
  lastResultText = "";
  timetableState = null;
  $("toolbar").hidden = true;
  $("verifyBadge").style.display = "none";
  banner("");
  setLoading(true);
  $("results").innerHTML =
    '<div class="result-card loading"><div class="spinner"></div><p>取得中…</p></div>';
  const current = () => id === searchSerial && !controller.signal.aborted;
  try {
    await work(controller.signal, current);
    if (controller.signal.aborted && id === searchSerial)
      showError("時間内に取得できませんでした。条件と接続を確認してください。");
  } catch (e) {
    if (id !== searchSerial) return;
    showError(
      controller.signal.aborted
        ? "時間内に取得できませんでした。条件と接続を確認してください。"
        : e.message,
    );
    if (e.details?.stationChoices)
      renderStationChoices(e.details.stationChoices);
  } finally {
    clearTimeout(timer);
    if (id === searchSerial) {
      activeSearch = null;
      setLoading(false);
    }
  }
}
function toggleTransport(button) {
  button.classList.toggle("off");
  button.setAttribute(
    "aria-pressed",
    String(!button.classList.contains("off")),
  );
}
function readParams() {
  const p = {
    from: $("fromStation").value.trim(),
    to: $("toStation").value.trim(),
    date: $("date").value,
    time: $("time").value,
    timeType: $("timeType").value,
    priority: $("priority").value,
    via: currentMode === "route" ? $("viaStation").value.trim() : "",
    walkSpeed: currentMode === "route" ? $("walkSpeed").value : "normal",
    excluded:
      currentMode === "route"
        ? Array.from(document.querySelectorAll(".transport-chip.off")).map(
            (b) => b.dataset.key,
          )
        : [],
    barrierFree: currentMode === "route" && $("optBarrierFree").checked,
    avoidDelay: currentMode === "route" && $("optAvoidDelay").checked,
    commuterPass: currentMode === "route" && $("optCommuterPass").checked,
    passFrom: $("passFrom").value.trim(),
    passTo: $("passTo").value.trim(),
    trainName: currentMode === "route" ? $("trainName").value.trim() : "",
    specialTicket: currentMode === "route" ? $("specialTicket").value : "none",
    freepassName: $("freepassName").value.trim(),
    provider: currentMode === "route" ? $("routeProvider").value : "yahoo",
  };
  for (const [field, id] of [
    ["from", "fromStation"],
    ["to", "toStation"],
  ])
    if ($(id).dataset.stationId) p[field + "Id"] = $(id).dataset.stationId;
  const viaIds = $("viaStation").dataset.stationIds;
  if (viaIds) p.viaIds = JSON.parse(viaIds);
  return C.validateParams(p);
}
function restoreParams(p) {
  for (const [key, id] of Object.entries({
    from: "fromStation",
    to: "toStation",
    via: "viaStation",
    date: "date",
    time: "time",
    timeType: "timeType",
    priority: "priority",
    walkSpeed: "walkSpeed",
    specialTicket: "specialTicket",
    freepassName: "freepassName",
    passFrom: "passFrom",
    passTo: "passTo",
    trainName: "trainName",
    provider: "routeProvider",
  }))
    if (p[key] != null) $(id).value = p[key];
  for (const [key, id] of Object.entries({
    barrierFree: "optBarrierFree",
    avoidDelay: "optAvoidDelay",
    commuterPass: "optCommuterPass",
  }))
    $(id).checked = Boolean(p[key]);
  document.querySelectorAll(".transport-chip").forEach((b) => {
    const off = p.excluded?.includes(b.dataset.key) || false;
    b.classList.toggle("off", off);
    b.setAttribute("aria-pressed", String(!off));
  });
  $("fromStation").dataset.stationId = p.fromId || "";
  $("toStation").dataset.stationId = p.toId || "";
  $("viaStation").dataset.stationIds = JSON.stringify(p.viaIds || []);
  updateExtraFields();
  updateProviderHint();
}
function updateExtraFields() {
  $("commuterPassSection").hidden = !$("optCommuterPass").checked;
  $("freepassSection").hidden = $("specialTicket").value !== "freepass";
}
function conditionsText(p) {
  return `${p.from} → ${p.to}${p.via ? "（経由：" + p.via + "）" : ""}\n${p.date} ${p.time} ${{ departure: "出発", arrival: "到着", first: "始発", last: "終電" }[p.timeType]} / ${{ recommended: "おすすめ", fast: "早さ優先", cheap: "安さ優先", less_transfer: "乗換少なめ" }[p.priority]}`;
}
function unsupportedNotes(p) {
  return [
    p.barrierFree && "段差の少ない経路",
    p.avoidDelay && "遅延回避",
    p.commuterPass && `定期券区間 ${p.passFrom}〜${p.passTo}`,
    p.trainName && "指定列車 " + p.trainName,
    p.specialTicket !== "none" &&
      "特別なきっぷ " + (p.freepassName || p.specialTicket),
  ].filter(Boolean);
}
function externalResult(p, commuter = false) {
  routeData = null;
  selectedRouteIndex = 0;
  const url = C.yahooUrl(p),
    notes = unsupportedNotes(p);
  const note = commuter
    ? "定期券の料金・通勤／通学の区分は検索先で確認してください。"
    : notes.length
      ? "次の条件はリンクに反映されません。検索先で設定・確認してください：" +
        notes.join("、")
      : "運行情報や改札内の移動は、検索先の掲載内容を確認してください。";
  $("results").innerHTML =
    `<div class="result-card"><h3>${commuter ? "定期券の確認" : "乗換検索の準備ができました"}</h3><p class="result-content">${esc(conditionsText(p))}</p><a class="primary-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Yahoo!乗換案内で検索する ↗</a><p class="sub-text">${esc(note)}</p><p class="sub-text">アプリ内に時刻・運賃を取得していません。</p>${commuter ? '<button class="tool-btn" id="referenceBtn">定期券の選び方をAIで調べる（API課金）</button>' : ""}</div>`;
  lastResultText = conditionsText(p) + "\n" + note + "\n" + url;
  showToolbar(true, false, commuter);
  $("alarmBtn").hidden = true;
  $("shiftBack").hidden = commuter;
  $("shiftForward").hidden = commuter;
  updateFavBtn();
  if (commuter)
    $("referenceBtn").addEventListener("click", () =>
      referenceSearch(
        "定期券の一般的な購入条件と通勤・通学の違い。対象区間 " +
          p.from +
          "〜" +
          p.to +
          "。金額を推測せず、公式サイトを出典として示してください。",
      ),
    );
}
async function searchRoute() {
  let p;
  try {
    p = readParams();
    if (p.provider === "yahoo") C.yahooUrl(p);
  } catch (e) {
    cancelSearch(false);
    $("toolbar").hidden = true;
    $("verifyBadge").style.display = "none";
    showError(e.message);
    return;
  }
  lastSearchParams = p;
  addHistory(p.from, p.to);
  if (p.provider === "yahoo") {
    cancelSearch(false);
    banner("");
    $("verifyBadge").style.display = "none";
    externalResult(p);
    return;
  }
  await searchJob(async (signal, current) => {
    const d = await post("/api/route", p, signal);
    if (!current()) return;
    const effective = d.conditions || p;
    if (!Array.isArray(d.routes) || !d.routes.length)
      throw new Error(
        "指定日時のダイヤ経路を取得できませんでした。検索先で確認してください。",
      );
    if (
      d.routes.some(
        (r) => !r.source?.onTimetable || !C.checkEndpoints(r, effective),
      )
    )
      throw new Error("駅またはダイヤの整合性を確認できませんでした。");
    lastSearchParams = effective;
    restoreParams(effective);
    routeData = d;
    selectedRouteIndex = 0;
    renderRoutes(false);
    saveCache();
  });
}
function renderStationChoices(choice) {
  const panel = document.createElement("div");
  panel.className = "card";
  const title = document.createElement("p");
  title.textContent = "同名駅・候補を確認して選んでください。";
  panel.append(title);
  for (const station of C.asArray(choice.candidates)) {
    const button = document.createElement("button");
    button.className = "tag";
    button.textContent = `${station.name}（${station.prefecture || "地域不明"}）`;
    button.addEventListener("click", () => {
      if (choice.field === "from" || choice.field === "to") {
        const input = $(choice.field === "from" ? "fromStation" : "toStation");
        input.value = station.name;
        input.dataset.stationId = station.code;
      } else if (/^via:[0-2]$/.test(choice.field)) {
        const i = Number(choice.field.split(":")[1]),
          names = $("viaStation")
            .value.split(/[,、，]+/)
            .map((s) => s.trim());
        names[i] = station.name;
        $("viaStation").value = names.join("、");
        const ids = C.asArray(
          C.parseJson($("viaStation").dataset.stationIds) || [],
        );
        ids[i] = station.code;
        $("viaStation").dataset.stationIds = JSON.stringify(ids);
      }
      searchRoute();
    });
    panel.append(button);
  }
  if (!C.asArray(choice.candidates).length) {
    const p = document.createElement("p");
    p.textContent = "候補がありません。正式な駅名を入力してください。";
    panel.append(p);
  }
  $("results").append(panel);
}
function routeSummary(r) {
  const total =
    r.fareAmount == null || r.chargeAmount == null
      ? null
      : r.fareAmount + r.chargeAmount;
  return (
    `${r.departureDateTime} → ${r.arrivalDateTime}\n${r.duration} / 乗換 ${r.transfers == null ? "要確認" : r.transfers + "回"} / 運賃 ${r.fare}${r.expressFare ? " ＋料金 " + r.expressFare : ""}\n${total == null ? "総額は要確認" : "掲載された運賃・料金の計 " + total + "円"}\n` +
    r.segments
      .map((s) =>
        s.type === "transfer"
          ? `${s.station}で待ち時間 ${s.minutes}分`
          : `${s.departureTime} ${s.from} → ${s.arrivalTime} ${s.to} / ${s.line}${s.fromPlatform ? " / " + s.fromPlatform : ""}`,
      )
      .join("\n")
  );
}
function renderRoutes(cached = false) {
  if (!routeData) return;
  const html = routeData.routes
    .map((r, i) => {
      const timeline = r.segments
        .map((s) =>
          s.type === "transfer"
            ? `<div class="tl-transfer-box">${esc(s.station)}で待ち時間 ${esc(s.minutes)}分</div>`
            : `<div class="tl-segment"><div class="tl-dot start"></div><div class="tl-line" style="background:#60a5fa"></div><div class="tl-station"><span class="tl-station-time">${esc(s.departureTime)}</span><span class="tl-station-name">${esc(s.from)}</span><span class="tl-station-platform">${esc(s.fromPlatform)}</span></div><div class="tl-ride"><div class="tl-ride-line">${s.type === "walk" ? "徒歩" : esc(s.line)}</div><p class="tl-ride-detail">${esc(s.direction ? s.direction + "方面" : "")}</p></div><div class="tl-station"><span class="tl-station-time">${esc(s.arrivalTime)}</span><span class="tl-station-name">${esc(s.to)}</span><span class="tl-station-platform">${esc(s.toPlatform)}</span></div></div>`,
        )
        .join("");
      const departure = C.tokyoParts(new Date(r.departureDateTime)),
        arrival = C.tokyoParts(new Date(r.arrivalDateTime));
      return `<article class="route-card ${i === selectedRouteIndex ? "selected-route" : ""}"><div class="route-header"><span class="route-label">経路 ${i + 1}</span><button class="tool-btn ${i === selectedRouteIndex ? "active" : ""}" data-select-route="${i}" aria-pressed="${i === selectedRouteIndex}">${i === selectedRouteIndex ? "選択中" : "この経路を選ぶ"}</button><div class="route-time-big">${esc(departure.time)} → <span class="arr">${esc(arrival.time)}</span></div><div class="route-meta"><span class="route-badge badge-duration">${esc(r.duration)}</span><span class="route-badge badge-transfer">乗換 ${r.transfers == null ? "要確認" : esc(r.transfers) + "回"}</span><span class="route-badge badge-fare">運賃 ${esc(r.fare)}${r.expressFare ? " ＋料金 " + esc(r.expressFare) : ""}</span></div></div><div class="route-timeline">${timeline}</div><div class="route-notes"><p>${esc(departure.date)} ${esc(departure.time)} → ${esc(arrival.date)} ${esc(arrival.time)}（日本時間）</p><p>提供元：${esc(r.source.provider)} / 取得：${esc(C.tokyoParts(new Date(routeData.retrievedAt)).date + " " + C.tokyoParts(new Date(routeData.retrievedAt)).time)}</p><p>運行状況・混雑・停車駅の詳細は未確認です。</p></div></article>`;
    })
    .join("");
  $("results").innerHTML = html;
  $("results")
    .querySelectorAll("[data-select-route]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        selectedRouteIndex = Number(button.dataset.selectRoute);
        renderRoutes(cached);
        saveCache();
      }),
    );
  const chosen = routeData.routes[selectedRouteIndex];
  lastResultText =
    conditionsText(lastSearchParams) +
    "\n" +
    routeSummary(chosen) +
    "\n提供元：" +
    chosen.source.provider +
    "\n取得日時：" +
    routeData.retrievedAt +
    (cached ? "\n保存された検索結果" : "");
  $("verifyBadge").textContent = cached
    ? "保存された検索結果（現在の運行情報は未確認）"
    : "ダイヤデータ取得済み（運行情報は未確認）";
  $("verifyBadge").className =
    "verify-badge " + (cached ? "corrected" : "done");
  $("verifyBadge").style.display = "inline-flex";
  showToolbar(true, true);
  $("alarmBtn").hidden = false;
  $("shiftBack").hidden = false;
  $("shiftForward").hidden = false;
  updateFavBtn();
}
function saveCache() {
  if (!routeData?.routes?.length || !lastSearchParams) return;
  writeStore("route_cache_v2", {
    version: 2,
    params: lastSearchParams,
    key: C.cacheKey(lastSearchParams),
    data: routeData,
    selected: selectedRouteIndex,
  });
}
function loadCache() {
  const saved = readStore("route_cache_v2", null);
  try {
    if (
      saved?.version !== 2 ||
      saved.key !== C.cacheKey(saved.params) ||
      Date.now() - Date.parse(saved.data.retrievedAt) > 3600000 ||
      Date.parse(saved.data.retrievedAt) > Date.now() ||
      !Number.isFinite(Date.parse(saved.data.retrievedAt))
    )
      return;
    C.validateParams(saved.params);
    if (
      !saved.data.routes?.length ||
      saved.data.routes.some(
        (r) =>
          !r.source?.onTimetable ||
          !C.normalizeDateTime(r.departureDateTime) ||
          !C.normalizeDateTime(r.arrivalDateTime) ||
          !C.checkEndpoints(r, saved.params),
      )
    )
      return;
    lastSearchParams = saved.params;
    restoreParams(saved.params);
    routeData = saved.data;
    selectedRouteIndex =
      Number.isInteger(saved.selected) &&
      saved.selected >= 0 &&
      saved.selected < routeData.routes.length
        ? saved.selected
        : 0;
    renderRoutes(true);
  } catch {
    removeStore("route_cache_v2");
  }
}
function searchShift(direction) {
  if (!lastSearchParams || currentMode !== "route") return;
  const p = {
    ...lastSearchParams,
    ...C.shift(lastSearchParams.date, lastSearchParams.time, direction * 5),
  };
  restoreParams(p);
  searchRoute();
}
async function fetchOdpt(type, station, signal) {
  await configReady;
  if (gateway) return post("/api/odpt", { type, station }, signal);
  const call = async (path, params = {}) => {
    const r = await fetch(
      "https://api-public.odpt.org/api/v4/" +
        path +
        "?" +
        new URLSearchParams(params),
      { signal },
    );
    if (!r.ok) throw new Error("ODPTを取得できませんでした。");
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error("ODPTの応答形式を確認できません。");
    return d;
  };
  if (type === "info") return call("odpt:TrainInformation");
  const stations = await call("odpt:Station", { "dc:title": station }),
    data = [];
  for (const s of stations.slice(0, 5))
    if (C.text(s["owl:sameAs"]))
      data.push(
        ...(await call("odpt:StationTimetable", {
          "odpt:station": s["owl:sameAs"],
        })),
      );
  return data;
}
async function searchTimetable() {
  const station = $("fromStation").value.trim(),
    date = $("date").value,
    time = $("time").value;
  if (
    !station ||
    !Number.isFinite(C.epoch(date, time)) ||
    station.length > 100
  ) {
    showError("駅名・利用日・時刻を確認してください。");
    return;
  }
  await searchJob(async (signal, current) => {
    const data = await fetchOdpt("timetable", station, signal);
    if (!current()) return;
    if (!data.length)
      throw new Error(
        "この駅の時刻表は公開ODPTから取得できません。経路タブの検索先で確認してください。",
      );
    timetableState = { data, station, date, time };
    renderTimetable();
  });
}
function shortId(value) {
  const id = C.text(value);
  const railway = {
    "odpt.Railway:Toei.Asakusa": "都営浅草線",
    "odpt.Railway:Toei.Mita": "都営三田線",
    "odpt.Railway:Toei.Shinjuku": "都営新宿線",
    "odpt.Railway:Toei.Oedo": "都営大江戸線",
    "odpt.Railway:Toei.Arakawa": "東京さくらトラム（都電荒川線）",
    "odpt.Railway:Toei.NipporiToneri": "日暮里・舎人ライナー",
  };
  if (railway[id]) return railway[id];
  const names = {
    Aoto: "青砥",
    KeiseiTakasago: "京成高砂",
    InzaiMakinohara: "印西牧の原",
    ImbaNihonIdai: "印旛日本医大",
    NaritaAirportTerminal1: "成田空港",
    NaritaAirportTerminal2and3: "空港第2ビル",
    AccessExpress: "アクセス特急",
    AirportRapidLimitedExpress: "エアポート快特",
    RapidLimitedExpress: "快特",
    Northbound: "北行",
    Southbound: "南行",
    Eastbound: "東行",
    Westbound: "西行",
    InnerLoop: "内回り",
    OuterLoop: "外回り",
    NishiMagome: "西馬込",
    Oshiage: "押上",
    NishiTakashimadaira: "西高島平",
    Meguro: "目黒",
    Shinjuku: "新宿",
    Motoyawata: "本八幡",
    Tochomae: "都庁前",
    Hikarigaoka: "光が丘",
    Asakusa: "浅草",
    Shimbashi: "新橋",
    Sengakuji: "泉岳寺",
    Tokyo: "東京",
    Local: "各駅停車",
    Express: "急行",
    Rapid: "快速",
    LimitedExpress: "特急",
  };
  const last = id.split(/[.:]/).at(-1);
  return (
    names[last] ||
    id
      .split(":")
      .at(-1)
      .replace(/^.*?\./, "")
      .replaceAll(".", " / ")
  );
}
function renderTimetable() {
  const s = timetableState;
  if (!s) return;
  const options = Array.from(
    new Set(
      s.data.map((t) => `${t["odpt:railway"]}|${t["odpt:railDirection"]}`),
    ),
  ).filter((x) => !x.includes("undefined"));
  const auto = C.timetableCalendar(s.date, TRAIN_HOLIDAYS, TRAIN_HOLIDAY_YEARS);
  $("results").innerHTML =
    `<div class="result-card"><h3>${esc(s.station)}駅の時刻表</h3><p class="sub-text">${esc(s.date)} ${esc(s.time)}以降 / 公開された曜日別ダイヤ。運休・臨時変更は未確認です。24時以降の表記はこのダイヤの翌日を示します。</p><label for="ttDirection">路線・方向</label><select id="ttDirection"><option value="">方向を選択してください</option>${options.map((x) => `<option value="${esc(x)}">${esc(x.split("|").map(shortId).join(" → "))}</option>`).join("")}</select><label for="ttCalendar">曜日ダイヤ</label><select id="ttCalendar"><option value="">曜日ダイヤを選択してください</option><option value="weekday">平日</option><option value="saturday">土曜</option><option value="holiday">日曜・祝日</option></select><p class="sub-text">${auto ? "選択日の曜日と内閣府の祝日一覧から初期設定しました。" : "祝日の確認対象外の年です。曜日ダイヤを選択してください。"} 鉄道会社の特別ダイヤは提供元で確認してください。</p><div id="ttRows"></div></div>`;
  $("ttCalendar").value = auto || "";
  if (options.length === 1) $("ttDirection").value = options[0];
  const update = () => {
    const calendar = $("ttCalendar").value,
      direction = $("ttDirection").value;
    const matches = C.filterTimetables(s.data, calendar, direction, s.time);
    if (!calendar || !direction) {
      $("toolbar").hidden = true;
      lastResultText = "";
      $("ttRows").innerHTML =
        '<p class="sub-text">路線・方向と曜日ダイヤを指定してください。</p>';
      return;
    }
    const rows = matches.flatMap((tt) =>
      C.asArray(tt["odpt:stationTimetableObject"]),
    );
    $("ttRows").innerHTML = rows.length
      ? '<table class="result-content"><thead><tr><th>出発</th><th>行先</th><th>種別</th></tr></thead><tbody>' +
        rows
          .map(
            (o) =>
              `<tr><td>${esc(C.text(o["odpt:departureTime"]))}</td><td>${esc(C.asArray(o["odpt:destinationStation"]).map(shortId).join("、") || "記載なし")}</td><td>${esc(shortId(o["odpt:trainType"]) || "記載なし")}</td></tr>`,
          )
          .join("") +
        "</tbody></table>"
      : '<p class="sub-text">この方向・曜日ダイヤで指定時刻以降の掲載がありません。</p>';
    lastResultText =
      `${s.station} ${s.date} ${s.time}以降\n公開ODPT / ${direction} / ${calendar}\n` +
      rows
        .map(
          (o) =>
            C.text(o["odpt:departureTime"]) +
            " " +
            C.asArray(o["odpt:destinationStation"]).map(shortId).join("、"),
        )
        .join("\n");
    showToolbar(false);
  };
  $("ttDirection").addEventListener("change", update);
  $("ttCalendar").addEventListener("change", update);
  update();
}
async function checkServiceStatus() {
  await searchJob(async (signal, current) => {
    const data = await fetchOdpt("info", "", signal);
    if (!current()) return;
    $("results").innerHTML =
      '<div class="result-card"><h3>公開ODPTの運行情報</h3><p class="sub-text">取得できた路線だけを表示します。記載なし・期限不明を平常運転とは扱いません。</p>' +
      data
        .map((item) => {
          const info = C.trainInfo(item);
          return `<article class="route-notes"><h4>${esc(shortId(info.railway) || "路線不明")}</h4><p>${esc(info.body || info.status || "状況の記載がありません。")}</p><p>更新：${esc(info.issued || "記載なし")} / 有効期限：${esc(info.expiry || "記載なし")}</p><p>${info.stale ? "有効な最新情報か確認できません。提供元で確認してください。" : "取得時点では提供元の有効期限内の掲載情報です。"}</p></article>`;
        })
        .join("") +
      (data.length ? "" : "<p>現在取得できる掲載がありません。</p>") +
      '<button class="tool-btn" id="referenceBtn">AIで公式サイトの参考情報を検索（API課金）</button></div>';
    $("referenceBtn").addEventListener("click", () =>
      referenceSearch(
        "日本の鉄道運行情報の公式確認先を調べてください。日時は" +
          C.tokyoParts().date +
          "。全国の平常運転を推測せず、掲載時刻と対象範囲、公式出典を示してください。",
      ),
    );
    lastResultText =
      "公開ODPTの運行情報（対象路線のみ）\n" +
      data
        .map((item) => {
          const i = C.trainInfo(item);
          return (
            shortId(i.railway) +
            ": " +
            (i.body || i.status || "状況の記載なし") +
            " / 更新 " +
            (i.issued || "記載なし")
          );
        })
        .join("\n");
    showToolbar(false);
  });
}
async function referenceSearch(input) {
  await searchJob(async (signal, current) => {
    const data = await post(
      "/api/responses",
      { input, model: $("aiModel").value },
      signal,
    );
    if (!current()) return;
    const text = C.responseText(data);
    if (!text) throw new Error("AIの本文を取得できませんでした。");
    const citations = C.citations(data);
    $("results").innerHTML =
      `<div class="result-card"><h3>AIの参考情報</h3><p class="sub-text">モデル：${esc(data.model)}。時刻・運賃・運行状況の検証済み経路としては使いません。</p><div class="result-content">${esc(text)}</div><div class="sources">${citations.map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.title)}</a>`).join("")}</div></div>`;
    lastResultText = text + "\n" + citations.map((c) => c.url).join("\n");
    showToolbar(false);
  });
}
function searchCommuter() {
  let p;
  try {
    p = readParams();
  } catch (e) {
    showError(e.message);
    return;
  }
  cancelSearch(false);
  lastSearchParams = p;
  addHistory(p.from, p.to);
  externalResult(p, true);
}
function doSearch() {
  ({
    route: searchRoute,
    timetable: searchTimetable,
    commuter: searchCommuter,
    status: checkServiceStatus,
  })[currentMode]();
}
function swapStations() {
  cancelSearch(false);
  const f = $("fromStation"),
    t = $("toStation");
  [f.value, t.value] = [t.value, f.value];
  [f.dataset.stationId, t.dataset.stationId] = [
    t.dataset.stationId || "",
    f.dataset.stationId || "",
  ];
}
function voiceInput(id) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    banner("このブラウザーでは音声入力に対応していません。");
    return;
  }
  const recognition = new SR();
  recognition.lang = "ja-JP";
  recognition.onresult = (e) => {
    $(id).value = e.results[0][0].transcript.replace(/駅$/, "").trim();
    delete $(id).dataset.stationId;
  };
  recognition.onerror = () => banner("音声を取得できませんでした。");
  recognition.start();
}
async function detectStation() {
  if (!navigator.geolocation) {
    $("gpsStatus").textContent = "位置情報に対応していません。";
    return;
  }
  $("gpsBtn").disabled = true;
  $("gpsStatus").textContent = "現在地を取得しています…";
  try {
    const position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      }),
    );
    const q = new URLSearchParams({
      method: "getStations",
      x: String(position.coords.longitude),
      y: String(position.coords.latitude),
    });
    const r = await fetch("https://express.heartrails.com/api/json?" + q, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("近くの駅を取得できませんでした。");
    const d = await r.json(),
      stations = C.asArray(d.response?.station);
    if (!stations.length) throw new Error("近くの駅が見つかりません。");
    $("gpsStatus").replaceChildren();
    for (const station of stations.slice(0, 5)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tag";
      b.textContent = `${station.name}（${station.line} / ${station.distance || "距離不明"}）`;
      b.addEventListener("click", () => {
        $("fromStation").value = station.name;
        delete $("fromStation").dataset.stationId;
        $("gpsStatus").textContent = station.name + "を設定しました。";
      });
      $("gpsStatus").append(b);
    }
  } catch (e) {
    $("gpsStatus").textContent = e.code
      ? "位置情報の許可・接続を確認してください。"
      : e.message;
  } finally {
    $("gpsBtn").disabled = false;
  }
}
function openWalkNav() {
  if (lastSearchParams)
    window.open(
      "https://www.google.com/maps/dir/?api=1&origin=" +
        encodeURIComponent(lastSearchParams.from + "駅") +
        "&destination=" +
        encodeURIComponent(lastSearchParams.to + "駅") +
        "&travelmode=walking",
      "_blank",
      "noopener,noreferrer",
    );
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    banner("コピーしました。");
  } catch {
    banner("コピーできませんでした。ブラウザーの許可を確認してください。");
  }
}
function copyResult() {
  if (lastResultText) copyText(lastResultText);
}
function shareResult() {
  if (!lastResultText) return;
  if (navigator.share)
    navigator
      .share({ title: "乗換検索", text: lastResultText })
      .catch(() => {});
  else copyResult();
}
function setAlarm() {
  const route = routeData?.routes[selectedRouteIndex],
    value = prompt("選択中の経路の到着何分前に知らせますか？（0〜120分）", "3");
  if (value === null || !value.trim()) return;
  try {
    const deadline = C.alarmAt(route, Number(value));
    cancelAlarm();
    alarmDeadline = deadline;
    $("alarmLabel").textContent =
      `${lastSearchParams.to}駅 到着${value}分前（${C.tokyoParts(new Date(deadline)).time}）`;
    $("alarmBar").classList.add("active");
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      $("alarmTime").textContent =
        String(Math.floor(seconds / 60)).padStart(2, "0") +
        ":" +
        String(seconds % 60).padStart(2, "0");
      if (seconds === 0) {
        const label = $("alarmLabel").textContent;
        cancelAlarm();
        if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
        if ("Notification" in window && Notification.permission === "granted")
          new Notification("降車アラーム", { body: label });
        alert(label);
      }
    };
    tick();
    alarmTimer = setInterval(tick, 1000);
    if ("Notification" in window && Notification.permission === "default")
      Notification.requestPermission();
  } catch (e) {
    banner(e.message);
  }
}
function cancelAlarm() {
  if (alarmTimer) clearInterval(alarmTimer);
  alarmTimer = null;
  alarmDeadline = null;
  $("alarmBar").classList.remove("active");
}
function expenseList() {
  const list = readStore("expenses", []);
  return Array.isArray(list)
    ? list.filter(
        (e) =>
          e &&
          typeof e.label === "string" &&
          Number.isFinite(e.amount) &&
          e.amount >= 0,
      )
    : [];
}
function loadExpenses() {
  const list = expenseList();
  $("expenseBar").hidden = !list.length;
  $("expenseList").replaceChildren();
  list.forEach((expense, i) => {
    const row = document.createElement("div");
    row.className = "item";
    const text = document.createElement("span");
    text.textContent = expense.label + " / " + (expense.date || "");
    const amount = document.createElement("span");
    amount.textContent = "¥" + expense.amount.toLocaleString() + " ";
    const del = document.createElement("button");
    del.textContent = "削除";
    del.className = "tool-btn";
    del.setAttribute("aria-label", expense.label + "の旅費メモを削除");
    del.addEventListener("click", () => {
      const items = expenseList();
      items.splice(i, 1);
      writeStore("expenses", items);
      loadExpenses();
    });
    amount.append(del);
    row.append(text, amount);
    $("expenseList").append(row);
  });
  $("expenseTotal").textContent =
    "¥" + list.reduce((sum, e) => sum + e.amount, 0).toLocaleString();
}
function addExpenseFromResult() {
  if (!lastSearchParams) return;
  const r = routeData?.routes[selectedRouteIndex],
    label = lastSearchParams.from + "→" + lastSearchParams.to;
  const suggested =
    r?.fareAmount == null ? "" : String(r.fareAmount + (r.chargeAmount || 0));
  const input = prompt(`「${label}」の実際の支払額（円）`, suggested);
  if (input === null || !input.trim()) return;
  const amount = C.money(input);
  if (amount === null) {
    banner("金額を数字で入力してください。");
    return;
  }
  const list = expenseList();
  list.push({ label, amount, date: C.tokyoParts().date });
  if (!writeStore("expenses", list)) banner("旅費メモを保存できませんでした。");
  loadExpenses();
}
function clearExpenses() {
  if (confirm("旅費メモをクリアしますか？")) {
    removeStore("expenses");
    loadExpenses();
  }
}
function copyExpenses() {
  const list = expenseList();
  copyText(
    list
      .map((e) => `${e.date || ""} ${e.label}: ¥${e.amount.toLocaleString()}`)
      .join("\n") +
      "\n合計: ¥" +
      list.reduce((s, e) => s + e.amount, 0).toLocaleString(),
  );
}
function favKey() {
  return lastSearchParams
    ? lastSearchParams.from + "→" + lastSearchParams.to
    : null;
}
function updateFavBtn() {
  const active = stringList("route_favs").includes(favKey());
  $("favBtn").textContent = active ? "★ お気に入り" : "☆ お気に入り";
  $("favBtn").classList.toggle("active", active);
}
function toggleFavorite() {
  const key = favKey();
  if (!key) return;
  let list = stringList("route_favs");
  list = list.includes(key)
    ? list.filter((x) => x !== key)
    : [key, ...list].slice(0, 20);
  writeStore("route_favs", list);
  loadFavorites();
  updateFavBtn();
}
function useFav(from, to) {
  $("fromStation").value = from || "";
  $("toStation").value = to || "";
  delete $("fromStation").dataset.stationId;
  delete $("toStation").dataset.stationId;
}
function renderTags(key, section, listId, separator, removable = false) {
  const list = stringList(key);
  $(section).hidden = !list.length;
  $(listId).replaceChildren();
  for (const item of list) {
    const wrap = document.createElement("span");
    wrap.className = "tag" + (removable ? " fav" : "");
    const button = document.createElement("button");
    button.textContent = item;
    button.addEventListener("click", () => {
      setMode("route");
      useFav(...item.split(separator));
    });
    wrap.append(button);
    if (removable) {
      const del = document.createElement("button");
      del.textContent = "×";
      del.setAttribute("aria-label", item + "をお気に入りから削除");
      del.addEventListener("click", () => {
        writeStore(
          key,
          stringList(key).filter((x) => x !== item),
        );
        loadFavorites();
        updateFavBtn();
      });
      wrap.append(del);
    }
    $(listId).append(wrap);
  }
}
function loadFavorites() {
  renderTags("route_favs", "favSection", "favList", "→", true);
}
function loadHistory() {
  renderTags("route_history", "historySection", "historyList", " → ");
}
function addHistory(from, to) {
  const item = from + " → " + to;
  writeStore(
    "route_history",
    [item, ...stringList("route_history").filter((x) => x !== item)].slice(
      0,
      15,
    ),
  );
  loadHistory();
}
function init() {
  updateNow();
  updateProviderHint();
  loadHistory();
  loadFavorites();
  loadExpenses();
  loadCache();
  for (const id of ["fromStation", "toStation"])
    $(id).addEventListener("input", () => delete $(id).dataset.stationId);
  $("viaStation").addEventListener(
    "input",
    () => delete $("viaStation").dataset.stationIds,
  );
  $("specialTicket").addEventListener("change", updateExtraFields);
  $("optCommuterPass").addEventListener("change", updateExtraFields);
  // Legacy keys are never read into the page or reused automatically. They can be deleted in settings.
  try {
    if (
      localStorage.getItem("openai_api_key") ||
      localStorage.getItem("odpt_api_key")
    )
      banner(
        "以前の版でブラウザーに保存したキーが残っています。API設定の「キーを消去」で削除できます。",
      );
  } catch {}
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && alarmDeadline && Date.now() > alarmDeadline) {
      const label = $("alarmLabel").textContent;
      cancelAlarm();
      alert(label + "（画面休止中に設定時刻を過ぎました）");
    }
  });
}
init();
