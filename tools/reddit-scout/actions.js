import fs from "node:fs";
import path from "node:path";
import { loadState, saveState, readJson, writeJson } from "./store.js";

/**
 * A run folder holds posts.json (what was read), analysis.json (Claude's
 * verdicts) and posted.json (what you posted from the review page). These
 * helpers turn that into report items and record posts.
 */
export const loadRun = (runDir) => {
  const file = (name, fallback) => (fs.existsSync(path.join(runDir, name)) ? readJson(path.join(runDir, name)) : fallback);
  return { runDir, run: file("posts.json", null), analyses: file("analysis.json", {}), posted: file("posted.json", {}) };
};

/**
 * What the Post button would put on Reddit for a thread: the comment for a
 * new post, or the reply under a comment for a thread you are already in.
 * DMs are never posted by the scout.
 */
export const postable = (job, a) => {
  if (!a || a.action === "skip") return null;
  if (job.mode === "new") return a.comment ? { kind: "comment", text: a.comment, parentId: null } : null;
  return a.reply && job.parentId ? { kind: "reply", text: a.reply, parentId: job.parentId } : null;
};

export const buildItems = ({ run, analyses, posted }) => {
  const byId = new Map(run.threads.map((t) => [t.id, t]));
  return [
    ...run.toJudge.map((job) => ({
      job,
      post: byId.get(job.id),
      a: analyses[job.id],
      kind: job.mode,
      postable: postable(job, analyses[job.id]),
      posted: posted[job.id] ?? null,
    })),
    // Runs from before nudges went to Claude carry a plain note instead.
    ...(run.nudges ?? []).map((n) => ({ job: { id: n.id, mode: "nudge" }, post: byId.get(n.id), kind: "nudge", note: n.note, posted: posted[n.id] ?? null })),
  ];
};

export const recordPost = (runDir, id, entry) => {
  const file = path.join(runDir, "posted.json");
  const posted = fs.existsSync(file) ? readJson(file) : {};
  posted[id] = entry;
  writeJson(file, posted);
  const state = loadState();
  if (state.posts[id]) {
    (state.posts[id].posted ??= []).push(entry);
    saveState(state);
  }
};
