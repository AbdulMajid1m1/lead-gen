/**
 * Everything that knows Reddit's shape. The two `read*` functions run inside
 * the browser page (Playwright serialises them), so they must stay
 * self-contained: no imports, no outer variables. The rest is plain Node and
 * unit-tested.
 *
 * Both readers target old.reddit.com, whose HTML is stable and carries the
 * post id, author and timestamps as data attributes.
 */

const OLD = "https://old.reddit.com";

export const searchUrl = ({ q, sub }) => {
  const params = new URLSearchParams({ q, sort: "new", t: "week" });
  if (sub) params.set("restrict_sr", "on");
  return `${OLD}${sub ? `/r/${sub}` : ""}/search?${params}`;
};

const withHost = (url, host) => {
  const u = new URL(url, OLD);
  u.hostname = host;
  return u.toString();
};
export const toOld = (url) => withHost(url, "old.reddit.com");
export const toWww = (url) => withHost(url, "www.reddit.com");

export const postId = (url) => {
  const m = /\/comments\/([a-z0-9]+)/i.exec(url ?? "");
  return m ? `t3_${m[1].toLowerCase()}` : null;
};

// Freelancers advertising themselves ("[For Hire] Full-stack dev…") are the
// bulk of r/forhire and are never buyers.
const OFFER_RE = /\[\s*for\s*hire\s*\]|^\W*for\s*hire\b|^\W*\[?\s*offer(ing)?\b/i;
export const isOffer = (title) => OFFER_RE.test(title ?? "");

const BOT_AUTHORS = new Set(["automoderator", "[deleted]"]);

/**
 * Posts worth opening this run: new to us, recent, not a freelancer's ad,
 * newest first, capped.
 */
export const pickNew = (found, state, { now = Date.now(), maxAgeHours, maxNewThreads }) =>
  found
    .filter((p) => p.id && !state.posts[p.id])
    .filter((p) => !isOffer(p.title))
    .filter((p) => !BOT_AUTHORS.has((p.author ?? "").toLowerCase()))
    .filter((p) => !p.createdAt || now - Date.parse(p.createdAt) <= maxAgeHours * 3600 * 1000)
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0))
    .slice(0, maxNewThreads);

/**
 * Posts already judged worth acting on, re-read to see whether you commented
 * and whether OP answered you.
 */
export const pickRechecks = (state, { now = Date.now(), trackDays, maxRechecks }) =>
  Object.entries(state.posts)
    .filter(([, p]) => ["pursue", "maybe"].includes(p.verdict) && !p.closed)
    .filter(([, p]) => now - Date.parse(p.firstSeenAt) <= trackDays * 24 * 3600 * 1000)
    .sort(([, a], [, b]) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
    .slice(0, maxRechecks)
    .map(([id, p]) => ({ id, url: p.url, title: p.title }));

/** Runs in the page. One old.reddit search results page. */
export function readSearchPage() {
  const blockReason = () => {
    const text = `${document.title} ${(document.body?.innerText ?? "").slice(0, 3000)}`;
    if (/whoa there,? pardner|you've been blocked|blocked by network security|too many requests/i.test(text)) return "blocked";
    if (document.querySelector('iframe[src*="captcha"], .g-recaptcha, [data-hcaptcha-widget-id]')) return "captcha";
    if (location.pathname.startsWith("/login")) return "login";
    return null;
  };
  const meLink = document.querySelector('#header-bottom-right .user a[href*="/user/"]');
  const results = [...document.querySelectorAll(".search-result-link")].map((el) => {
    const title = el.querySelector("a.search-title");
    const comments = el.querySelector("a.search-comments");
    const author = el.querySelector(".search-author a.author, a.author");
    const sub = el.querySelector("a.search-subreddit-link");
    const time = el.querySelector(".search-time time[datetime], time[datetime]");
    const body = el.querySelector(".search-result-body, .search-expando");
    return {
      id: el.getAttribute("data-fullname"),
      title: title?.textContent.trim() ?? "",
      url: comments?.href || title?.href || null,
      author: author?.textContent.trim() ?? null,
      subreddit: sub?.textContent.trim().replace(/^\/?r\//i, "") ?? null,
      createdAt: time?.getAttribute("datetime") ?? null,
      comments: parseInt(comments?.textContent ?? "", 10) || 0,
      snippet: (body?.innerText ?? "").trim().slice(0, 600),
    };
  });
  return {
    blocked: blockReason(),
    me: meLink?.textContent.trim() || null,
    results,
    next: document.querySelector('.nav-buttons a[rel~="next"]')?.href ?? null,
  };
}

/** Runs in the page. One old.reddit thread; `me` is your username. */
export function readThread(me) {
  const blockReason = () => {
    const text = `${document.title} ${(document.body?.innerText ?? "").slice(0, 3000)}`;
    if (/whoa there,? pardner|you've been blocked|blocked by network security|too many requests/i.test(text)) return "blocked";
    if (document.querySelector('iframe[src*="captcha"], .g-recaptcha, [data-hcaptcha-widget-id]')) return "captcha";
    if (location.pathname.startsWith("/login")) return "login";
    return null;
  };
  const blocked = blockReason();
  const post = document.querySelector("#siteTable > .thing.link");
  if (blocked || !post) return { blocked, missing: !post };

  const op = post.getAttribute("data-author");
  const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
  const text = (thing, max) => (thing.querySelector(":scope > .entry .usertext-body .md")?.innerText ?? "").trim().slice(0, max);
  const when = (thing) => thing.querySelector(":scope > .entry .tagline time[datetime]")?.getAttribute("datetime") ?? null;
  const kids = (thing) => [...thing.querySelectorAll(":scope > .child > .sitetable > .thing.comment")];
  const all = [...document.querySelectorAll(".commentarea .thing.comment")];
  const top = [...document.querySelectorAll(".commentarea > .sitetable > .thing.comment")];
  const stamp = Number(post.getAttribute("data-timestamp"));

  return {
    blocked: null,
    id: post.getAttribute("data-fullname"),
    title: post.querySelector("a.title")?.textContent.trim() ?? "",
    author: op,
    subreddit: post.getAttribute("data-subreddit"),
    flair: post.querySelector(".linkflairlabel")?.textContent.trim() || null,
    createdAt: stamp ? new Date(stamp).toISOString() : null,
    score: Number(post.getAttribute("data-score")) || 0,
    comments: Number(post.getAttribute("data-comments-count")) || all.length,
    body: (post.querySelector(".expando .usertext-body .md")?.innerText ?? "").trim().slice(0, 4000),
    removed: /^\[(removed|deleted)\]$/i.test((post.querySelector(".expando .md")?.innerText ?? "").trim()),
    canComment: Boolean(document.querySelector(".commentarea form.usertext textarea")),
    opComments: all.filter((c) => same(c.getAttribute("data-author"), op)).length,
    topComments: top.slice(0, 12).map((c) => ({
      author: c.getAttribute("data-author"),
      text: text(c, 400),
      opReplied: kids(c).some((k) => same(k.getAttribute("data-author"), op)),
    })),
    mine: all
      .filter((c) => same(c.getAttribute("data-author"), me))
      .map((c) => ({
        id: c.getAttribute("data-fullname"),
        at: when(c),
        text: text(c, 800),
        opReplies: kids(c)
          .filter((k) => same(k.getAttribute("data-author"), op))
          .map((k) => ({ id: k.getAttribute("data-fullname"), at: when(k), text: text(k, 800) })),
      })),
  };
}
