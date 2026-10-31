import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { searchUrl, toWww, postId, isOffer, pickNew, pickRechecks, blockReason, readSearchPage, readThread } from "../extract.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

test("searchUrl builds www searches, newest first, past week", () => {
  assert.equal(searchUrl({ q: '"custom CRM"' }), "https://www.reddit.com/search/?q=%22custom+CRM%22&type=posts&sort=new&t=week");
  assert.equal(searchUrl({ sub: "forhire", q: "hiring" }), "https://www.reddit.com/r/forhire/search/?q=hiring&type=posts&sort=new&t=week");
});

test("toWww moves stored old.reddit links to the main site; postId reads the thread id", () => {
  const u = "https://old.reddit.com/r/smallbusiness/comments/1abcxyz/need_a_crm/";
  assert.equal(toWww(u), "https://www.reddit.com/r/smallbusiness/comments/1abcxyz/need_a_crm/");
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

// The readers run in a real Chrome page against HTML shaped like www.reddit.com.
let browser;
let page;
before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage();
});
after(async () => browser?.close());

const card = (id, title, href, sub, author, ts, number) => `
<div data-testid="search-post-unit">
 <search-telemetry-tracker data-faceplate-tracking-context='${JSON.stringify({ post: { id: `t3_${id}`, title }, profile: { name: author }, subreddit: { name: sub } })}'>
  <h2><a data-testid="post-title" href="${href}" aria-label="${title}"><faceplate-screen-reader-content>${title}</faceplate-screen-reader-content></a></h2>
 </search-telemetry-tracker>
 <div data-testid="sdui-post-unit"><faceplate-timeago ts="${ts}">4h ago</faceplate-timeago>
  <faceplate-number number="4">4</faceplate-number> votes · ${number === null ? "2 comments" : `<faceplate-number number="${number}">${number}</faceplate-number> comments`}</div>
</div>`;

test("readSearchPage reads post cards, with Reddit's six-digit timestamps", async () => {
  await page.setContent(`<shreddit-app>${card("1aaa", "Need a CRM for my 8-person roofing company", "https://www.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/", "smallbusiness", "roofguy", "2026-10-29T08:00:00.753000+0000", 6)}${card("1bbb", "Second", "https://www.reddit.com/r/CRM/comments/1bbb/second/", "CRM", "vendor", "not-a-date", null)}</shreddit-app>`);
  const r = await page.evaluate(readSearchPage);
  assert.deepEqual(r[0], {
    id: "t3_1aaa",
    title: "Need a CRM for my 8-person roofing company",
    url: "https://www.reddit.com/r/smallbusiness/comments/1aaa/need_a_crm/",
    author: "roofguy",
    subreddit: "smallbusiness",
    createdAt: "2026-10-29T08:00:00.753Z",
    comments: 6,
    snippet: "",
  });
  assert.equal(r[1].createdAt, null);
});

test("blockReason ignores the invisible reCAPTCHA and post text, and catches real blocks", async () => {
  await page.setContent(`<shreddit-app>Too many requests in my CRM</shreddit-app><iframe src="https://www.google.com/recaptcha/api2/anchor" width="256" height="60"></iframe>`);
  assert.equal(await page.evaluate(blockReason), null);
  await page.setContent(`<shreddit-app></shreddit-app><iframe src="https://www.google.com/recaptcha/api2/bframe" width="400" height="580"></iframe>`);
  assert.equal(await page.evaluate(blockReason), "captcha");
  await page.setContent(`<title>Blocked</title><body>You've been blocked by network security.</body>`);
  assert.equal(await page.evaluate(blockReason), "blocked");
});

const comment = (id, author, text, kids = "") => `
<shreddit-comment thingid="${id}" author="${author}" created="2026-10-26T09:00:00.000000+0000">
 <div slot="comment"><p>${text}</p></div>
 ${kids}
</shreddit-comment>`;

const THREAD_HTML = `<shreddit-app>
<shreddit-post id="t3_1aaa" author="roofguy" subreddit-name="smallbusiness" post-title="Need a CRM for my 8-person roofing company" created-timestamp="2026-10-29T08:00:00.000000+0000" score="4" comment-count="3">
 <shreddit-post-flair>Help</shreddit-post-flair>
 <div slot="text-body"><p>We track jobs in spreadsheets. Budget around $3k.</p></div>
</shreddit-post>
<comment-composer-host></comment-composer-host>
<shreddit-comment-tree>
 ${comment("t1_c1", "Abdul_Dev", "Before buying anything, map the job stages.", comment("t1_c2", "roofguy", "Good point, we have 5 stages."))}
 ${comment("t1_c3", "someone", "Try HubSpot free.")}
</shreddit-comment-tree></shreddit-app>`;

test("readThread reads the post, top comments and your comments with OP's replies", async () => {
  await page.setContent(THREAD_HTML);
  const t = await page.evaluate(readThread, "abdul_dev");
  assert.equal(t.id, "t3_1aaa");
  assert.equal(t.author, "roofguy");
  assert.equal(t.subreddit, "smallbusiness");
  assert.equal(t.flair, "Help");
  assert.equal(t.createdAt, "2026-10-29T08:00:00.000Z");
  assert.equal(t.comments, 3);
  assert.equal(t.body, "We track jobs in spreadsheets. Budget around $3k.");
  assert.equal(t.canComment, true);
  assert.equal(t.removed, false);
  assert.equal(t.opComments, 1);
  assert.deepEqual(t.topComments.map((c) => [c.author, c.opReplied]), [["Abdul_Dev", true], ["someone", false]]);
  assert.equal(t.mine.length, 1);
  assert.equal(t.mine[0].id, "t1_c1");
  assert.equal(t.mine[0].text, "Before buying anything, map the job stages.");
  assert.deepEqual(t.mine[0].opReplies, [{ id: "t1_c2", at: "2026-10-26T09:00:00.000Z", text: "Good point, we have 5 stages." }]);
});

test("readThread notices a thread it cannot read or comment on", async () => {
  await page.setContent(`<shreddit-app></shreddit-app>`);
  assert.deepEqual(await page.evaluate(readThread, "abdul_dev"), { missing: true });
  await page.setContent(THREAD_HTML.replace("<comment-composer-host></comment-composer-host>", ""));
  assert.equal((await page.evaluate(readThread, "abdul_dev")).canComment, false);
});
