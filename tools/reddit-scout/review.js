import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { renderReport } from "./report.js";
import { loadRun, buildItems, recordPost } from "./actions.js";
import { openScoutBrowser, refreshSession, ScoutStop } from "./browser.js";
import { postToThread, PostError } from "./post.js";
import { latestRunDir, OUT_DIR } from "./store.js";

/**
 * npm run review [run-folder]
 *
 * Serves the latest report on 127.0.0.1 with a Post button on each comment
 * and reply draft. A click posts exactly the text in the box, as you, in the
 * scout's Chrome window. Nothing is posted without that click.
 */

const PORT = Number(process.env.SCOUT_PORT || 4777);
const MIN_GAP_MS = 90 * 1000; // between two posts, however fast you click
const MAX_TEXT = 10000; // Reddit's comment limit
// Every POST must carry this. Another website open in your browser cannot
// read it, so it cannot make this server post for you.
const TOKEN = crypto.randomBytes(16).toString("hex");

const runDir = process.argv[2] ? path.resolve(OUT_DIR, process.argv[2]) : latestRunDir();
if (!runDir) {
  console.error("No run yet. Run `npm start` first.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let context = null;
let lastPostAt = 0;
let queue = Promise.resolve();

const scoutPage = async () => {
  if (!context) {
    context = await openScoutBrowser();
    context.on("close", () => (context = null));
    await refreshSession(context.pages()[0] ?? (await context.newPage()));
  }
  return context.pages()[0] ?? context.newPage();
};

async function post(id, text) {
  const loaded = loadRun(runDir);
  const item = buildItems(loaded).find((i) => i.job.id === id);
  if (!item?.postable) throw new PostError("There is no comment or reply draft to post for that thread.");
  if (item.posted) throw new PostError("Already posted from this report.");
  const wait = lastPostAt + MIN_GAP_MS - Date.now();
  if (wait > 0) {
    console.log(`  waiting ${Math.ceil(wait / 1000)} s before the next post`);
    await sleep(wait);
  }
  console.log(`  posting ${item.postable.kind} on "${item.post.title.slice(0, 60)}"`);
  const page = await scoutPage();
  const { permalink } = await postToThread(page, { url: item.post.url, text, parentId: item.postable.parentId, me: loaded.run.me });
  lastPostAt = Date.now();
  const entry = { at: new Date().toISOString(), kind: item.postable.kind, text, permalink };
  recordPost(runDir, id, entry);
  console.log(`  posted: ${permalink}`);
  return entry;
}

const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64 * 1024) req.destroy(new Error("too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const server = http.createServer(async (req, res) => {
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return send(res, 403, { error: "forbidden" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      const loaded = loadRun(runDir);
      const html = renderReport({
        items: buildItems(loaded),
        me: loaded.run.me,
        startedAt: loaded.run.startedAt,
        stats: loaded.run.stats,
        interactive: { token: TOKEN },
      });
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/api/post") {
      if (req.headers["x-scout-token"] !== TOKEN) return send(res, 403, { error: "This page is stale. Reload it." });
      const { id, text } = JSON.parse(await readBody(req));
      if (typeof id !== "string" || typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) {
        return send(res, 400, { error: "Empty or too long." });
      }
      const job = queue.then(() => post(id, text.trim()));
      queue = job.catch(() => {});
      return send(res, 200, await job);
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    const known = e instanceof PostError || e instanceof ScoutStop;
    if (!known) console.error(e);
    return send(res, known ? 409 : 500, { error: known ? e.message : "Something went wrong; see the terminal." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const link = `http://127.0.0.1:${PORT}/`;
  console.log(`Review page for ${path.basename(runDir)}: ${link}\nCtrl+C to stop.`);
  if (!process.argv.includes("--no-open")) spawn("open", [link], { stdio: "ignore", detached: true }).unref();
});

const shutdown = async () => {
  server.close();
  await context?.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
