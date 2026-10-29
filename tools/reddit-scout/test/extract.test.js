import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { searchUrl, toOld, toWww, postId, isOffer, pickNew, pickRechecks, readSearchPage, readThread } from "../extract.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test("searchUrl builds old.reddit searches, newest first, past week", () => {
  assert.equal(searchUrl({ q: '"custom CRM"' }), "https://old.reddit.com/search?q=%22custom+CRM%22&sort=new&t=week");
  assert.equal(searchUrl({ sub: "forhire+hiring", q: "CRM" }), "https://old.reddit.com/r/forhire+hiring/search?q=CRM&sort=new&t=week&restrict_sr=on");
});

test("toOld / toWww swap only the host; postId reads the thread id", () => {
  const u = "https://www.reddit.com/r/smallbusiness/comments/1abcxyz/need_a_crm/";
  assert.equal(toOld(u), "https://old.reddit.com/r/smallbusiness/comments/1abcxyz/need_a_crm/");
  assert.equal(toWww(toOld(u)), u);
  assert.equal(postId(u), "t3_1abcxyz");
  assert.equal(postId("https://example.com/"), null);
});

test("isOffer catches freelancers advertising, not buyers", () => {
  for (const t of ["[For Hire] Full-stack dev, CRMs", "[FOR HIRE] n8n expert", "For hire: AI automation", "(for hire) Zapier"]) assert.ok(isOffer(t), t);
  for (const t of ["[Hiring] CRM developer for 10-person firm", "Need someone to build an HR system", "What CRM do you use?"]) assert.ok(!isOffer(t), t);
});

test("pickNew drops seen, old, offers and bots, newest first, capped", () => {
  const found = [
    { id: "t3_a", title: "[Hiring] CRM build", author: "x", createdAt: hoursAgo(5) },
    { id: "t3_b", title: "[For Hire] dev", author: "y", createdAt: hoursAgo(1) },
    { id: "t3_c", title: "Need HR software", author: "z", createdAt: hoursAgo(2) },
    { id: "t3_d", title: "Old ask", author: "w", createdAt: hoursAgo(24 * 9) },
    { id: "t3_e", title: "Seen already", author: "v", createdAt: hoursAgo(3) },
    { id: "t3_f", title: "Weekly thread", author: "AutoModerator", createdAt: hoursAgo(1) },
  ];
  const state = { posts: { t3_e: { firstSeenAt: hoursAgo(3) } } };
  const picked = pickNew(found, state, { now: NOW, maxAgeHours: 168, maxNewThreads: 10 });
  assert.deepEqual(picked.map((p) => p.id), ["t3_c", "t3_a"]);
  assert.equal(pickNew(found, state, { now: NOW, maxAgeHours: 168, maxNewThreads: 1 }).length, 1);
});

test("pickRechecks watches recent pursue/maybe posts that are not closed", () => {
  const state = {
    posts: {
      t3_a: { verdict: "pursue", firstSeenAt: hoursAgo(30), url: "u1", title: "a" },
      t3_b: { verdict: "skip", firstSeenAt: hoursAgo(30), url: "u2", title: "b" },
      t3_c: { verdict: "maybe", firstSeenAt: hoursAgo(24 * 12), url: "u3", title: "c" },
      t3_d: { verdict: "maybe", firstSeenAt: hoursAgo(10), url: "u4", title: "d", closed: true },
    },
  };
  assert.deepEqual(pickRechecks(state, { now: NOW, trackDays: 10, maxRechecks: 20 }).map((p) => p.id), ["t3_a"]);
});

// The readers run in a real Chrome page against HTML shaped like old.reddit.
let browser;
let page;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
});
after(async () => browser?.close());

const SEARCH_HTML = `<html><head><title>reddit.com: search results</title></head><body>
<div id="header-bottom-right"><span class="user"><a href="https://old.reddit.com/user/abdul_dev/">abdul_dev</a></span></div>
<div class="search-result-listing">
 <div class="search-result search-result-link" data-fullname="t3_1aaa">
  <header class="search-result-header"><a href="https://old.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/" class="search-title">Need a CRM for my 8-person roofing company</a></header>
  <div class="search-result-meta"><span class="search-score">4 points</span>
   <a href="https://old.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/" class="search-comments">6 comments</a>
   <span class="search-time">submitted <time datetime="2026-10-29T08:00:00+00:00">4 hours ago</time></span>
   <span class="search-author">by <a href="https://old.reddit.com/user/roofguy" class="author">roofguy</a></span>
   to <a href="https://old.reddit.com/r/smallbusiness/" class="search-subreddit-link">r/smallbusiness</a></div>
  <div class="search-result-body"><div class="md"><p>We track jobs in spreadsheets and it is a mess.</p></div></div>
 </div>
 <div class="search-result search-result-link" data-fullname="t3_1bbb">
  <header class="search-result-header"><a href="https://example.com/blog" class="search-title">Link post</a></header>
  <div class="search-result-meta"><a href="https://old.reddit.com/r/CRM/comments/1bbb/link_post/" class="search-comments">comment</a>
   <span class="search-time"><time datetime="2026-10-28T10:00:00+00:00">1 day ago</time></span>
   <span class="search-author"><a class="author">vendor</a></span> <a class="search-subreddit-link">r/CRM</a></div>
 </div>
</div>
<div class="nav-buttons"><span class="nextprev">view more: <a href="https://old.reddit.com/search?q=crm&amp;after=t3_1bbb" rel="nofollow next">next ›</a></span></div>
</body></html>`;

test("readSearchPage reads results, the signed-in user and the next page", async () => {
  await page.setContent(SEARCH_HTML);
  const r = await page.evaluate(readSearchPage);
  assert.equal(r.blocked, null);
  assert.equal(r.me, "abdul_dev");
  assert.equal(r.next, "https://old.reddit.com/search?q=crm&after=t3_1bbb");
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.results[0], {
    id: "t3_1aaa",
    title: "Need a CRM for my 8-person roofing company",
    url: "https://old.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/",
    author: "roofguy",
    subreddit: "smallbusiness",
    createdAt: "2026-10-29T08:00:00+00:00",
    comments: 6,
    snippet: "We track jobs in spreadsheets and it is a mess.",
  });
  assert.equal(r.results[1].url, "https://old.reddit.com/r/CRM/comments/1bbb/link_post/", "link posts use the comments link");
  assert.equal(r.results[1].comments, 0);
});

test("readSearchPage reports a logged-out header and Reddit's block page", async () => {
  await page.setContent(`<div id="header-bottom-right"><span class="user">Want to join? <a href="https://old.reddit.com/login">Log in</a></span></div>`);
  assert.equal((await page.evaluate(readSearchPage)).me, null);
  await page.setContent(`<title>Blocked</title><body>whoa there, pardner! Your request has been blocked.</body>`);
  assert.equal((await page.evaluate(readSearchPage)).blocked, "blocked");
});

const comment = (id, author, text, kids = "") => `
<div class="thing comment" data-fullname="${id}" data-author="${author}">
 <div class="entry"><p class="tagline"><a class="author">${author}</a> <time datetime="2026-10-26T09:00:00+00:00">3 days ago</time></p>
  <form class="usertext"><div class="usertext-body"><div class="md"><p>${text}</p></div></div></form></div>
 <div class="child">${kids ? `<div class="sitetable listing">${kids}</div>` : ""}</div>
</div>`;

const THREAD_HTML = `<html><head><title>Need a CRM</title></head><body>
<div id="siteTable" class="sitetable linklisting">
 <div class="thing link self" data-fullname="t3_1aaa" data-author="roofguy" data-subreddit="smallbusiness" data-timestamp="1761724800000" data-score="4" data-comments-count="3">
  <p class="title"><a class="title" href="https://old.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/">Need a CRM for my 8-person roofing company</a> <span class="linkflairlabel">Help</span></p>
  <div class="expando"><form class="usertext"><div class="usertext-body"><div class="md"><p>We track jobs in spreadsheets. Budget around $3k.</p></div></div></form></div>
 </div>
</div>
<div class="commentarea">
 <form class="usertext cloneable"><textarea name="text"></textarea></form>
 <div class="sitetable nestedlisting">
  ${comment("t1_c1", "Abdul_Dev", "Before buying anything, map the job stages.", comment("t1_c2", "roofguy", "Good point, we have 5 stages."))}
  ${comment("t1_c3", "someone", "Try HubSpot free.")}
 </div>
</div></body></html>`;

test("readThread reads the post, top comments and your comments with OP's replies", async () => {
  await page.setContent(THREAD_HTML);
  const t = await page.evaluate(readThread, "abdul_dev");
  assert.equal(t.blocked, null);
  assert.equal(t.id, "t3_1aaa");
  assert.equal(t.author, "roofguy");
  assert.equal(t.subreddit, "smallbusiness");
  assert.equal(t.flair, "Help");
  assert.equal(t.createdAt, new Date(1761724800000).toISOString());
  assert.equal(t.body, "We track jobs in spreadsheets. Budget around $3k.");
  assert.equal(t.canComment, true);
  assert.equal(t.removed, false);
  assert.equal(t.opComments, 1);
  assert.deepEqual(t.topComments.map((c) => [c.author, c.opReplied]), [["Abdul_Dev", true], ["someone", false]]);
  assert.equal(t.mine.length, 1);
  assert.equal(t.mine[0].text, "Before buying anything, map the job stages.");
  assert.deepEqual(t.mine[0].opReplies, [{ id: "t1_c2", at: "2026-10-26T09:00:00+00:00", text: "Good point, we have 5 stages." }]);
});

test("readThread notices a thread it cannot read or comment on", async () => {
  await page.setContent(`<div id="siteTable"></div>`);
  assert.deepEqual(await page.evaluate(readThread, "abdul_dev"), { blocked: null, missing: true });
  await page.setContent(THREAD_HTML.replace('<form class="usertext cloneable"><textarea name="text"></textarea></form>', ""));
  assert.equal((await page.evaluate(readThread, "abdul_dev")).canComment, false);
});
