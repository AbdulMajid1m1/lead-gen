import { toWww } from "./extract.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ago = (iso, now) => {
  if (!iso) return "";
  const h = Math.round((now - Date.parse(iso)) / 3600000);
  return h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

const draft = (label, text) =>
  text
    ? `<div class="draft"><div class="draft-head"><span>${label}</span><button type="button" class="copy">Copy</button></div><textarea rows="${Math.min(12, Math.ceil(text.length / 70) + 1)}">${esc(text)}</textarea></div>`
    : "";

const card = (item, now) => {
  const { post, a } = item;
  const meta = [
    `r/${esc(post.subreddit)}`,
    ago(post.createdAt, now),
    `${post.comments ?? 0} comments`,
    a?.fit,
    a?.stage,
  ].filter(Boolean);
  return `<article class="card">
  <header>
    ${a ? `<span class="badge ${esc(a.verdict)}">${esc(a.action)}</span><span class="score">${a.score}</span>` : ""}
    <a class="title" href="${esc(toWww(post.url))}" target="_blank" rel="noopener">${esc(post.title)}</a>
  </header>
  <p class="meta">${meta.map(esc).join(" · ")}</p>
  ${a ? `<p class="facts"><b>Who:</b> ${esc(a.who)} · <b>Budget:</b> ${esc(a.budget)} · <b>Competition:</b> ${esc(a.competition)}</p>
  <p>${esc(a.why)}</p>` : ""}
  ${item.note ? `<p class="note">${esc(item.note)}</p>` : ""}
  ${a ? draft("Reply to OP", a.reply) + draft("Comment", a.comment) + draft("DM", a.dm) : ""}
  ${a?.followUp ? `<p class="plan"><b>Follow-up:</b> ${esc(a.followUp)}</p>` : ""}
  ${a?.watchOut ? `<p class="plan"><b>Watch out:</b> ${esc(a.watchOut)}</p>` : ""}
</article>`;
};

const section = (title, hint, items, now) =>
  items.length ? `<section><h2>${esc(title)} <span class="count">${items.length}</span></h2><p class="hint">${esc(hint)}</p>${items.map((i) => card(i, now)).join("\n")}</section>` : "";

/**
 * items: [{ post, a?, kind: "respond"|"new"|"nudge", note? }]
 */
export function renderReport({ items, me, startedAt, stats, now = Date.now() }) {
  const byScore = (x, y) => (y.a?.score ?? 0) - (x.a?.score ?? 0);
  const respond = items.filter((i) => i.kind === "respond" && i.a).sort(byScore);
  const nudges = items.filter((i) => i.kind === "nudge");
  const judged = items.filter((i) => i.kind === "new" && i.a);
  const pursue = judged.filter((i) => i.a.verdict === "pursue").sort(byScore);
  const maybe = judged.filter((i) => i.a.verdict === "maybe").sort(byScore);
  const skipped = judged.filter((i) => i.a.verdict === "skip");
  const failed = items.filter((i) => i.kind === "new" && !i.a);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reddit Scout</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--accent:#0e7c7b;--pursue:#0e7c7b;--maybe:#a8660b;--skip:#8a8a84}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#4fc1bf;--pursue:#4fc1bf;--maybe:#e0a54a;--skip:#8a8a84}}
:root[data-theme="dark"]{--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#4fc1bf;--pursue:#4fc1bf;--maybe:#e0a54a;--skip:#8a8a84}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 2px}
.count{color:var(--muted);font-weight:400}.hint,.meta,.sub{color:var(--muted);font-size:13px;margin:2px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.card header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.title{color:var(--ink);font-weight:600;text-decoration:none}.title:hover{text-decoration:underline}
.badge{font-size:12px;border-radius:999px;padding:1px 9px;border:1px solid currentColor;white-space:nowrap}.badge.pursue{color:var(--pursue)}.badge.maybe{color:var(--maybe)}.badge.skip{color:var(--skip)}
.score{font-size:12px;color:var(--muted)}.facts{font-size:13px}.card p{margin:6px 0}.note{border-left:3px solid var(--accent);padding-left:10px}
.draft{margin:10px 0}.draft-head{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px}
textarea{width:100%;font:inherit;font-size:14px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical}
button.copy{font:inherit;font-size:12px;background:none;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:1px 10px;cursor:pointer}
.plan{font-size:13px;color:var(--muted)}details{margin-top:28px}summary{cursor:pointer;font-weight:600}li{margin:4px 0;font-size:14px}a{color:var(--accent)}
</style></head><body><main>
<h1>Reddit Scout</h1>
<p class="sub">${esc(new Date(startedAt).toLocaleString())} · signed in as u/${esc(me ?? "?")} · ${stats.searched} search results, ${stats.opened} new threads read, ${stats.rechecked} watched re-read${stats.stoppedEarly ? ` · <b>stopped early: ${esc(stats.stoppedEarly)}</b>` : ""}</p>
${section("Reply now", "OP answered your comment. Reply in the thread while they are still there.", respond, now)}
${section("Act on these", "Open the thread, read it yourself, edit the draft so it sounds like you, then post it. Links open Reddit in your normal browser.", pursue, now)}
${section("Follow-up due", `You commented a few days ago and OP has not replied. One follow-up that adds something new, then stop.`, nudges, now)}
${section("Maybe", "Real need, weaker signals. Worth a helpful comment if you have time.", maybe, now)}
${skipped.length ? `<details><summary>Skipped (${skipped.length})</summary><ul>${skipped.map((i) => `<li><a href="${esc(toWww(i.post.url))}" target="_blank" rel="noopener">${esc(i.post.title)}</a> <span class="meta">r/${esc(i.post.subreddit)}: ${esc(i.a.why)}</span></li>`).join("")}</ul></details>` : ""}
${failed.length ? `<details><summary>Not judged (${failed.length})</summary><p class="hint">Claude did not return a verdict for these. Run <code>npm run analyze</code> to retry.</p><ul>${failed.map((i) => `<li><a href="${esc(toWww(i.post.url))}" target="_blank" rel="noopener">${esc(i.post.title)}</a></li>`).join("")}</ul></details>` : ""}
${!items.length ? `<p>Nothing new this run.</p>` : ""}
</main>
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button.copy");
  if (!b) return;
  const t = b.closest(".draft").querySelector("textarea");
  try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
  b.textContent = "Copied";
  setTimeout(() => (b.textContent = "Copy"), 1500);
});
</script>
</body></html>`;
}
