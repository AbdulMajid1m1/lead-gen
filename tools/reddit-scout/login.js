import fs from "node:fs";
import { spawn } from "node:child_process";
import { PROFILE_DIR } from "./store.js";

// A plain Chrome window, not one driven by the scout, so Reddit's and
// Google's sign-in pages behave exactly as they do for you every day. The
// session it saves is what `npm start` reuses.
fs.mkdirSync(PROFILE_DIR, { recursive: true });
spawn("open", ["-na", "Google Chrome", "--args", `--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "--no-default-browser-check", "https://www.reddit.com/login/"], {
  stdio: "ignore",
  detached: true,
}).unref();

console.log(`A separate Chrome window just opened with the scout's own profile:
  ${PROFILE_DIR}

1. Sign in to Reddit there (Google sign-in with abdulmajid1m2@gmail.com works).
2. Quit that window with Cmd+Q.
3. Run: npm start

You only do this once. Your everyday Chrome profile is untouched.`);
