/**
 * What the scout searches for and how hard it works. Every run reads this
 * file, so edit the searches here rather than in the code.
 *
 * Searches run on www.reddit.com, newest first, past week. Reddit's search
 * does not accept several subreddits joined with "+" any more, so each
 * subreddit is its own search, one page load each.
 */
const bySubreddit = (q, subs) => subs.map((sub) => ({ sub, q }));

export const SEARCHES = [
  { q: "custom CRM" },
  { q: "need a CRM" },
  { q: "CRM developer" },
  { q: "HR software small business" },
  { q: "automate my business" },
  { q: "hire n8n developer" },
  ...bySubreddit("hiring", ["forhire", "hiring"]),
  ...bySubreddit("CRM", ["smallbusiness", "Entrepreneur", "CRM", "sales", "realestate", "PropertyManagement"]),
  ...bySubreddit("automate", ["smallbusiness", "n8n", "automation", "AI_Agents"]),
  ...bySubreddit("software", ["humanresources"]),
];

export const LIMITS = {
  scrollsPerSearch: 1, // search results load as you scroll
  maxAgeHours: 4 * 24, // live runs: older threads were dead or crowded
  maxNewThreads: 15, // new posts opened and analysed per run
  maxRechecks: 5, // threads worth pursuing, re-read for OP replies
  trackDays: 10, // how long a post you commented on is watched
  nudgeAfterDays: 3, // one follow-up, no sooner
  // A pause between page loads. Reddit refused the account after about 120
  // pages in half an hour, so keep a run near 40 pages and run it once a day.
  minDelayMs: 8000,
  maxDelayMs: 15000,
};

// A new account's comments get removed if they look promotional, so until this
// date drafts just help and leave out what he sells. Posts that ask for offers
// are the exception. Clear it once the account has about 100 karma.
export const ACCOUNT = {
  warmUpUntil: process.env.SCOUT_WARMUP_UNTIL ?? "2026-11-12",
};

export const ANALYSIS = {
  model: process.env.SCOUT_MODEL || "opus",
  triageModel: process.env.SCOUT_TRIAGE_MODEL || "sonnet",
  postsPerCall: 8,
  parallelCalls: 2,
};
