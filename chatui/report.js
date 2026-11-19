// Report export: turns the data already loaded on screen into a self-contained HTML
// document. Pure functions only — no fetch, no storage, no DOM. Chat text is escaped
// everywhere so a message can never inject markup into the report.
(function (root, factory) {
  const api = factory();
  // Browser <script> load: expose a single Report namespace (app.js reads window.Report).
  if (root) root.Report = api;
  // CommonJS load (tests / tooling): the project is "type: module", so keep both.
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const MAX_MESSAGES = 2000;

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/gu, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function formatTime(value) {
    const milliseconds = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "";
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return "";
    const pad = number => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function distribution(result, field) {
    if (!result || typeof result !== "object") return [];
    const value = field === "intent" ? result.intent : result.emotion;
    return Array.isArray(value) ? value : [];
  }

  function labelOf(result, field) {
    const direct = field === "intent" ? result?.intentLabel : result?.emotionLabel;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const top = distribution(result, field)[0];
    return top && typeof top.label === "string" && top.label.trim() ? top.label.trim() : "";
  }

  function probabilityOf(result, field) {
    const direct = field === "intent" ? result?.intentP : result?.emotionP;
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0 && direct <= 1) return direct;
    const top = distribution(result, field)[0];
    return top && typeof top.probability === "number" && Number.isFinite(top.probability) ? top.probability : null;
  }

  function formatProbability(value) {
    return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "";
  }

  function formatList(value) {
    if (!value) return "";
    if (Array.isArray(value)) return value.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return item.word || item.label || item.name || "";
      return "";
    }).filter(Boolean).join("、");
    if (typeof value === "object") return Object.keys(value).join("、");
    return String(value);
  }

  function senderOf(message, fallback) {
    if (typeof message.senderName === "string" && message.senderName.trim()) return message.senderName.trim();
    if (message.side === "self") return "我";
    if (typeof fallback === "string" && fallback.trim()) return fallback.trim();
    return "对方";
  }

  function countBlocks(counts, label) {
    const entries = Object.entries(counts).sort((left, right) =>
      right[1] - left[1] || left[0].localeCompare(right[0], "zh"));
    if (!entries.length) return "";
    const max = entries[0][1];
    return `<section class="card"><h2>${escapeHtml(label)}分布</h2>` +
      `<div class="bars">${entries.slice(0, 8).map(([name, count]) =>
        `<div class="bar-row"><span class="bar-name">${escapeHtml(name)}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round(count / max * 100))}%"></span></span>` +
        `<span class="bar-count">${count}</span></div>`).join("")}</div></section>`;
  }

  function buildReportHtml(input) {
    const data = input && typeof input === "object" ? input : {};
    const messages = Array.isArray(data.messages) ? data.messages.slice(-MAX_MESSAGES) : [];
    const results = data.results && typeof data.results === "object" && !Array.isArray(data.results) ? data.results : {};
    const profile = data.profile && typeof data.profile === "object" ? data.profile : null;
    const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
    const user = typeof meta.user === "string" ? meta.user.trim() : "";
    const generatedAt = typeof meta.generatedAt === "string" && meta.generatedAt.trim() ? meta.generatedAt : new Date().toISOString();
    const rangeLabel = typeof meta.rangeLabel === "string" ? meta.rangeLabel : "当前已加载窗口";

    const intentCounts = Object.create(null);
    const emotionCounts = Object.create(null);
    let analyzed = 0;
    const rows = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const id = message.id == null ? "" : String(message.id);
      const result = id ? results[id] : null;
      const intent = labelOf(result, "intent");
      const emotion = labelOf(result, "emotion");
      if (intent || emotion) analyzed += 1;
      if (intent) intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      if (emotion) emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
      rows.push({
        time: formatTime(message.time),
        sender: senderOf(message, meta.contactName),
        text: typeof message.text === "string" ? message.text : "",
        kind: message.kind === "text" || !message.kind ? "" : message.kind,
        intent,
        intentProbability: formatProbability(probabilityOf(result, "intent")),
        emotion,
        emotionProbability: formatProbability(probabilityOf(result, "emotion")),
      });
    }

    const profileParts = [];
    if (profile) {
      if (profile.affinity != null) profileParts.push(["好感度", String(profile.affinity)]);
      if (profile.mbti) profileParts.push(["MBTI", String(profile.mbti)]);
      if (profile.mood) profileParts.push(["情绪倾向", String(profile.mood)]);
      if (profile.dataStatus) {
        const statusText = { analyzed: "已分析", partial: "部分分析", unanalyzed: "未分析" }[profile.dataStatus] || String(profile.dataStatus);
        profileParts.push(["画像状态", statusText]);
      }
      if (Array.isArray(profile.traits) && profile.traits.length)
        profileParts.push(["行为特征", formatList(profile.traits)]);
      if (Array.isArray(profile.keywords) && profile.keywords.length)
        profileParts.push(["高频词", formatList(profile.keywords.slice(0, 12))]);
      if (typeof profile.summary === "string" && profile.summary.trim())
        profileParts.push(["画像摘要", profile.summary.trim()]);
    }
    const profileHtml = profileParts.length
      ? `<section class="card"><h2>画像摘要</h2><dl class="facts">${profileParts.map(([name, value]) =>
          `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></section>`
      : `<section class="card"><h2>画像摘要</h2><p class="empty">当前会话尚未生成画像。</p></section>`;

    const rowsHtml = rows.length
      ? rows.map(row => `<tr><td class="time">${escapeHtml(row.time)}</td>` +
          `<td class="sender">${escapeHtml(row.sender)}</td>` +
          `<td class="text">${escapeHtml(row.text)}${row.kind ? `<span class="kind">[${escapeHtml(row.kind)}]</span>` : ""}</td>` +
          `<td>${escapeHtml(row.intent)}${row.intentProbability ? `<span class="p">${escapeHtml(row.intentProbability)}</span>` : ""}</td>` +
          `<td>${escapeHtml(row.emotion)}${row.emotionProbability ? `<span class="p">${escapeHtml(row.emotionProbability)}</span>` : ""}</td></tr>`).join("")
      : `<tr><td colspan="5" class="empty">当前窗口没有消息。</td></tr>`;

    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>聊天分析报告 - ${escapeHtml(user || "会话")}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px; background: #f5f6f8; color: #1b2026;
    font: 14px/1.6 "Microsoft YaHei", "Segoe UI", sans-serif; }
  main { max-width: 960px; margin: 0 auto; }
  header { margin-bottom: 20px; }
  h1 { margin: 0 0 6px; font-size: 24px; }
  h2 { margin: 0 0 14px; font-size: 15px; color: #38414a; }
  .sub { color: #66707a; font-size: 12px; }
  .card { background: #fff; border: 1px solid #e2e6ea; border-radius: 10px;
    padding: 18px 20px; margin-bottom: 16px; break-inside: avoid; }
  .metrics { display: flex; flex-wrap: wrap; gap: 12px; }
  .metric { flex: 1 1 150px; background: #fff; border: 1px solid #e2e6ea; border-radius: 10px;
    padding: 14px 18px; margin-bottom: 16px; }
  .metric b { display: block; font-size: 22px; color: #1a7f4b; }
  .metric span { font-size: 12px; color: #66707a; }
  .facts { display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; margin: 0; }
  .facts dt { color: #66707a; }
  .facts dd { margin: 0; word-break: break-word; }
  .bars { display: flex; flex-direction: column; gap: 7px; }
  .bar-row { display: flex; align-items: center; gap: 10px; }
  .bar-name { width: 84px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 8px; background: #edf0f3; border-radius: 4px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: #2f9e69; }
  .bar-count { width: 36px; text-align: right; color: #66707a; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #edf0f3; text-align: left; vertical-align: top; }
  th { background: #f0f3f5; font-size: 12px; color: #56606a; position: sticky; top: 0; }
  .time { white-space: nowrap; color: #66707a; font-size: 12px; }
  .sender { width: 80px; font-weight: 600; }
  .text { word-break: break-word; white-space: pre-wrap; }
  .kind, .p { color: #8a939b; font-size: 11px; margin-left: 6px; }
  .empty { color: #8a939b; text-align: center; padding: 16px; }
  footer { margin-top: 18px; color: #8a939b; font-size: 11px; text-align: center; }
  @media print {
    body { background: #fff; padding: 0; }
    .card, .metric, table { break-inside: avoid; }
    .card, .metric { box-shadow: none; }
  }
</style></head><body><main>
<header>
  <h1>聊天分析报告 · ${escapeHtml(user || "未命名会话")}</h1>
  <div class="sub">生成时间 ${escapeHtml(formatTime(generatedAt) || generatedAt)} · 范围 ${escapeHtml(rangeLabel)} · 共 ${messages.length} 条消息</div>
</header>
<section class="metrics">
  <div class="metric"><b>${messages.length}</b><span>消息条数</span></div>
  <div class="metric"><b>${analyzed}</b><span>已分析条数</span></div>
  <div class="metric"><b>${analyzed && messages.length ? Math.round(analyzed / messages.length * 100) : 0}%</b><span>分析覆盖率</span></div>
</section>
${profileHtml}
${countBlocks(intentCounts, "意图")}
${countBlocks(emotionCounts, "情绪")}
<section class="card"><h2>消息明细</h2>
<table><thead><tr><th>时间</th><th>发送方</th><th>内容</th><th>意图</th><th>情绪</th></tr></thead>
<tbody>${rowsHtml}</tbody></table></section>
<footer>本报告由 WechatVibe 在本机生成，内容未上传 · ${escapeHtml(generatedAt)}</footer>
</main></body></html>`;
  }

  function reportFileName(user, date) {
    const safe = String(user || "conversation").replace(/[\\/:*?"<>|\s]+/gu, "_").slice(0, 60) || "conversation";
    const stamp = String(date || new Date().toISOString()).replace(/[-:]/gu, "").slice(0, 15);
    return `WechatVibe-${safe}-${stamp}.html`;
  }

  return { buildReportHtml, reportFileName, escapeHtml, formatTime };
});
