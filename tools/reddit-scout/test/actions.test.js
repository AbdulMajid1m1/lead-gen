import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../scout.js";
import { postable, buildItems } from "../actions.js";
import { renderReport } from "../report.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 24 * 3600000).toISOString();

const watched = (over = {}) => ({ kind: "recheck", id: "t3_w", canComment: true, mine: [], ...over });

test("plan: new posts are judged; a watched thread you never joined is closed after a few days", () => {
  const state = { posts: { t3_w: { firstSeenAt: daysAgo(4) } } };
  const { toJudge } = plan([{ kind: "new", id: "t3_n" }, watched()], state, NOW);
  assert.deepEqual(toJudge, [{ id: "t3_n", mode: "new" }]);
  assert.equal(state.posts.t3_w.closed, true);
});

test("plan: OP answering you drafts a reply under OP's latest answer, once per new answer", () => {
  const mine = [{ id: "t1_me", at: daysAgo(2), text: "x", opReplies: [{ id: "t1_a", at: daysAgo(1.5) }, { id: "t1_b", at: daysAgo(1) }] }];
  const state = { posts: { t3_w: { firstSeenAt: daysAgo(2) } } };
  assert.deepEqual(plan([watched({ mine })], state, NOW).toJudge, [{ id: "t3_w", mode: "respond", parentId: "t1_b", opReplies: 2 }]);
  state.posts.t3_w.opRepliesSeen = 2;
  assert.deepEqual(plan([watched({ mine })], state, NOW).toJudge, []);
});

test("plan: silence for 3+ days drafts one follow-up under your comment, then never again", () => {
  const mine = [{ id: "t1_me", at: daysAgo(3.5), text: "x", opReplies: [] }];
  const state = { posts: { t3_w: { firstSeenAt: daysAgo(4) } } };
  assert.deepEqual(plan([watched({ mine })], state, NOW).toJudge, [{ id: "t3_w", mode: "nudge", parentId: "t1_me" }]);
  assert.deepEqual(plan([watched({ mine })], state, NOW).toJudge, []);
  const early = { posts: { t3_w: { firstSeenAt: daysAgo(2) } } };
  assert.deepEqual(plan([watched({ mine: [{ ...mine[0], at: daysAgo(1) }] })], early, NOW).toJudge, []);
});

const a = (over = {}) => ({ verdict: "pursue", action: "comment", comment: "C", reply: "", dm: "", score: 70, ...over });

test("postable: a comment for new posts, a reply for threads you are in, nothing for skips or DMs", () => {
  assert.deepEqual(postable({ mode: "new" }, a()), { kind: "comment", text: "C", parentId: null });
  assert.equal(postable({ mode: "new" }, a({ action: "skip" })), null);
  assert.equal(postable({ mode: "new" }, a({ comment: "", dm: "D" })), null);
  assert.deepEqual(postable({ mode: "respond", parentId: "t1_b" }, a({ action: "reply now", reply: "R" })), { kind: "reply", text: "R", parentId: "t1_b" });
  assert.equal(postable({ mode: "nudge" }, a({ action: "reply now", reply: "R" })), null, "a reply needs a parent");
});

test("the report shows Post buttons only when served for review, and never for DMs or posted drafts", () => {
  const run = {
    threads: [
      { id: "t3_a", title: "Need a CRM", url: "https://old.reddit.com/r/x/comments/a/y/", subreddit: "x", author: "op" },
      { id: "t3_b", title: "Hiring HR dev", url: "https://old.reddit.com/r/forhire/comments/b/y/", subreddit: "forhire", author: "op2" },
    ],
    toJudge: [{ id: "t3_a", mode: "new" }, { id: "t3_b", mode: "new" }],
  };
  const analyses = { t3_a: a(), t3_b: a({ action: "comment, then DM", dm: "Hi" }) };
  const posted = { t3_b: { at: daysAgo(0), kind: "comment", text: "C", permalink: "https://www.reddit.com/r/forhire/comments/b/y/c1/" } };
  const items = buildItems({ run, analyses, posted });
  const args = { items, me: "me", startedAt: daysAgo(0), stats: { searched: 2, opened: 2, rechecked: 0 }, now: NOW };
  assert.equal((renderReport(args).match(/class="post"/g) ?? []).length, 0);
  const live = renderReport({ ...args, interactive: { token: "tok" } });
  assert.equal((live.match(/class="post"/g) ?? []).length, 1, "t3_b is already posted");
  assert.match(live, /data-id="t3_a"/);
  assert.match(live, /message\/compose\/\?to=op2/);
  assert.match(live, /View|view/);
});
