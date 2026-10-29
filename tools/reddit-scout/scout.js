import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { SEARCHES, LIMITS } from "./config.js";
import { searchUrl, toOld, postId, pickNew, pickRechecks, readSearchPage, readThread } from "./extract.js";
import { analyzePosts } from "./analyze.js";
import { renderReport } from "./report.js";
import { PROFILE_DIR, loadState, saveState, newRunDir, latestRunDir, readJson, writeJson } from "./store.js";

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

class Stop extends Error {}

const STOP_HELP = {
  login: "Reddit shows you as logged out. Run `npm run login`, sign in, quit that window, then run again.",
  blocked: "Reddit is refusing this browser right now. Wait a couple of hours before the next run.",
  captcha: "Reddit is showing a CAPTCHA. The scout stops there; it does not solve them.",
  ratelimited: "Reddit answered 429 (too many requests). Wait an hour before the next run.",
};

const label = (s) => (s.sub ? `r/${s.sub.split("+")[0]}+…` : "all of Reddit") + ` "${s.q.slice(0, 40)}"`;

/** Opens the scout's Chrome profile, runs every search, reads the threads worth reading. */
async function browse(state, runDir) {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
  } catch (e) {
    if (/ProcessSingleton|already in use|SingletonLock/i.test(e.message)) {
      throw new Stop("The Chrome window from `npm run login` is still open. Quit it (Cmd+Q) and run again.");
    }
    throw e;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const visit = async (url) => {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (res?.status() === 429) throw new Stop(STOP_HELP.ratelimited);
  };
  // Kept so a selector that stops matching can be fixed from a real page.
  const keepPage = async (name) => fs.writeFileSync(path.join(runDir, name), await page.content());

  const out = { me: null, threads: [], stats: { searched: 0, opened: 0, rechecked: 0, stoppedEarly: null } };
  const found = new Map();
  try {
    for (const s of SEARCHES) {
      let url = searchUrl(s);
      for (let p = 0; p < LIMITS.pagesPerSearch && url; p++) {
        await visit(url);
        const r = await page.evaluate(readSearchPage);
        if (r.blocked) throw new Stop(STOP_HELP[r.blocked]);
        out.me ??= r.me;
        if (!out.me) {
          await keepPage("debug-search.html");
          throw new Stop(STOP_HELP.login);
        }
        if (!found.size && !r.results.length && p === 0) await keepPage("debug-search.html");
        for (const x of r.results) {
          const id = x.id || postId(x.url);
          if (id && !found.has(id)) found.set(id, { ...x, id });
        }
        out.stats.searched += r.results.length;
        log(`  ${label(s)} p${p + 1}: ${r.results.length} results`);
        url = r.next;
        await pause();
      }
    }

    const fresh = pickNew([...found.values()], state, LIMITS).map((p) => ({ ...p, kind: "new" }));
    const rechecks = pickRechecks(state, LIMITS)
      .filter((r) => !fresh.some((f) => f.id === r.id))
      .map((r) => ({ ...r, kind: "recheck" }));
    log(`\n${found.size} unique posts, ${fresh.length} new worth opening, ${rechecks.length} watched threads to re-read`);

    for (const p of [...fresh, ...rechecks]) {
      await visit(toOld(p.url));
      const t = await page.evaluate(readThread, out.me);
      if (t.blocked) throw new Stop(STOP_HELP[t.blocked]);
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
    if (!(e instanceof Stop)) throw e;
    out.stats.stoppedEarly = e.message;
    log(`\nStopped: ${e.message}`);
  } finally {
    await context.close();
  }
  return out;
}

/**
 * Decides what each thread needs: new posts and threads where OP answered
 * you go to Claude; threads you commented on days ago with no answer get the
 * one nudge. Updates the watch state for re-read threads.
 */
function plan(threads, state, now) {
  const toJudge = [];
  const nudges = [];
  for (const t of threads) {
    if (t.kind === "new") {
      toJudge.push({ id: t.id, mode: "new" });
      continue;
    }
    const s = state.posts[t.id];
    s.lastCheckedAt = new Date(now).toISOString();
    const opReplies = t.mine.reduce((n, c) => n + c.opReplies.length, 0);
    if (!t.mine.length) {
      if (!t.canComment || now - Date.parse(s.firstSeenAt) > LIMITS.nudgeAfterDays * DAY) s.closed = true;
    } else if (opReplies > (s.opRepliesSeen ?? 0)) {
      toJudge.push({ id: t.id, mode: "respond", opReplies });
    } else if (!s.nudged && !opReplies) {
      const firstMine = Math.min(...t.mine.map((c) => Date.parse(c.at) || now));
      if (now - firstMine >= LIMITS.nudgeAfterDays * DAY) {
        nudges.push({ id: t.id, note: `You said: "${t.mine[0].text.slice(0, 240)}". The plan from the first look: ${s.followUp || "add one useful thing, then stop."}` });
        s.nudged = true;
      }
    }
  }
  return { toJudge, nudges };
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
    if (!fs.existsSync(PROFILE_DIR)) {
      throw new Stop("No scout profile yet. Run `npm run login` first, sign in to Reddit, quit that window, then `npm start`.");
    }
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
    else Object.assign(s, { verdict: a.verdict, score: a.score, followUp: a.followUp });
  }
  saveState(state);

  const items = [
    ...run.toJudge.map((j) => ({ post: byId.get(j.id), a: analyses[j.id], kind: j.mode === "respond" ? "respond" : "new" })),
    ...run.nudges.map((n) => ({ post: byId.get(n.id), kind: "nudge", note: n.note })),
  ];
  const reportFile = path.join(runDir, "report.html");
  fs.writeFileSync(reportFile, renderReport({ items, me: run.me, startedAt: run.startedAt, stats: run.stats, now }));

  const count = (v) => items.filter((i) => i.kind === "new" && i.a?.verdict === v).length;
  log(`\nReply now: ${items.filter((i) => i.kind === "respond").length} · act on: ${count("pursue")} · follow-ups due: ${run.nudges.length} · maybe: ${count("maybe")} · skipped: ${count("skip")}`);
  log(`Report: ${reportFile}`);
  openFile(reportFile);
}

main().catch((e) => {
  console.error(e instanceof Stop ? e.message : e);
  process.exitCode = 1;
});
