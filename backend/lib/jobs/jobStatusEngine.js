import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { log } from "../../utils/logger.js";

const logger = log("jobStatus");

/**
 * Decides whether a job posting is live.
 *
 * The rule that matters: **a page that still returns 200 proves nothing.**
 * Careers pages routinely serve filled roles for years. ACTIVE is only ever
 * asserted from a job's presence in a *current* fetch of its own board.
 *
 * Every decision appends to `statusEvidence`, so the UI can show why a job is
 * counted as live and how recently that was checked.
 */

const RECENTLY_ACTIVE_GRACE_DAYS = 14;
const AGGREGATOR_UNKNOWN_AFTER_DAYS = 45;

const CLOSED_PHRASES = /no longer (?:accepting|available|open)|position (?:has been )?(?:filled|closed)|this (?:job|role|position) (?:is|has) (?:closed|expired|been filled)|applications? (?:are )?closed|vacancy (?:is )?(?:closed|filled)/i;

const appendEvidence = (existing, entry) => {
  const list = Array.isArray(existing) ? existing : [];
  // Keep the last 10 observations — enough to show a history, bounded in size.
  return [...list, { ...entry, at: new Date().toISOString() }].slice(-10);
};

/**
 * Reconcile one company's jobs against a fresh board fetch.
 *
 * @param {{companyId, sourceId, boardJobs:Array, boardFetchOk:boolean}} input
 *   `boardJobs` is what the board returned right now.
 */
export const reconcileBoardJobs = async ({ companyId, sourceId, boardJobs, boardFetchOk }) => {
  if (!boardFetchOk) {
    // A failed fetch is not evidence that anything closed — leave statuses alone.
    logger.debug({ companyId }, "board fetch failed; job statuses left untouched");
    return { activated: 0, recentlyActive: 0, expired: 0, unchanged: 0 };
  }

  const now = new Date();
  const seenIds = new Set(boardJobs.map((j) => String(j.externalId)));
  const stored = await prisma.jobPosting.findMany({ where: { companyId, sourceId } });

  let activated = 0;
  let recentlyActive = 0;
  let expired = 0;

  // ─── Present on the board right now → ACTIVE ────────────────────────────────
  for (const job of boardJobs) {
    const existing = stored.find((s) => s.externalId === String(job.externalId));
    // A deadline that has passed overrides board presence: some boards keep
    // showing a posting past its own stated closing date.
    const deadlinePassed = job.deadlineAt && new Date(job.deadlineAt) < now;
    const status = deadlinePassed ? "EXPIRED" : "ACTIVE";

    await prisma.jobPosting.update({
      where: { sourceId_externalId: { sourceId, externalId: String(job.externalId) } },
      data: {
        status,
        lastSeenActiveAt: status === "ACTIVE" ? now : existing?.lastSeenActiveAt,
        lastVerifiedAt: now,
        disappearedAt: null,
        verifyAttempts: { increment: 1 },
        statusEvidence: appendEvidence(existing?.statusEvidence, {
          method: "board_refetch",
          boardHadJob: true,
          decidedStatus: status,
          ...(deadlinePassed ? { note: "application deadline has passed" } : {}),
        }),
      },
    });
    if (status === "ACTIVE") activated += 1;
    else expired += 1;
  }

  // ─── Absent from a successful fetch → RECENTLY_ACTIVE, then EXPIRED ─────────
  for (const job of stored) {
    if (seenIds.has(job.externalId)) continue;
    if (["EXPIRED", "CLOSED"].includes(job.status)) continue;

    const gone = job.disappearedAt || now;
    const daysGone = (now - new Date(gone).getTime()) / 86_400_000;
    const status = daysGone >= RECENTLY_ACTIVE_GRACE_DAYS ? "EXPIRED" : "RECENTLY_ACTIVE";

    await prisma.jobPosting.update({
      where: { id: job.id },
      data: {
        status,
        disappearedAt: job.disappearedAt || now,
        lastVerifiedAt: now,
        verifyAttempts: { increment: 1 },
        statusEvidence: appendEvidence(job.statusEvidence, {
          method: "board_refetch",
          boardHadJob: false,
          decidedStatus: status,
          daysGone: Math.round(daysGone),
        }),
      },
    });
    if (status === "EXPIRED") expired += 1;
    else recentlyActive += 1;
  }

  return { activated, recentlyActive, expired, unchanged: stored.length - activated - recentlyActive - expired };
};

/**
 * Verify an aggregator-sourced job that has no probeable board, by fetching its
 * own URL. Used sparingly — one request per job, weekly at most.
 */
export const verifyJobByUrl = async (jobId) => {
  const job = await prisma.jobPosting.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  const now = new Date();
  if (!job.url) {
    return applyStatus(job, "UNKNOWN", { method: "no_url", note: "No posting URL to verify against." });
  }

  const res = await fetchPage(job.url, { timeoutMs: 12_000 });

  if (res.status === 404 || res.status === 410) {
    return applyStatus(job, "CLOSED", { method: "url_check", httpStatus: res.status, note: "Posting URL no longer exists." });
  }
  if (res.blockReason && !res.status) {
    // Could not check — do not downgrade on our own failure to reach it.
    return applyStatus(job, job.status, { method: "url_check", blocked: res.blockReason, note: "Could not verify; status unchanged." });
  }
  if (res.ok && CLOSED_PHRASES.test(res.body || "")) {
    return applyStatus(job, "CLOSED", { method: "url_check", httpStatus: res.status, note: "Page states the role is closed or filled." });
  }
  // Redirected away from the posting to a board root is the usual "gone" tell.
  if (res.ok && res.redirects.length && !/\/(?:jobs?|careers?|positions?|opening)/i.test(res.finalUrl || "")) {
    return applyStatus(job, "CLOSED", { method: "url_check", httpStatus: res.status, note: `Redirected to ${res.finalUrl}` });
  }

  const ageDays = job.postedAt ? (now - new Date(job.postedAt).getTime()) / 86_400_000 : null;
  if (ageDays !== null && ageDays > AGGREGATOR_UNKNOWN_AFTER_DAYS) {
    // The page is up, but a 200 on an old aggregator listing is not evidence of
    // an open role. UNKNOWN scores zero rather than faking a hiring signal.
    return applyStatus(job, "UNKNOWN", {
      method: "url_check",
      httpStatus: res.status,
      note: `Page still resolves but the posting is ${Math.round(ageDays)} days old with no board to confirm it.`,
    });
  }

  return applyStatus(job, "RECENTLY_ACTIVE", {
    method: "url_check",
    httpStatus: res.status,
    note: "Posting URL still resolves and shows no closure notice.",
  });
};

const applyStatus = async (job, status, evidence) =>
  prisma.jobPosting.update({
    where: { id: job.id },
    data: {
      status,
      lastVerifiedAt: new Date(),
      verifyAttempts: { increment: 1 },
      statusEvidence: appendEvidence(job.statusEvidence, { ...evidence, decidedStatus: status }),
    },
  });

/**
 * Classify a freshly-ingested job before any re-verification has happened.
 * Board-sourced jobs are trusted as ACTIVE because we just saw them listed;
 * aggregator-sourced ones start at RECENTLY_ACTIVE or UNKNOWN by age.
 */
export const initialStatusFor = ({ fromBoard, postedAt, deadlineAt }) => {
  const now = Date.now();
  if (deadlineAt && new Date(deadlineAt).getTime() < now) return "EXPIRED";
  if (fromBoard) return "ACTIVE";
  if (!postedAt) return "UNKNOWN";
  const ageDays = (now - new Date(postedAt).getTime()) / 86_400_000;
  if (ageDays > AGGREGATOR_UNKNOWN_AFTER_DAYS) return "UNKNOWN";
  return "RECENTLY_ACTIVE";
};

/** Which jobs are due a re-check, per the cadence in SCORING_SPEC §6. */
export const jobsDueForVerification = async (limit = 100) => {
  const now = Date.now();
  return prisma.jobPosting.findMany({
    where: {
      OR: [
        { status: "ACTIVE", OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now - 24 * 3600_000) } }] },
        { status: "RECENTLY_ACTIVE", OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now - 48 * 3600_000) } }] },
        { status: "UNKNOWN", url: { not: null }, lastVerifiedAt: { lt: new Date(now - 7 * 24 * 3600_000) } },
      ],
    },
    orderBy: { lastVerifiedAt: "asc" },
    take: limit,
  });
};
