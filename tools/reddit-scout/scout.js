import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SEARCHES, LIMITS } from "./config.js";
import { searchUrl, toWww, postId, pickNew, pickRechecks, blockReason, readSearchPage, readThread } from "./extract.js";
import { analyzePosts, triagePosts } from "./analyze.js";
import { renderReport } from "./report.js";
import { openScoutBrowser, ScoutStop as Stop } from "./browser.js";
import { loadRun, buildItems } from "./actions.js";
import { loadState, saveState, newRunDir, latestRunDir, readJson, writeJson } from "./store.js";

/**
 * npm start                  browse Reddit, judge new posts, open the report
 * npm run scout              browse only (no Claude)
 * npm run analyze            judge whatever the last run collected but did not judge
 */

const args = new Set(process.argv.slice(2));
const DAY = 24 * 3600 * 1000;
const log = (...m) => console.log(...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(LIMITS.minDelayMs + Math.random() * (LIMITS.maxDelayMs - LIMITS.minDelayMs));

const STOP_HELP = {
  login: "Reddit shows you as logged out. Run `npm run login`, sign in, then run again.",
  blocked: "Reddit is refusing this browser right now. Wait a couple of hours before the next run.",
  captcha: "Reddit is showing a CAPTCHA. The scout stops there; it does not solve them.",
  ratelimited: "Reddit stopped serving pages (too many requests). Wait a couple of hours before the next run.",
};

const label = (s) => (s.sub ? `r/${s.sub.split("+")[0]}+…` : "all of Reddit") + ` "${s.q.slice(0, 40)}"`;

/** Opens the scout's Chrome profile, runs every search, reads the threads worth reading. */
async function browse(state, runDir) {
  const context = await openScoutBrowser();
  const page = context.pages()[0] ?? (await context.newPage());
  // Kept so a selector that stops matching can be fixed from a real page.
  const keepPage = async (name) => fs.writeFileSync(path.join(runDir, name), await page.content());
  // One page failing is usually that thread. Two in a row means Reddit wants a
  // rest, so stop there and keep what has been read.
  let failedInARow = 0;
  const visit = async (url, debugName) => {
    let res;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      failedInARow = 0;
    } catch (e) {
      if (++failedInARow >= 2) throw new Stop(STOP_HELP.ratelimited);
      log(`  could not load ${url.slice(0, 80)} (${e.message.split("\n")[0].slice(0, 60)}), skipping`);
      return false;
    }
    if (res?.status() === 429) throw new Stop(STOP_HELP.ratelimited);
    const blocked = await page.evaluate(blockReason);
    if (blocked) {
      await keepPage(debugName);
      throw new Stop(STOP_HELP[blocked]);
    }
    return true;
  };

  const out = { me: null, threads: [], stats: { searched: 0, opened: 0, rechecked: 0, stoppedEarly: null } };
  const found = new Map();
  try {
    // The front page refreshes the short-lived token_v2 cookie.
    await visit("https://www.reddit.com/", "debug-search.html");
    await pause();
    await visit("https://www.reddit.com/user/me/", "debug-search.html");
    out.me = /\/user\/([^/]+)/.exec(page.url())?.[1] ?? null;
    if (!out.me || out.me === "me") {
      await keepPage("debug-search.html");
      throw new Stop(STOP_HELP.login);
    }
    log(`Signed in as u/${out.me}`);
    await pause();

    for (const s of SEARCHES) {
      if (!(await visit(searchUrl(s), "debug-search.html"))) {
        await pause();
        continue;
      }
      await page.waitForSelector('[data-testid="search-post-unit"]', { timeout: 7000 }).catch(() => {});
      for (let i = 0; i < LIMITS.scrollsPerSearch; i++) {
        await page.mouse.wheel(0, 2500);
        await sleep(1800);
      }
      const results = await page.evaluate(readSearchPage);
      if (!found.size && !results.length) await keepPage("debug-search.html");
      for (const x of results) {
        const id = x.id || postId(x.url);
        if (id && !found.has(id)) found.set(id, { ...x, id });
      }
      out.stats.searched += results.length;
      log(`  ${label(s)}: ${results.length} results`);
      await pause();
    }

    // Keyword search drags in plenty of noise, so Claude screens titles first
    // and only the plausible asks get opened. Screened-out posts are
    // remembered so the next run does not screen them again.
    const candidates = pickNew([...found.values()], state, { ...LIMITS, maxNewThreads: Infinity });
    let chosen = candidates.slice(0, LIMITS.maxNewThreads);
    if (candidates.length) {
      log(`\nScreening ${candidates.length} new search results with Claude…`);
      try {
        const keep = await triagePosts(candidates, { limit: LIMITS.maxNewThreads });
        const why = new Map(keep.map((k) => [k.id, k.why]));
        chosen = keep.map((k) => candidates.find((c) => c.id === k.id));
        for (const c of candidates) {
          if (why.has(c.id)) continue;
          state.posts[c.id] = { firstSeenAt: new Date().toISOString(), url: c.url, title: c.title, subreddit: c.subreddit, verdict: "skip", screenedOut: true };
        }
        out.candidates = candidates.map((c) => ({ id: c.id, subreddit: c.subreddit, title: c.title, kept: why.get(c.id) ?? null }));
      } catch (e) {
        log(`  screening failed (${e.message}); opening the newest ${chosen.length} instead`);
      }
    }
    const fresh = chosen.map((p) => ({ ...p, kind: "new" }));
    const rechecks = pickRechecks(state, LIMITS)
      .filter((r) => !fresh.some((f) => f.id === r.id))
      .map((r) => ({ ...r, kind: "recheck" }));
    log(`${found.size} unique posts, ${fresh.length} worth opening, ${rechecks.length} watched threads to re-read`);

    for (const p of [...fresh, ...rechecks]) {
      if (!(await visit(toWww(p.url), "debug-thread.html"))) {
        await pause();
        continue;
      }
      await page.waitForSelector("shreddit-post", { timeout: 7000 }).catch(() => {});
      await page.waitForSelector("shreddit-comment", { timeout: 2500 }).catch(() => {});
      const t = await page.evaluate(readThread, out.me);
      if (t.missing) {
        if (!out.threads.length) await keepPage("debug-thread.html");
        log(`  gone: ${p.title.slice(0, 70)}`);
      } else {
        out.threads.push({ ...p, ...t, id: p.id, url: p.url, title: t.title || p.title, snippet: p.snippet });
        out.stats[p.kind === "new" ? "opened" : "rechecked"] += 1;
        log(`  read ${p.kind === "new" ? "" : "(watched) "}r/${t.subreddit}: ${(t.title || p.title).slice(0, 70)}`);
      }
      await pause();
    }
  } catch (e) {
    // Whatever went wrong, what was already read still gets judged.
    if (!(e instanceof Stop)) console.error(e);
    out.stats.stoppedEarly = e.message.split("\n")[0];
    log(`\nStopped: ${out.stats.stoppedEarly}`);
  } finally {
    await context.close();
  }
  return out;
}

/**
 * Decides what each thread needs. New posts get judged. In a thread you are
 * already in, an answer from OP gets a reply drafted under it; silence for
 * a few days gets the one follow-up drafted under your own comment; never
 * having commented ends the watch.
 */
export function plan(threads, state, now) {
  const toJudge = [];
  for (const t of threads) {
    if (t.kind === "new") {
      toJudge.push({ id: t.id, mode: "new" });
      continue;
    }
    const s = state.posts[t.id];
    s.lastCheckedAt = new Date(now).toISOString();
    const opReplies = t.mine.flatMap((c) => c.opReplies);
    if (!t.mine.length) {
      if (!t.canComment || now - Date.parse(s.firstSeenAt) > LIMITS.nudgeAfterDays * DAY) s.closed = true;
    } else if (opReplies.length > (s.opRepliesSeen ?? 0)) {
      const latest = opReplies.reduce((a, b) => (Date.parse(b.at) > Date.parse(a.at) ? b : a));
      toJudge.push({ id: t.id, mode: "respond", parentId: latest.id, opReplies: opReplies.length });
    } else if (!s.nudged && !opReplies.length) {
      const first = t.mine.reduce((a, b) => (Date.parse(b.at) < Date.parse(a.at) ? b : a));
      if (now - (Date.parse(first.at) || now) >= LIMITS.nudgeAfterDays * DAY) {
        toJudge.push({ id: t.id, mode: "nudge", parentId: first.id });
        s.nudged = true;
      }
    }
  }
  return { toJudge };
}

const openFile = (file) => spawn("open", [file], { stdio: "ignore", detached: true }).unref();

async function main() {
  const now = Date.now();
  const state = loadState();
  let runDir;
  let run;
  if (args.has("--analyze-only")) {
    runDir = latestRunDir();
    if (!runDir) throw new Stop("No run to analyse yet. Run `npm start`.");
    run = readJson(path.join(runDir, "posts.json"));
    log(`Re-judging ${runDir}`);
  } else {
    runDir = newRunDir(new Date(now));
    log(`Browsing Reddit as the scout profile. Leave the Chrome window alone until it closes.\n`);
    const data = await browse(state, runDir);
    run = { ...data, startedAt: new Date(now).toISOString(), ...plan(data.threads, state, now) };
    writeJson(path.join(runDir, "posts.json"), run);
    saveState(state, now);
  }

  if (args.has("--no-analyze")) {
    log(`\nSaved ${run.threads.length} threads to ${runDir}. Run \`npm run analyze\` to judge them.`);
    return;
  }

  const byId = new Map(run.threads.map((t) => [t.id, t]));
  const analysisFile = path.join(runDir, "analysis.json");
  const analyses = fs.existsSync(analysisFile) ? readJson(analysisFile) : {};
  const pending = run.toJudge.filter((j) => !analyses[j.id]).map((j) => ({ ...byId.get(j.id), mode: j.mode }));
  if (pending.length) {
    log(`\nAsking Claude about ${pending.length} posts…`);
    const fresh = await analyzePosts(pending, { me: run.me, now });
    Object.assign(analyses, Object.fromEntries(fresh));
    writeJson(analysisFile, analyses);
  }

  for (const j of run.toJudge) {
    const a = analyses[j.id];
    const t = byId.get(j.id);
    if (!a) continue;
    const s = (state.posts[j.id] ??= { firstSeenAt: run.startedAt, url: t.url, title: t.title, subreddit: t.subreddit });
    if (j.mode === "respond") s.opRepliesSeen = j.opReplies;
    else if (j.mode === "new") Object.assign(s, { verdict: a.verdict, score: a.score, followUp: a.followUp });
  }
  saveState(state);

  const items = buildItems(loadRun(runDir));
  const reportFile = path.join(runDir, "report.html");
  fs.writeFileSync(reportFile, renderReport({ items, me: run.me, startedAt: run.startedAt, stats: run.stats, now }));

  const count = (kind, v) => items.filter((i) => i.kind === kind && (!v || i.a?.verdict === v)).length;
  log(`\nReply now: ${count("respond")} · act on: ${count("new", "pursue")} · follow-ups due: ${count("nudge")} · maybe: ${count("new", "maybe")} · skipped: ${count("new", "skip")}`);
  log(`Report: ${reportFile}`);
  log(`To post from the report: npm run review`);
  if (!args.has("--no-open")) openFile(reportFile);
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((e) => {
    console.error(e instanceof Stop ? e.message : e);
    process.exitCode = 1;
  });
}
