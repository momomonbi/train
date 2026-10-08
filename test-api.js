"use strict";
let controller = null;
const button = document.getElementById("test"),
  cancel = document.getElementById("cancel"),
  output = document.getElementById("result");
button.addEventListener("click", async () => {
  button.disabled = true;
  cancel.hidden = false;
  output.textContent = "接続中…";
  controller = new AbortController();
  const active = controller;
  const timer = setTimeout(() => active.abort(), 120000);
  try {
    const config = await fetch("/api/config", { signal: active.signal }).then(
      (r) => {
        if (!r.ok)
          throw new Error("start.ps1 でローカルサーバーを起動してください。");
        return r.json();
      },
    );
    if (!config.openaiEnabled)
      throw new Error("乗換検索のAPI設定でOpenAIキーを入力してください。");
    const started = performance.now();
    const response = await fetch("/api/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Train-Token": config.csrf,
      },
      body: JSON.stringify({
        model: document.getElementById("model").value,
        input:
          "日本の鉄道運行情報を確認できる公式サイトを1つ、ウェブ検索で見つけて短く説明してください。時刻や運賃は推測しないでください。",
        maxTokens: 1500,
      }),
      signal: active.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "接続できませんでした。");
    if (active.signal.aborted) return;
    const text = TrainCore.responseText(data);
    if (!text) throw new Error("本文を取得できませんでした。");
    output.textContent =
      `接続成功 / ${data.model} / ${((performance.now() - started) / 1000).toFixed(1)}秒\n\n${text}\n\n` +
      TrainCore.citations(data)
        .map((c) => c.url)
        .join("\n");
  } catch (error) {
    output.textContent = active.signal.aborted
      ? "中止またはタイムアウトしました。"
      : error.message;
  } finally {
    clearTimeout(timer);
    controller = null;
    button.disabled = false;
    cancel.hidden = true;
  }
});
cancel.addEventListener("click", () => controller?.abort());
