import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { PROFILE_DIR } from "./store.js";

export class ScoutStop extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome processes on the scout profile. `driven` ones belong to a scout run
// or the review page; the others are the sign-in window from `npm run login`.
const profileProcesses = () => {
  let out = "";
  try {
    out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((l) => l.includes(`--user-data-dir=${PROFILE_DIR}`) && !l.includes("Helper") && !l.includes("--type="))
    .map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), driven: l.includes("--remote-debugging-pipe") }));
};

/**
 * The sign-in window holds the profile lock. Close it the way Cmd+Q does
 * (SIGTERM is Chrome's clean shutdown, which saves the session first).
 */
const closeSignInWindow = async () => {
  const procs = profileProcesses();
  if (procs.some((p) => p.driven)) {
    throw new ScoutStop("Another scout run or the review page is using the scout's Chrome profile. Let it finish (or Ctrl+C it) first.");
  }
  for (const { pid } of procs) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let i = 0; i < 20 && profileProcesses().length; i++) await sleep(500);
};

export async function openScoutBrowser() {
  if (!fs.existsSync(PROFILE_DIR)) {
    throw new ScoutStop("No scout profile yet. Run `npm run login` first and sign in to Reddit.");
  }
  await closeSignInWindow();
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      viewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
      // Playwright's mock keychain cannot decrypt the session cookie that the
      // sign-in window saved with the real macOS keychain, and Chrome deletes
      // cookies it cannot decrypt, which logs you out.
      ignoreDefaultArgs: ["--use-mock-keychain"],
    });
  } catch (e) {
    if (/ProcessSingleton|already in use|SingletonLock/i.test(e.message)) {
      throw new ScoutStop("The scout's Chrome profile is still in use. Close any scout Chrome window and run again.");
    }
    throw e;
  }
}

/** Same checks the readers make, for pages the poster lands on. */
export const blockReason = () => {
  const text = `${document.title} ${(document.body?.innerText ?? "").slice(0, 3000)}`;
  if (/whoa there,? pardner|you've been blocked|blocked by network security|too many requests/i.test(text)) return "blocked";
  if (document.querySelector('iframe[src*="captcha"], .g-recaptcha, [data-hcaptcha-widget-id]')) return "captcha";
  if (location.pathname.startsWith("/login")) return "login";
  return null;
};
