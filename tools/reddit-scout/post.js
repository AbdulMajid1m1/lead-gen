import path from "node:path";
import { fileURLToPath } from "node:url";
import { toOld, toWww } from "./extract.js";
import { openScoutBrowser, blockReason, ScoutStop } from "./browser.js";
import { loadRun, buildItems, recordPost } from "./actions.js";
import { latestRunDir } from "./store.js";

export class PostError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;
const ID_RE = /^t1_[a-z0-9]+$/;

// Resolves with the first truthy result, or null once every promise is done.
const firstOf = (promises) =>
  new Promise((resolve) => {
    let left = promises.length;
    for (const p of promises) p.then((v) => (v ? resolve(v) : --left === 0 && resolve(null)));
  });

/**
 * Posts `text` on a thread as you, top-level when parentId is null or as a
 * reply to that comment, and waits for Reddit to show it. Returns the new
 * comment's link. Reddit's own refusals ("you are doing that too much…")
 * come back as a PostError with Reddit's wording.
 */
export async function postToThread(page, { url, text, parentId = null, me }) {
  if (!USERNAME_RE.test(me ?? "")) throw new PostError("Unknown Reddit username; run the scout first.");
  if (parentId && !ID_RE.test(parentId)) throw new PostError(`Bad comment id ${parentId}.`);
  if (!text?.trim()) throw new PostError("Nothing to post.");

  const res = await page.goto(toOld(url), { waitUntil: "domcontentloaded", timeout: 45000 });
  if (res?.status() === 429) throw new PostError("Reddit answered 429 (too many requests). Try again in an hour.");
  const blocked = await page.evaluate(blockReason);
  if (blocked) throw new PostError(`Reddit is showing a ${blocked} page. Nothing was posted.`);

  const mineSel = `.thing.comment[data-author="${me}"]`;
  const before = new Set(await page.$$eval(mineSel, (els) => els.map((e) => e.getAttribute("data-fullname"))));

  let form;
  if (parentId) {
    const parent = page.locator(`.thing.comment[data-fullname="${parentId}"]`).first();
    if (!(await parent.count())) throw new PostError("The comment you are replying to is no longer on the page.");
    await parent.locator(':scope > .entry a[data-event-action="comment"]').first().click();
    form = parent.locator(":scope > .child form.usertext").first();
  } else {
    form = page.locator(".commentarea > form.usertext").first();
  }
  const box = form.locator('textarea[name="text"]');
  try {
    await box.waitFor({ state: "visible", timeout: 10000 });
  } catch {
    throw new PostError("Reddit is not offering a comment box here (locked, archived or logged out). Nothing was posted.");
  }
  await box.fill(text);
  await form.locator('button[type="submit"]').first().click();

  const outcome = await firstOf([
    page
      .waitForFunction(
        ([sel, seen]) => [...document.querySelectorAll(sel)].some((e) => !seen.includes(e.getAttribute("data-fullname"))),
        [mineSel, [...before]],
        { timeout: 30000 },
      )
      .then(() => ({ ok: true }), () => null),
    form
      .locator(".error:visible")
      .first()
      .waitFor({ timeout: 30000 })
      .then(async () => ({ ok: false, error: (await form.locator(".error:visible").first().innerText()).trim() }), () => null),
  ]);
  if (!outcome) throw new PostError("Reddit did not confirm the comment within 30 s. Check the thread before trying again.");
  if (!outcome.ok) throw new PostError(`Reddit refused it: ${outcome.error}`);

  const permalink = await page.$$eval(
    mineSel,
    (els, seen) => els.find((e) => !seen.includes(e.getAttribute("data-fullname")))?.getAttribute("data-permalink") ?? null,
    [...before],
  );
  return { permalink: permalink ? toWww(permalink) : toWww(url) };
}

/**
 * npm run post -- <post id>          shows what would be posted
 * npm run post -- <post id> --yes    posts it
 * Uses the latest run's draft; --text "…" posts that instead.
 */
async function cli() {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^t3_/.test(a));
  const text = argv.includes("--text") ? argv[argv.indexOf("--text") + 1] : null;
  const runDir = latestRunDir();
  if (!id || !runDir) throw new ScoutStop("Usage: npm run post -- <t3_id> [--text \"…\"] [--yes]");
  const loaded = loadRun(runDir);
  const item = buildItems(loaded).find((i) => i.job.id === id);
  if (!item?.postable) throw new ScoutStop(`No postable draft for ${id} in ${path.basename(runDir)}.`);
  if (item.posted) throw new ScoutStop(`Already posted: ${item.posted.permalink}`);
  const draft = { ...item.postable, text: text ?? item.postable.text };

  console.log(`${draft.kind === "reply" ? "Reply" : "Comment"} on "${item.post.title}" (${toWww(item.post.url)}) as u/${loaded.run.me}:\n\n${draft.text}\n`);
  if (!argv.includes("--yes")) return console.log("Not posted. Add --yes to post it.");

  const context = await openScoutBrowser();
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const { permalink } = await postToThread(page, { url: item.post.url, text: draft.text, parentId: draft.parentId, me: loaded.run.me });
    recordPost(runDir, id, { at: new Date().toISOString(), kind: draft.kind, text: draft.text, permalink });
    console.log(`Posted: ${permalink}`);
  } finally {
    await context.close();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  cli().catch((e) => {
    console.error(e instanceof ScoutStop || e instanceof PostError ? e.message : e);
    process.exitCode = 1;
  });
}
