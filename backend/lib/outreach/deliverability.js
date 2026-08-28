import prisma from "../../prismaClient.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:deliverability");

/**
 * What happens *after* a send, which is the half hygiene.js cannot cover.
 *
 * hygiene.js stops the addresses we can already tell are dead; this module
 * reads the answer the mail system gave us about the ones we could not. Both
 * exist for the same reason: bounce rate is the one metric a sending domain
 * cannot recover from quickly. Practitioners keep it under 2%, treat 3% as the
 * ceiling, and above ~5% the domain's reputation degrades badly enough that
 * even the good mail starts landing in spam — at which point the fix is a new
 * domain and months of warm-up, not a config change.
 *
 * Until this existed, `ThreadStatus.BOUNCED` was read but never written: a
 * campaign could work through a list of dead addresses, burn the domain, and
 * nothing in the system noticed.
 */

const DAY_MS = 86_400_000;

// ─── Reading a non-delivery report ───────────────────────────────────────────

/**
 * A `multipart/report; report-type=delivery-status` message is a bounce by
 * definition — RFC 3464 reserves the type for exactly this.
 */
const REPORT_CONTENT_TYPE_RE = /multipart\/report[\s\S]{0,200}?report-type\s*=\s*["']?delivery-status/i;

/** The two mailboxes the mail system itself speaks from. */
const DAEMON_FROM_RE = /^(?:mailer-daemon|mail-daemon|postmaster)@/i;

/**
 * An empty return path is how a report says "do not reply to me" — it is set on
 * bounces precisely so a bounce can never bounce and start a loop.
 */
const NULL_RETURN_PATH_RE = /^return-path:\s*<>\s*$/im;

/** The subjects the major providers put on a non-delivery report. */
const BOUNCE_SUBJECT_RE =
  /^(undeliverable|delivery status notification|returned mail|mail delivery (?:failed|subsystem)|failure notice)/i;

/**
 * A DSN field block. Only counted as evidence when the status line is present
 * in its RFC 3464 form: a bare "5.1.1" can appear in ordinary prose (a version
 * number, a clause reference), but `Status: 5.1.1` on its own line cannot.
 */
const DSN_STATUS_RE = /^\s*status:\s*([245]\.\d{1,3}\.\d{1,3})/im;

/** The enhanced status code wherever else it turns up, e.g. inside a diagnostic. */
const LOOSE_STATUS_RE = /\b([245]\.\d{1,3}\.\d{1,3})\b/;

/** The classic three-digit SMTP reply, when no enhanced code was given. */
const SMTP_REPLY_RE = /(?:^|\s)([45]\d{2})[\s-](?:[45]\.\d\.\d|\D)/;

/**
 * Wording that means the mailbox does not exist. These are the only phrases
 * allowed to condemn an address on wording alone.
 */
const HARD_PHRASES = [
  /no such user/i,
  /user unknown/i,
  /unknown user/i,
  /recipient (?:address )?(?:unknown|not found)/i,
  /does ?n[o']?t exist/i,
  /address rejected/i,
  /invalid recipient/i,
  /no such (?:mailbox|recipient|address)/i,
];

/** Wording that means "not now", which says nothing about the address itself. */
const SOFT_PHRASES = [
  /mailbox (?:is )?full/i,
  /over ?quota/i,
  /quota exceeded/i,
  /insufficient storage/i,
  /temporar/i,
  /try again/i,
  /grey ?list/i,
  /timed? ?out/i,
  /deferred/i,
];

/**
 * A full mailbox is reported with a 5.2.2 by some servers even though nothing
 * about the address is wrong. Trusting the leading 5 there would suppress a
 * live prospect for being on holiday.
 */
const FULL_MAILBOX_RE = /mailbox (?:is )?full|over ?quota|quota exceeded|insufficient storage/i;

const EMAIL_IN_TEXT_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;

/** Header blocks arrive as raw text or as a name→value object, depending on caller. */
const headerText = (headers) => {
  if (!headers) return "";
  if (typeof headers === "string") return headers;
  if (Buffer.isBuffer(headers)) return headers.toString("utf8");
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
    .join("\n");
};

const firstMatch = (text, re, group = 1) => {
  const m = re.exec(text);
  return m ? m[group] : null;
};

/**
 * The address the report says failed. Read from the structured fields first —
 * a report quotes our own headers back at us, so the first address in the body
 * is often the *sender*, not the casualty.
 */
const failedRecipient = (body, headerBlock) => {
  const combined = `${headerBlock}\n${body}`;
  const structured =
    firstMatch(combined, /^\s*(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/im) ||
    firstMatch(combined, /^\s*x-failed-recipients:\s*<?([^\s<>,]+@[^\s<>,]+)>?/im);
  if (structured) return structured.toLowerCase();

  // The human-readable part of every major provider's report names the address
  // in a sentence: "Your message to foo@bar.com couldn't be delivered".
  const prose = firstMatch(body, /(?:message (?:wasn't delivered )?to|recipient|address)\s*:?\s*<?([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+)>?/i);
  return prose ? prose.toLowerCase() : null;
};

/** The one line worth showing a human: what the receiving server actually said. */
const bounceReason = (body) => {
  const diagnostic = firstMatch(body, /^\s*diagnostic-code:\s*(?:smtp;)?\s*(.+)$/im);
  if (diagnostic) return diagnostic.trim().slice(0, 300);
  const line = body
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 20 && /(?:reject|unknown|not exist|undeliver|fail|full|quota|blocked)/i.test(l));
  return line ? line.slice(0, 300) : null;
};

/**
 * Classify one inbound message as a non-delivery report, or not.
 *
 * Pure: everything it needs is passed in, so the realistic Gmail/Outlook/Postfix
 * reports live in the test file rather than in a mailbox somebody has to keep.
 *
 * The default is deliberately SOFT. A wrong HARD verdict suppresses a real
 * prospect permanently and silently — nobody ever finds out — while a wrong
 * SOFT verdict costs at most one more send to an address that will bounce again
 * and be classified properly the second time.
 *
 * @param {{from?: string, subject?: string, body?: string, headers?: string|object}} input
 * @returns {{isBounce: boolean, type: "HARD"|"SOFT"|null, code: string|null,
 *            recipient: string|null, reason: string|null}}
 */
export const classifyBounce = ({ from = "", subject = "", body = "", headers = "" } = {}) => {
  const none = { isBounce: false, type: null, code: null, recipient: null, reason: null };

  const headerBlock = headerText(headers);
  const bodyText = String(body || "");
  const fromAddr = String(from || "").trim().toLowerCase();
  const subjectText = String(subject || "").trim();

  const isReport = REPORT_CONTENT_TYPE_RE.test(headerBlock);
  const isDaemon = DAEMON_FROM_RE.test(fromAddr);
  const isNullReturnPath = NULL_RETURN_PATH_RE.test(headerBlock);
  const subjectSaysSo = BOUNCE_SUBJECT_RE.test(subjectText);
  const dsnStatus = firstMatch(bodyText, DSN_STATUS_RE) || firstMatch(headerBlock, DSN_STATUS_RE);

  // A human reply is never any of these. The status code alone does not qualify
  // unless it is in its DSN field form, because a person can write "4.1.2" in a
  // sentence and must not be mistaken for a dead mailbox.
  if (!isReport && !isDaemon && !isNullReturnPath && !subjectSaysSo && !dsnStatus) return none;

  const code = dsnStatus || firstMatch(bodyText, LOOSE_STATUS_RE) || firstMatch(bodyText, SMTP_REPLY_RE);
  const reason = bounceReason(bodyText);
  const recipient = failedRecipient(bodyText, headerBlock);

  let type = null;
  if (code && code.startsWith("5")) {
    // 5.2.2 and its wordier cousins are a permanent code for a temporary
    // condition; the address is fine, the mailbox is just full today.
    type = FULL_MAILBOX_RE.test(bodyText) ? "SOFT" : "HARD";
  } else if (code && code.startsWith("4")) {
    type = "SOFT";
  } else if (HARD_PHRASES.some((re) => re.test(bodyText)) && !SOFT_PHRASES.some((re) => re.test(bodyText))) {
    type = "HARD";
  } else {
    type = "SOFT";
  }

  return { isBounce: true, type, code: code ? code.slice(0, 20) : null, recipient, reason };
};

// ─── The rolling rate, and what to do about it ───────────────────────────────

/**
 * Pause a campaign at 3%.
 *
 * 2% is where practitioners want to stay and 3% is the hard ceiling; past ~5%
 * the sending domain's reputation is damaged in a way that takes weeks of
 * reduced volume to undo. Pausing at 3% therefore stops the campaign while the
 * damage is still recoverable — waiting for 5% means the list was the problem
 * for thousands of sends before anyone was told.
 */
export const BOUNCE_PAUSE_THRESHOLD = 0.03;

/**
 * Below this many sends the rate is noise, not a trend: one bounce in five
 * reads as 20% and would pause a perfectly healthy campaign on its first
 * mistyped address.
 */
export const MIN_SAMPLE_BEFORE_PAUSE = 20;

/**
 * The rolling bounce rate for a mailbox (or for all of them).
 *
 * Counted against outbound INITIAL + FOLLOW_UP messages only: a REPLY or a
 * BOUNCE in the denominator would quietly deflate the rate exactly when it
 * matters most.
 *
 * @returns {Promise<{sent: number, bounced: number, rate: number, sample: number}>}
 *   `rate` is a fraction, `sample` the number of sends behind it so a caller
 *   can refuse to act on too little evidence.
 */
export const bounceRate = async ({ accountId = null, sinceDays = 30 } = {}) => {
  const since = new Date(Date.now() - Math.max(1, sinceDays) * DAY_MS);
  const thread = accountId ? { channel: "EMAIL", accountId } : { channel: "EMAIL" };

  const [sent, bounced] = await Promise.all([
    prisma.outreachMessage.count({
      where: { direction: "OUTBOUND", kind: { in: ["INITIAL", "FOLLOW_UP"] }, sentAt: { gte: since }, thread },
    }),
    prisma.outreachMessage.count({
      where: { kind: "BOUNCE", createdAt: { gte: since }, thread },
    }),
  ]);

  return { sent, bounced, rate: sent > 0 ? bounced / sent : 0, sample: sent };
};

/** Whether this rate, on this much evidence, is worth stopping a campaign for. */
export const shouldPauseForBounces = ({ rate, sample } = {}) => {
  if (!Number.isFinite(rate) || !Number.isFinite(sample)) return false;
  if (sample < MIN_SAMPLE_BEFORE_PAUSE) return false;
  return rate >= BOUNCE_PAUSE_THRESHOLD;
};

// ─── Warm-up ────────────────────────────────────────────────────────────────

/**
 * No warm-up in force. Infinity rather than a number so the caller can write
 * `Math.min(cap, warmupDailyCap(account))` and get the normal cap back
 * untouched — a mailbox past its ramp must behave exactly as it did before.
 */
export const NO_WARMUP_LIMIT = Infinity;

/**
 * The ramp, as (last day of the step → that step's cap).
 *
 * A brand-new sending identity that opens at 150 a day is the classic way to be
 * filtered on week one: providers have nothing to judge the domain by except
 * the shape of its first week, and a standing start looks exactly like a
 * compromised account. Roughly doubling every few days gives them a curve to
 * read, and day 21 is where the mailbox has enough history to be trusted with
 * its normal cap.
 */
const WARMUP_RAMP = [
  { throughDay: 2, cap: 5 },
  { throughDay: 5, cap: 10 },
  { throughDay: 9, cap: 20 },
  { throughDay: 14, cap: 35 },
  { throughDay: 20, cap: 50 },
];

/** Day 21 onwards the account sends at its configured cap. */
export const WARMUP_DAYS = 21;

/**
 * Today's ceiling for one mailbox. Pure — no clock, no database — so the whole
 * schedule is testable at any point on it.
 *
 * @param {{warmupStartedAt?: Date|string|null}} account
 * @returns {number} the cap, or NO_WARMUP_LIMIT when the ramp does not apply.
 */
export const warmupDailyCap = (account, { now = new Date() } = {}) => {
  const started = account?.warmupStartedAt ? new Date(account.warmupStartedAt) : null;
  if (!started || Number.isNaN(started.getTime())) return NO_WARMUP_LIMIT;

  // Day 1 is the day sending started; a start date in the future is treated as
  // day 1 rather than as a negative day, so a clock skew cannot lift the cap.
  const day = Math.max(1, Math.floor((now.getTime() - started.getTime()) / DAY_MS) + 1);
  if (day >= WARMUP_DAYS) return NO_WARMUP_LIMIT;
  return WARMUP_RAMP.find((step) => day <= step.throughDay)?.cap ?? NO_WARMUP_LIMIT;
};

// ─── Recording one ──────────────────────────────────────────────────────────

/**
 * Persist a bounce: the report itself, the thread it killed, and — on a hard
 * bounce only — the suppression that stops us ever sending there again.
 *
 * Never throws. A malformed report or a database hiccup must not take down the
 * maintenance run that found it; the bounce is logged and the next sync will
 * see the same message again.
 *
 * @param {{threadId: string, hit: object, classification: object}} input
 * @returns {Promise<object|null>} the stored message, or null if nothing was written
 */
export const recordBounce = async ({ threadId, hit = {}, classification = {} }) => {
  try {
    const thread = await prisma.outreachThread.findUnique({
      where: { id: threadId },
      select: { id: true, leadId: true, recipientEmail: true, lead: { select: { companyId: true } } },
    });
    if (!thread) return null;

    const body = [hit.snippet, classification.reason]
      .filter(Boolean)
      .join("\n\n") || "(delivery failed — the report carried no readable detail)";

    const message = await prisma.outreachMessage.create({
      data: {
        threadId,
        direction: "INBOUND",
        kind: "BOUNCE",
        subject: (hit.subject || "Delivery failed").slice(0, 255),
        body: body.slice(0, 8000),
        messageId: hit.messageId || null,
        fromAddress: hit.from || null,
        receivedAt: hit.date || new Date(),
        bounceType: classification.type || "SOFT",
        bounceCode: classification.code || null,
      },
    });

    // The thread is over either way, and its follow-ups are cancelled: chasing
    // an address that just refused the first message only doubles the damage.
    await prisma.outreachThread.update({
      where: { id: threadId },
      data: { status: "BOUNCED", nextFollowUpAt: null },
    });

    if (classification.type === "HARD") {
      // The address the thread was actually sent to, not the one the report
      // names: the thread was matched by our own Message-ID, so it is the
      // authority on who we tried to reach.
      await suppressAddress(thread, classification);
    }

    logger.info(
      { threadId, type: classification.type, code: classification.code, to: thread.recipientEmail },
      "bounce recorded",
    );
    return message;
  } catch (err) {
    logger.warn({ threadId, msg: err.message }, "could not record bounce");
    return null;
  }
};

/**
 * Suppress a hard-bounced address the same way hygiene.js does: the contact row
 * so the campaign picker skips it, and the suppression list so every send path
 * — manual one-off included — refuses it too.
 */
const suppressAddress = async (thread, classification) => {
  const address = String(thread.recipientEmail || "").toLowerCase();
  if (!address.includes("@")) return;

  const reason = `Hard bounce${classification.code ? ` (${classification.code})` : ""} — the mailbox does not exist.`;

  await prisma.contact.updateMany({
    where: { companyId: thread.lead?.companyId, kind: "EMAIL", value: { equals: address, mode: "insensitive" } },
    data: { isSuppressed: true },
  });
  await prisma.suppressionEntry.upsert({
    where: { kind_value: { kind: "EMAIL", value: address } },
    create: { kind: "EMAIL", value: address, reason: reason.slice(0, 500) },
    update: { reason: reason.slice(0, 500) },
  });

  logger.info({ address, code: classification.code }, "address suppressed after hard bounce");
};
