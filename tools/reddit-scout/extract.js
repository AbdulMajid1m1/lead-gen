/**
 * Everything that knows Reddit's shape. `blockReason`, `readSearchPage` and
 * `readThread` run inside the browser page (Playwright serialises them), so
 * they must stay self-contained: no imports, no outer variables. The rest is
 * plain Node and unit-tested.
 *
 * old.reddit.com now redirects to the main site for this account, so these
 * read www.reddit.com, where a post is a <shreddit-post> and a comment a
 * <shreddit-comment>, both carrying ids, authors and timestamps as attributes.
 */

const WWW = "https://www.reddit.com";

export const searchUrl = ({ q, sub }) => `${WWW}${sub ? `/r/${sub}` : ""}/search/?${new URLSearchParams({ q, type: "posts", sort: "new", t: "week" })}`;

export const toWww = (url) => {
  const u = new URL(url, WWW);
  u.hostname = "www.reddit.com";
  return u.toString();
};

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

/** Runs in the page. Why Reddit will not serve this page, if it won't. */
export function blockReason() {
  const text = `${document.title} ${(document.body?.innerText ?? "").slice(0, 3000)}`;
  if (!document.querySelector("shreddit-app") && /whoa there,? pardner|you've been blocked|blocked by network security|too many requests|prove your humanity/i.test(text)) return "blocked";
  // Reddit keeps an invisible reCAPTCHA on normal pages, so only a challenge
  // large enough to be on screen counts.
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"]')].some((f) => {
    const box = f.getBoundingClientRect();
    return box.width > 250 && box.height > 250;
  });
  if (challenge) return "captcha";
  if (location.pathname.startsWith("/login")) return "login";
  return null;
}

/** Runs in the page. The post cards on a www.reddit.com search page. */
export function readSearchPage() {
  const iso = (s) => {
    const d = new Date(String(s ?? "").replace(/(\.\d{3})\d+/, "$1").replace(/\+0000$/, "Z"));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  return [...document.querySelectorAll('[data-testid="search-post-unit"]')].map((unit) => {
    const title = unit.querySelector('a[data-testid="post-title"]');
    let tracked = {};
    try {
      tracked = JSON.parse(unit.querySelector("search-telemetry-tracker")?.getAttribute("data-faceplate-tracking-context") ?? "{}");
    } catch {}
    const counted = [...unit.querySelectorAll("faceplate-number")].at(-1)?.getAttribute("number");
    const written = /([\d,]+)\s+comments?/.exec(unit.innerText.replace(/\s+/g, " "))?.[1]?.replace(/,/g, "");
    return {
      id: tracked.post?.id ?? null,
      title: (title?.getAttribute("aria-label") || title?.textContent || "").trim(),
      url: title?.href ?? null,
      author: tracked.profile?.name ?? null,
      subreddit: tracked.subreddit?.name ?? null,
      createdAt: iso(unit.querySelector("faceplate-timeago")?.getAttribute("ts")),
      comments: Number(counted ?? written) || 0,
      snippet: "",
    };
  });
}

/** Runs in the page. One www.reddit.com thread; `me` is your username. */
export function readThread(me) {
  const post = document.querySelector("shreddit-post");
  if (!post) return { missing: true };
  const iso = (s) => {
    const d = new Date(String(s ?? "").replace(/(\.\d{3})\d+/, "$1").replace(/\+0000$/, "Z"));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  const op = post.getAttribute("author");
  const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
  const all = [...document.querySelectorAll("shreddit-comment")];
  const text = (c, max) => ((c.querySelector(':scope > [slot="comment"]') ?? c.querySelector('[slot="comment"]'))?.innerText ?? "").trim().slice(0, max);
  const kids = (c) => all.filter((k) => k.parentElement?.closest("shreddit-comment") === c);
  const title = post.getAttribute("post-title") ?? "";
  const body = (post.querySelector('[slot="text-body"]')?.innerText ?? "").trim();

  return {
    id: post.getAttribute("id"),
    title,
    author: op,
    subreddit: post.getAttribute("subreddit-name"),
    flair: post.querySelector("shreddit-post-flair")?.innerText.trim() || null,
    createdAt: iso(post.getAttribute("created-timestamp")),
    score: Number(post.getAttribute("score")) || 0,
    comments: Number(post.getAttribute("comment-count")) || all.length,
    body: body.slice(0, 4000),
    removed: /^\[(removed|deleted)\]/i.test(title) || /^\[(removed|deleted)\]$/i.test(body) || op === "[deleted]",
    canComment: Boolean(document.querySelector("comment-composer-host")),
    opComments: all.filter((c) => same(c.getAttribute("author"), op)).length,
    topComments: all
      .filter((c) => !c.parentElement?.closest("shreddit-comment"))
      .slice(0, 12)
      .map((c) => ({ author: c.getAttribute("author"), text: text(c, 400), opReplied: kids(c).some((k) => same(k.getAttribute("author"), op)) })),
    mine: all
      .filter((c) => same(c.getAttribute("author"), me))
      .map((c) => ({
        id: c.getAttribute("thingid"),
        at: iso(c.getAttribute("created")),
        text: text(c, 800),
        opReplies: kids(c)
          .filter((k) => same(k.getAttribute("author"), op))
          .map((k) => ({ id: k.getAttribute("thingid"), at: iso(k.getAttribute("created")), text: text(k, 800) })),
      })),
  };
}
