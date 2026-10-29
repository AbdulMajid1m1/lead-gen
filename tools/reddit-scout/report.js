import { toWww } from "./extract.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ago = (iso, now) => {
  if (!iso) return "";
  const h = Math.round((now - Date.parse(iso)) / 3600000);
  return h < 1 ? "just now" : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

const rows = (text) => Math.min(14, Math.ceil(text.length / 70) + text.split("\n").length);

// A draft box. `post` makes it the one the Post button sends.
const draft = ({ label, text, post = null, interactive = false, posted = null, extra = "" }) => {
  if (!text) return "";
  const button =
    post && interactive && !posted
      ? `<button type="button" class="post" data-id="${esc(post)}">Post to Reddit</button>`
      : "";
  const done = posted ? `<span class="posted">Posted ${esc(new Date(posted.at).toLocaleString())} · <a href="${esc(posted.permalink)}" target="_blank" rel="noopener">view</a></span>` : "";
  return `<div class="draft"><div class="draft-head"><span>${esc(label)}</span><span class="tools">${done}${extra}<button type="button" class="copy">Copy</button>${button}</span></div><textarea rows="${rows(posted?.text ?? text)}"${posted ? " readonly" : ""}>${esc(posted?.text ?? text)}</textarea><p class="result" hidden></p></div>`;
};

const messageLink = (post, text) =>
  `https://www.reddit.com/message/compose/?${new URLSearchParams({ to: post.author ?? "", subject: (post.title ?? "").slice(0, 90), message: text })}`;

const LABELS = { new: "Comment", respond: "Reply (goes under OP's answer to you)", nudge: "Follow-up (goes under your own comment)" };

const card = (item, now, interactive) => {
  const { post, a, kind } = item;
  const meta = [`r/${post.subreddit}`, ago(post.createdAt, now), `${post.comments ?? 0} comments`, a?.fit, a?.stage].filter(Boolean);
  const postText = kind === "new" ? a?.comment : a?.reply;
  return `<article class="card">
  <header>
    ${a ? `<span class="badge ${esc(a.verdict)}">${esc(a.action)}</span><span class="score">${a.score}</span>` : ""}
    <a class="title" href="${esc(toWww(post.url))}" target="_blank" rel="noopener">${esc(post.title)}</a>
  </header>
  <p class="meta">${meta.map(esc).join(" · ")} · u/${esc(post.author)}</p>
  ${a ? `<p class="facts"><b>Who:</b> ${esc(a.who)} · <b>Budget:</b> ${esc(a.budget)} · <b>Competition:</b> ${esc(a.competition)}</p><p>${esc(a.why)}</p>` : ""}
  ${item.note ? `<p class="note">${esc(item.note)}</p>` : ""}
  ${a ? draft({ label: LABELS[kind], text: postText, post: item.postable ? item.job.id : null, interactive, posted: item.posted }) : ""}
  ${a ? draft({ label: "DM (only because the post invites it)", text: a.dm, extra: a.dm ? `<a class="tool" href="${esc(messageLink(post, a.dm))}" target="_blank" rel="noopener">Open message</a>` : "" }) : ""}
  ${a?.followUp ? `<p class="plan"><b>Follow-up:</b> ${esc(a.followUp)}</p>` : ""}
  ${a?.watchOut ? `<p class="plan"><b>Watch out:</b> ${esc(a.watchOut)}</p>` : ""}
</article>`;
};

const section = (title, hint, items, now, interactive) =>
  items.length
    ? `<section><h2>${esc(title)} <span class="count">${items.length}</span></h2><p class="hint">${esc(hint)}</p>${items.map((i) => card(i, now, interactive)).join("\n")}</section>`
    : "";

/**
 * items come from actions.buildItems. `interactive` ({ token }) is set when
 * the review server renders the page; it adds the Post buttons.
 */
export function renderReport({ items, me, startedAt, stats, now = Date.now(), interactive = null }) {
  const byScore = (x, y) => (y.a?.score ?? 0) - (x.a?.score ?? 0);
  const acting = (i) => i.a && i.a.action !== "skip";
  const respond = items.filter((i) => i.kind === "respond" && i.a).sort(byScore);
  const nudges = items.filter((i) => i.kind === "nudge" && (acting(i) || i.note));
  const judged = items.filter((i) => i.kind === "new" && i.a);
  const pursue = judged.filter((i) => i.a.verdict === "pursue").sort(byScore);
  const maybe = judged.filter((i) => i.a.verdict === "maybe").sort(byScore);
  const skipped = judged.filter((i) => i.a.verdict === "skip");
  const failed = items.filter((i) => i.kind === "new" && !i.a);
  const on = Boolean(interactive);
  const howTo = on
    ? "Read the thread first. Edit the box until it sounds like you. Post to Reddit asks you to click twice, then posts that exact text as you, at most one post every 90 seconds."
    : "Open the thread, read it, edit the draft so it sounds like you, then post it yourself. Or run npm run review to post from this page.";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reddit Scout</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dc;--accent:#0e7c7b;--pursue:#0e7c7b;--maybe:#a8660b;--skip:#8a8a84;--bad:#b3261e}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#4fc1bf;--pursue:#4fc1bf;--maybe:#e0a54a;--skip:#8a8a84;--bad:#f2867d}}
:root[data-theme="dark"]{--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--muted:#a3a29b;--line:#34332f;--accent:#4fc1bf;--pursue:#4fc1bf;--maybe:#e0a54a;--skip:#8a8a84;--bad:#f2867d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 2px}
.count{color:var(--muted);font-weight:400}.hint,.meta,.sub{color:var(--muted);font-size:13px;margin:2px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.card header{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.title{color:var(--ink);font-weight:600;text-decoration:none}.title:hover{text-decoration:underline}
.badge{font-size:12px;border-radius:999px;padding:1px 9px;border:1px solid currentColor;white-space:nowrap}.badge.pursue{color:var(--pursue)}.badge.maybe{color:var(--maybe)}.badge.skip{color:var(--skip)}
.score{font-size:12px;color:var(--muted)}.facts{font-size:13px}.card p{margin:6px 0}.note{border-left:3px solid var(--accent);padding-left:10px}
.draft{margin:12px 0}.draft-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:4px}
.tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
textarea{width:100%;font:inherit;font-size:14px;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 10px;resize:vertical}
button,.tool{font:inherit;font-size:12px;background:none;color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:2px 10px;cursor:pointer;text-decoration:none}
button.post{background:var(--accent);color:var(--card);border-color:var(--accent)}button.post.confirm{background:var(--maybe);border-color:var(--maybe)}button:disabled{opacity:.6;cursor:default}
.posted{color:var(--pursue)}.result{font-size:13px}.result.bad{color:var(--bad)}
.plan{font-size:13px;color:var(--muted)}details{margin-top:28px}summary{cursor:pointer;font-weight:600}li{margin:4px 0;font-size:14px}a{color:var(--accent)}
</style></head><body><main>
<h1>Reddit Scout</h1>
<p class="sub">${esc(new Date(startedAt).toLocaleString())} · u/${esc(me ?? "?")} · ${stats.searched} search results, ${stats.opened} new threads read, ${stats.rechecked} watched re-read${stats.stoppedEarly ? ` · <b>stopped early: ${esc(stats.stoppedEarly)}</b>` : ""}</p>
<p class="hint">${esc(howTo)}</p>
${section("Reply now", "OP answered your comment. Reply while they are still in the thread.", respond, now, on)}
${section("Act on these", "Worth a comment today, best first.", pursue, now, on)}
${section("Follow-up due", "You commented a few days ago and OP has not answered. One follow-up that adds something, then stop.", nudges, now, on)}
${section("Maybe", "Real need, weaker signals. Worth a helpful comment if you have time.", maybe, now, on)}
${skipped.length ? `<details><summary>Skipped (${skipped.length})</summary><ul>${skipped.map((i) => `<li><a href="${esc(toWww(i.post.url))}" target="_blank" rel="noopener">${esc(i.post.title)}</a> <span class="meta">r/${esc(i.post.subreddit)}: ${esc(i.a.why)}</span></li>`).join("")}</ul></details>` : ""}
${failed.length ? `<details><summary>Not judged (${failed.length})</summary><p class="hint">Claude did not return a verdict for these. Run <code>npm run analyze</code> to retry.</p><ul>${failed.map((i) => `<li><a href="${esc(toWww(i.post.url))}" target="_blank" rel="noopener">${esc(i.post.title)}</a></li>`).join("")}</ul></details>` : ""}
${!items.length ? `<p>Nothing new this run.</p>` : ""}
</main>
<script>
const TOKEN = ${JSON.stringify(interactive?.token ?? null)};
document.addEventListener("click", async (e) => {
  const copy = e.target.closest("button.copy");
  if (copy) {
    const t = copy.closest(".draft").querySelector("textarea");
    try { await navigator.clipboard.writeText(t.value); } catch { t.select(); document.execCommand("copy"); }
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
    return;
  }
  const btn = e.target.closest("button.post");
  if (!btn || !TOKEN || btn.disabled) return;
  if (!btn.classList.contains("confirm")) {
    btn.classList.add("confirm");
    btn.textContent = "Click again to post";
    setTimeout(() => { if (!btn.disabled) { btn.classList.remove("confirm"); btn.textContent = "Post to Reddit"; } }, 6000);
    return;
  }
  const box = btn.closest(".draft");
  const out = box.querySelector(".result");
  btn.disabled = true;
  btn.textContent = "Posting…";
  out.hidden = false;
  out.className = "result";
  out.textContent = "Posting in the scout's Chrome window. Leave it open. If you just posted, this waits up to 90 seconds first.";
  try {
    const res = await fetch("/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Scout-Token": TOKEN },
      body: JSON.stringify({ id: btn.dataset.id, text: box.querySelector("textarea").value }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    box.querySelector("textarea").readOnly = true;
    btn.remove();
    out.innerHTML = 'Posted. <a target="_blank" rel="noopener"></a>';
    const link = out.querySelector("a");
    link.href = body.permalink;
    link.textContent = "View it on Reddit";
  } catch (err) {
    out.className = "result bad";
    out.textContent = err.message;
    btn.disabled = false;
    btn.classList.remove("confirm");
    btn.textContent = "Post to Reddit";
  }
});
</script>
</body></html>`;
}
