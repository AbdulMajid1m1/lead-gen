import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Chrome profile holds the Reddit session cookie, so it lives in the home
// folder, never in the repo. Run reports go next to the code, git-ignored.
export const HOME_DIR = path.join(os.homedir(), ".reddit-scout");
export const PROFILE_DIR = path.join(HOME_DIR, "chrome-profile");
const STATE_FILE = path.join(HOME_DIR, "state.json");
export const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");

const DAY = 24 * 3600 * 1000;

/**
 * state.posts[id] remembers every post already judged, so a run only spends
 * Claude on posts it has not seen, and it carries what is needed to watch a
 * thread you commented on: how many OP replies to you were already reported
 * and whether the one nudge was suggested.
 */
export const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { posts: {} };
  }
};

export const saveState = (state, now = Date.now()) => {
  for (const [id, p] of Object.entries(state.posts)) {
    if (now - Date.parse(p.firstSeenAt) > 30 * DAY) delete state.posts[id];
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
};

export const newRunDir = (now = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dir = path.join(OUT_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const latestRunDir = () => {
  if (!fs.existsSync(OUT_DIR)) return null;
  const runs = fs.readdirSync(OUT_DIR).filter((d) => fs.existsSync(path.join(OUT_DIR, d, "posts.json"))).sort();
  return runs.length ? path.join(OUT_DIR, runs.at(-1)) : null;
};

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
