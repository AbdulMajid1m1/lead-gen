/**
 * What the scout searches for and how hard it works. Every run reads this
 * file, so edit the searches here rather than in the code.
 *
 * Searches run on old.reddit.com (plain HTML, real "next" pages), newest
 * first, past week. `sub` restricts a search to those subreddits, joined
 * with "+". Reddit search understands quotes and upper-case OR.
 */
export const SEARCHES = [
  { q: '"custom CRM" OR "build a CRM" OR "CRM developer" OR "CRM for my"' },
  { q: '"HR software" OR HRMS OR HRIS OR "payroll software" OR "employee management system"' },
  { q: '"AI automation" OR "automate my business" OR "AI agent for my" OR "automation expert"' },
  { q: '"n8n developer" OR "n8n expert" OR "zapier expert" OR "make.com expert"' },
  { sub: "forhire+hiring+freelance_forhire+jobbit", q: "hiring CRM OR automation OR HR OR dashboard OR AI OR portal" },
  { sub: "smallbusiness+Entrepreneur+startups+sweatystartup", q: 'CRM OR automate OR "HR software" OR "custom software" OR spreadsheet' },
  { sub: "n8n+automation+AI_Agents+zapier+nocode", q: 'hire OR hiring OR "looking for" OR "need someone" OR paid' },
  { sub: "humanresources+HRIS+askhr", q: "software OR system OR recommend OR spreadsheet" },
  { sub: "CRM+sales+realestate+msp", q: '"looking for" OR recommend OR build OR custom' },
];

export const LIMITS = {
  pagesPerSearch: 2, // 25 results a page
  maxAgeHours: 7 * 24, // older asks are usually filled
  maxNewThreads: 40, // new posts opened and analysed per run
  maxRechecks: 20, // posts you commented on, re-read for OP replies
  trackDays: 10, // how long a post you commented on is watched
  nudgeAfterDays: 3, // one follow-up, no sooner
  // A pause between page loads, so a run reads Reddit like one person does
  // and stays light on it. A full run is roughly 10 minutes.
  minDelayMs: 4000,
  maxDelayMs: 9000,
};

export const ANALYSIS = {
  model: process.env.SCOUT_MODEL || "opus",
  postsPerCall: 8,
  parallelCalls: 2,
};
