import prisma from "../../prismaClient.js";
import { getAccount, sendInitialEmail, sendWhatsAppForLead } from "./service.js";
import { getWhatsAppAccount } from "./whatsapp.js";
import { pickWhatsAppNumber } from "./phoneRank.js";
import { sendPolicyFor, isRoleAddress, isSendBlocked } from "./sendPolicy.js";
import { domainHasMx, emailLooksMangled, BROKER_DOMAIN_RE } from "./hygiene.js";
import { bounceRate, shouldPauseForBounces, warmupDailyCap, BOUNCE_PAUSE_THRESHOLD } from "./deliverability.js";
import { composeEmailForLead, gatherFacts } from "../research/compose.js";
import { toActor } from "./attribution.js";
import { whatsappInitialTemplate } from "../research/templates.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:campaigns");

/**
 * Bulk outreach without the blast.
 *
 * A campaign is a queue, not a loop: the worker drains it one lead at a time,
 * spaced by `paceSeconds`, under a per-account daily cap. That pacing is not
 * cosmetic — Gmail and WhatsApp both score senders on burst behaviour, and the
 * cheapest way to lose a mailbox or get a number banned is to send 300
 * identical messages in one minute. Slow *is* the feature.
 *
 * Every individual send goes through the exact same functions as a manual
 * one-off (`sendInitialEmail` / `sendWhatsAppForLead`), so suppression checks,
 * thread creation, signatures, status funnels and reply tracking are inherited
 * rather than re-implemented.
 */

const DAY_MS = 86_400_000;
export const DAILY_EMAIL_CAP = Number(process.env.OUTREACH_DAILY_EMAIL_CAP || 150);
// Unofficial WhatsApp transport — stay conservative or the number gets banned.
export const DAILY_WA_CAP = Number(process.env.OUTREACH_DAILY_WA_CAP || 60);
const MAX_RECIPIENTS = 500;

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// ── AUTO-mode scheduling ─────────────────────────────────────────────────────
// All pure and exported so the timezone math is unit-testable without a clock.

export const AUTO_DEFAULT_DAILY_LIMIT = 40;

/** Hour-of-day (fractional, 0–23.99) at the campaign's timezone offset. */
export const localHour = (tzOffsetMinutes, now = new Date()) => {
  const mins = (((now.getUTCHours() * 60 + now.getUTCMinutes() + tzOffsetMinutes) % 1440) + 1440) % 1440;
  return mins / 60;
};

/** DIRECT campaigns send around the clock; AUTO only inside its local window. */
export const isWithinSendWindow = (campaign, now = new Date()) => {
  if (campaign.mode !== "AUTO") return true;
  const h = localHour(campaign.tzOffsetMinutes, now);
  return h >= campaign.windowStart && h < campaign.windowEnd;
};

/**
 * AUTO gap between sends: the day's quota spread evenly across the window,
 * jittered ±25% so the cadence never looks machine-regular to a spam filter.
 */
export const autoGapSeconds = (campaign, rand = Math.random()) => {
  const windowSeconds = Math.max(1, campaign.windowEnd - campaign.windowStart) * 3600;
  const base = windowSeconds / Math.max(1, campaign.dailyLimit || AUTO_DEFAULT_DAILY_LIMIT);
  return Math.max(60, Math.round(base * (0.75 + rand * 0.5)));
};

/** Midnight of the campaign's *local* day, as a UTC instant. */
export const startOfLocalToday = (tzOffsetMinutes, now = new Date()) => {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - tzOffsetMinutes * 60_000);
};

/** Leads this campaign has actually reached since its local midnight. */
const campaignSentToday = (campaign, now = new Date()) =>
  prisma.campaignRecipient.count({
    where: {
      campaignId: campaign.id,
      processedAt: { gte: startOfLocalToday(campaign.tzOffsetMinutes, now) },
      OR: [{ emailState: "SENT" }, { waState: "SENT" }],
    },
  });

/** How many messages an account/device has sent since midnight. */
export const sentTodayCount = (channel, senderId) =>
  prisma.outreachMessage.count({
    where: {
      direction: "OUTBOUND",
      sentAt: { gte: startOfToday() },
      thread: channel === "EMAIL" ? { channel: "EMAIL", accountId: senderId } : { channel: "WHATSAPP", waAccountId: senderId },
    },
  });

/** Best usable email on a lead's company, source-authored proof first. */
export const pickEmailContact = (contacts) => {
  const usable = contacts.filter((c) => c.kind === "EMAIL" && !c.isSuppressed && c.roleHint !== "NON_OUTREACH");
  const rank = (c) => (c.confidenceLevel === "VERIFIED" ? 2 : 1) + (c.roleHint === "ROLE" ? 1 : 0);
  return usable.sort((a, b) => rank(b) - rank(a))[0] || null;
};

/** Best number to WhatsApp: an explicit WhatsApp contact beats a plain phone. */
// Re-exported rather than redefined: which number to try on WhatsApp is one
// decision, and it lives in phoneRank.js. Keeping the name exported here means
// every existing importer (and its tests) is unaffected by the move.
export { pickWhatsAppNumber };

/**
 * Create a campaign over a set of leads.
 *
 * Obvious dead recipients (no address for the channel, or a status a human has
 * locked) are marked SKIPPED at creation so the progress bar is honest from
 * second one, rather than discovering half the list is unreachable mid-drain.
 */
export const createCampaign = async ({
  name, leadIds, channels, accountId = null, waAccountId = null, paceSeconds = 45,
  mode = "DIRECT", dailyLimit = null, windowStart = 9, windowEnd = 18, tzOffsetMinutes = 0,
  createdBy = null,
}) => {
  // The launcher owns every message the queue will send on their behalf, so the
  // attribution is resolved once here rather than per send — a campaign drained
  // over three days must still credit the person who started it.
  const actor = toActor(createdBy);
  const wantEmail = channels.includes("EMAIL");
  const wantWa = channels.includes("WHATSAPP");

  // Fail fast when the requested transport is not configured at all.
  if (wantEmail) {
    const account = await getAccount(accountId);
    if (!account) return { ok: false, error: "No connected email account. Add one in Settings → Outreach first." };
    accountId = account.id;
  }
  if (wantWa) {
    const device = await getWhatsAppAccount(waAccountId);
    if (!device) return { ok: false, error: "No linked WhatsApp device. Pair one in Settings → WhatsApp first." };
    waAccountId = device.id;
  }

  const uniqueIds = [...new Set(leadIds)].slice(0, MAX_RECIPIENTS);
  const leads = await prisma.lead.findMany({
    where: { id: { in: uniqueIds } },
    include: {
      company: { include: { contacts: { where: { isSuppressed: false } } } },
      // An existing conversation means this campaign must not pitch again.
      threads: { select: { channel: true } },
    },
  });
  if (leads.length === 0) return { ok: false, error: "None of the selected leads exist any more." };

  const LOCKED = new Set(["DO_NOT_CONTACT", "ARCHIVED", "DISQUALIFIED", "NOT_INTERESTED", "CONVERTED"]);

  const recipients = leads.map((lead) => {
    const locked = LOCKED.has(lead.status);
    const email = pickEmailContact(lead.company.contacts);
    const wa = pickWhatsAppNumber(lead.company.contacts, lead.company.countryCode);
    const hasEmailThread = lead.threads.some((t) => t.channel === "EMAIL");
    const hasWaThread = lead.threads.some((t) => t.channel === "WHATSAPP");

    // The legal gate comes before every other reason to skip: in the opt-in
    // markets a cold email is unlawful however good the address is, and a
    // single one is actionable by the recipient without any regulator.
    const emailPolicy = sendPolicyFor({
      countryCode: lead.company.countryCode,
      channel: "EMAIL",
      roleAddress: isRoleAddress(email),
    });
    const waPolicy = sendPolicyFor({ countryCode: lead.company.countryCode, channel: "WHATSAPP" });

    const emailState = !wantEmail ? ["SKIPPED", "Channel not in this campaign."]
      : isSendBlocked(emailPolicy) ? ["SKIPPED", `Cold email is not lawful in ${emailPolicy.country} (${emailPolicy.law}).`]
      : locked ? ["SKIPPED", `Lead status is ${lead.status} — locked by a human decision.`]
      : hasEmailThread ? ["SKIPPED", "Already in an email conversation."]
      : !email ? ["SKIPPED", "No usable email address on this lead."]
      : ["PENDING", email.value];

    const waState = !wantWa ? ["SKIPPED", "Channel not in this campaign."]
      : isSendBlocked(waPolicy) ? ["SKIPPED", `Cold messaging is not lawful in ${waPolicy.country} (${waPolicy.law}).`]
      : locked ? ["SKIPPED", `Lead status is ${lead.status} — locked by a human decision.`]
      : hasWaThread ? ["SKIPPED", "Already in a WhatsApp conversation."]
      : !wa ? ["SKIPPED", "No usable phone number on this lead."]
      // `display` rather than `number`: this string is shown in the campaign
      // log and echoed in any send error, so it stays in the form a human wrote.
      : ["PENDING", wa.display];

    return {
      leadId: lead.id,
      emailState: emailState[0], emailDetail: emailState[1].slice(0, 300),
      waState: waState[0], waDetail: waState[1].slice(0, 300),
    };
  });

  const sendable = recipients.filter((r) => r.emailState === "PENDING" || r.waState === "PENDING");

  const campaign = await prisma.outreachCampaign.create({
    data: {
      name: (name || `Bulk send · ${new Date().toLocaleDateString("en-GB")}`).slice(0, 160),
      channels, accountId: wantEmail ? accountId : null, waAccountId: wantWa ? waAccountId : null,
      paceSeconds: Math.max(20, Math.min(600, paceSeconds)),
      mode,
      dailyLimit: mode === "AUTO" ? (dailyLimit || AUTO_DEFAULT_DAILY_LIMIT) : null,
      windowStart, windowEnd, tzOffsetMinutes,
      createdById: actor?.id ?? null, createdByName: actor?.name ?? null,
      status: sendable.length ? "RUNNING" : "COMPLETED",
      completedAt: sendable.length ? null : new Date(),
      recipients: { create: recipients },
    },
  });

  logger.info({ campaignId: campaign.id, leads: leads.length, sendable: sendable.length, channels, createdBy: actor?.id || "system" }, "campaign created");
  return { ok: true, campaign: await campaignWithProgress(campaign.id), skippedUpfront: recipients.length - sendable.length };
};

/**
 * The console account a campaign's sends are recorded against: whoever launched
 * it. Null for campaigns created before attribution existed, which then read as
 * system sends rather than being misattributed to someone.
 */
const campaignActor = (campaign) =>
  campaign.createdById ? { id: campaign.createdById, name: campaign.createdByName } : null;

/** One send attempt for one recipient on one channel. Never throws. */
const attemptEmail = async (campaign, recipient) => {
  try {
    const account = await getAccount(campaign.accountId);
    if (!account) return ["FAILED", "The sending account is gone or disabled."];

    // A mailbox still in its warm-up sends far less than the configured cap.
    // The two messages are kept distinct because an operator who sees five
    // emails go out and reads "daily cap of 150 reached" concludes the queue is
    // broken, and the next thing they do is turn the pacing off.
    const rampCap = warmupDailyCap(account);
    const cap = Math.min(DAILY_EMAIL_CAP, rampCap);
    if ((await sentTodayCount("EMAIL", account.id)) >= cap) {
      return ["PENDING", rampCap < DAILY_EMAIL_CAP
        ? `Warm-up limit of ${cap} reached — this mailbox is still ramping up to its full cap. Resumes tomorrow.`
        : `Daily cap of ${cap} reached — resumes tomorrow.`];
    }

    // Verification gate: a bounce costs sender reputation the whole domain
    // pays for, so an address that cannot receive mail is skipped, not tried.
    const domain = recipient.emailDetail.split("@")[1]?.toLowerCase() || "";
    if (emailLooksMangled(recipient.emailDetail) || BROKER_DOMAIN_RE.test(domain)) {
      return ["SKIPPED", "Address failed verification (malformed or broker domain)."];
    }
    if (!(await domainHasMx(domain))) {
      return ["SKIPPED", `${domain} has no mail server — the address would bounce.`];
    }

    // The freshest draft wins; a lead without one gets the deterministic
    // template through the same composer the research flow uses.
    let draft = await prisma.leadEmailDraft.findFirst({ where: { leadId: recipient.leadId }, orderBy: { createdAt: "desc" } });
    if (!draft) draft = await composeEmailForLead({ leadId: recipient.leadId });
    if (!draft) return ["SKIPPED", "No email could be composed for this lead."];

    const res = await sendInitialEmail({
      account, leadId: recipient.leadId,
      to: recipient.emailDetail, subject: draft.subject, body: draft.body, draftId: draft.id,
      sentBy: campaignActor(campaign),
    });
    return res.ok ? ["SENT", recipient.emailDetail] : [/failed/i.test(res.error) ? "FAILED" : "SKIPPED", res.error.slice(0, 300)];
  } catch (err) {
    return ["FAILED", String(err.message).slice(0, 300)];
  }
};

const attemptWhatsApp = async (campaign, recipient) => {
  try {
    const device = await getWhatsAppAccount(campaign.waAccountId);
    if (!device) return ["FAILED", "The sending device is gone or unpaired."];

    if ((await sentTodayCount("WHATSAPP", device.id)) >= DAILY_WA_CAP) {
      return ["PENDING", `Daily cap of ${DAILY_WA_CAP} reached — resumes tomorrow.`];
    }

    const gathered = await gatherFacts(recipient.leadId);
    if (!gathered) return ["SKIPPED", "Lead vanished before sending."];
    const serviceLabel = SERVICE_LABELS[gathered.lead.primaryOpportunity] || "software development";
    const message = whatsappInitialTemplate({ company: gathered.company, facts: gathered.facts, serviceLabel }).body;

    const res = await sendWhatsAppForLead({
      leadId: recipient.leadId, phone: recipient.waDetail, message, waAccountId: device.id,
      sentBy: campaignActor(campaign),
    });
    return res.ok ? ["SENT", recipient.waDetail] : [/not (?:connected|linked)|device/i.test(res.error) ? "FAILED" : "SKIPPED", res.error.slice(0, 300)];
  } catch (err) {
    return ["FAILED", String(err.message).slice(0, 300)];
  }
};

/**
 * Stop a campaign whose sending mailbox is bouncing, before it sends anything
 * more. Never throws and never pauses on a small sample: the cost of a wrong
 * pause is a campaign an operator has to restart, the cost of not pausing is a
 * domain that takes weeks to recover.
 *
 * @returns {Promise<boolean>} whether the campaign was paused
 */
const pauseIfBouncing = async (campaign) => {
  try {
    const channels = Array.isArray(campaign.channels) ? campaign.channels : [];
    if (!channels.includes("EMAIL")) return false;

    const account = await getAccount(campaign.accountId);
    if (!account) return false;

    const stats = await bounceRate({ accountId: account.id });
    if (!shouldPauseForBounces(stats)) return false;

    const reason =
      `Paused automatically: ${stats.bounced} of the last ${stats.sent} emails from ${account.email} came back undelivered `
      + `(${(stats.rate * 100).toFixed(1)}%), over the ${(BOUNCE_PAUSE_THRESHOLD * 100).toFixed(0)}% a sending domain can absorb. `
      + `Clean the remaining addresses before resuming.`;

    await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: { status: "PAUSED", pausedReason: reason.slice(0, 300) },
    });
    logger.warn(
      { campaignId: campaign.id, name: campaign.name, email: account.email, rate: stats.rate, sent: stats.sent, bounced: stats.bounced },
      "campaign paused — bounce rate above threshold",
    );
    return true;
  } catch (err) {
    // A failed rate check must not stop the queue; it just means this tick
    // sends under the same rules it did before the guard existed.
    logger.warn({ campaignId: campaign.id, msg: err.message }, "bounce guard check failed");
    return false;
  }
};

/**
 * Drain step, called by the worker every minute.
 *
 * Per campaign: honour the pace, then process recipients until one *actual
 * send* happens (skips don't count against the pace — a run of dead rows
 * should not stall the queue for an hour).
 */
export const runCampaignTick = async () => {
  const campaigns = await prisma.outreachCampaign.findMany({ where: { status: "RUNNING" }, orderBy: { createdAt: "asc" } });
  const summary = { campaigns: campaigns.length, sent: 0, skipped: 0, failed: 0, completed: 0, paused: 0 };

  for (const campaign of campaigns) {
    // The bounce guard, once per tick rather than per recipient: a list that is
    // bouncing is doing damage that outlives the campaign, and by the time a
    // person notices, the sending domain is already the thing that needs
    // repairing. Checked before the window and pacing checks so a campaign that
    // is asleep for the night still gets stopped rather than resuming at 9am.
    if (await pauseIfBouncing(campaign)) { summary.paused += 1; continue; }

    // AUTO campaigns sleep outside their local working-hours window and stop
    // for the day once the daily quota is reached; rows simply stay PENDING.
    if (!isWithinSendWindow(campaign)) continue;
    if (campaign.mode === "AUTO" && campaign.dailyLimit
      && (await campaignSentToday(campaign)) >= campaign.dailyLimit) continue;

    const gapSeconds = campaign.mode === "AUTO" ? autoGapSeconds(campaign) : campaign.paceSeconds;
    const sinceLast = campaign.lastSentAt ? Date.now() - campaign.lastSentAt.getTime() : Infinity;
    if (sinceLast < gapSeconds * 1000) continue;

    let sentThisTick = false;
    // Bounded loop: burn through skips quickly, stop after the first real send.
    for (let i = 0; i < 10 && !sentThisTick; i += 1) {
      const recipient = await prisma.campaignRecipient.findFirst({
        where: { campaignId: campaign.id, OR: [{ emailState: "PENDING" }, { waState: "PENDING" }] },
        orderBy: { id: "asc" },
      });
      if (!recipient) break;

      const patch = { processedAt: new Date() };

      if (recipient.emailState === "PENDING") {
        const [state, detail] = await attemptEmail(campaign, recipient);
        // A cap-hit leaves the row PENDING for tomorrow and stops this campaign.
        if (state === "PENDING") { logger.info({ campaignId: campaign.id, detail }, "email cap reached"); break; }
        patch.emailState = state;
        patch.emailDetail = detail;
        if (state === "SENT") sentThisTick = true;
        summary[state === "SENT" ? "sent" : state === "FAILED" ? "failed" : "skipped"] += 1;
      }

      if (recipient.waState === "PENDING" && (patch.emailState === undefined || patch.emailState !== "PENDING")) {
        const [state, detail] = await attemptWhatsApp(campaign, recipient);
        if (state === "PENDING") { await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: patch }); break; }
        patch.waState = state;
        patch.waDetail = detail;
        if (state === "SENT") sentThisTick = true;
        summary[state === "SENT" ? "sent" : state === "FAILED" ? "failed" : "skipped"] += 1;
      }

      await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: patch });
    }

    if (sentThisTick) {
      await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { lastSentAt: new Date() } });
    }

    const remaining = await prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, OR: [{ emailState: "PENDING" }, { waState: "PENDING" }] },
    });
    if (remaining === 0) {
      await prisma.outreachCampaign.update({ where: { id: campaign.id }, data: { status: "COMPLETED", completedAt: new Date() } });
      summary.completed += 1;
      logger.info({ campaignId: campaign.id, name: campaign.name }, "campaign completed");
    }
  }

  return summary;
};

const STATE_KEYS = ["PENDING", "SENT", "SKIPPED", "FAILED"];

export const campaignWithProgress = async (campaignId) => {
  const campaign = await prisma.outreachCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return null;

  const [emailStates, waStates, total] = await Promise.all([
    prisma.campaignRecipient.groupBy({ by: ["emailState"], where: { campaignId }, _count: { _all: true } }),
    prisma.campaignRecipient.groupBy({ by: ["waState"], where: { campaignId }, _count: { _all: true } }),
    prisma.campaignRecipient.count({ where: { campaignId } }),
  ]);
  const shape = (rows, key) => Object.fromEntries(STATE_KEYS.map((s) => [s.toLowerCase(), rows.find((r) => r[key] === s)?._count._all || 0]));

  return {
    id: campaign.id, name: campaign.name, channels: campaign.channels,
    // Carried to the UI so a campaign the bounce guard stopped can say so. A
    // paused campaign with no stated reason invites the one wrong response —
    // pressing Resume, which just trips the guard again on the next tick.
    status: campaign.status, pausedReason: campaign.pausedReason, paceSeconds: campaign.paceSeconds,
    mode: campaign.mode, dailyLimit: campaign.dailyLimit,
    windowStart: campaign.windowStart, windowEnd: campaign.windowEnd,
    tzOffsetMinutes: campaign.tzOffsetMinutes,
    accountId: campaign.accountId, waAccountId: campaign.waAccountId,
    // Who launched it. Every send it makes is recorded against this person, so
    // the list view names them rather than leaving a bulk run anonymous.
    createdById: campaign.createdById, createdByName: campaign.createdByName,
    createdAt: campaign.createdAt, completedAt: campaign.completedAt, lastSentAt: campaign.lastSentAt,
    total,
    email: shape(emailStates, "emailState"),
    whatsapp: shape(waStates, "waState"),
  };
};

export const listCampaigns = async ({ take = 25 } = {}) => {
  const rows = await prisma.outreachCampaign.findMany({ orderBy: { createdAt: "desc" }, take });
  return Promise.all(rows.map((c) => campaignWithProgress(c.id)));
};

export const setCampaignStatus = async (campaignId, status) => {
  const campaign = await prisma.outreachCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { ok: false, error: "Campaign not found." };
  if (["COMPLETED", "CANCELLED"].includes(campaign.status)) return { ok: false, error: `Campaign is already ${campaign.status.toLowerCase()}.` };

  if (status === "CANCELLED") {
    // Pending rows are closed out so the numbers still add up afterwards.
    await prisma.campaignRecipient.updateMany({
      where: { campaignId, emailState: "PENDING" },
      data: { emailState: "SKIPPED", emailDetail: "Campaign cancelled before this lead was reached." },
    });
    await prisma.campaignRecipient.updateMany({
      where: { campaignId, waState: "PENDING" },
      data: { waState: "SKIPPED", waDetail: "Campaign cancelled before this lead was reached." },
    });
  }
  await prisma.outreachCampaign.update({
    where: { id: campaignId },
    data: {
      status,
      ...(status === "CANCELLED" ? { completedAt: new Date() } : {}),
      // Resuming clears the old explanation rather than leaving it to be read
      // as the current state. If the addresses were not actually cleaned, the
      // guard writes a fresh reason on the next tick.
      ...(status === "RUNNING" ? { pausedReason: null } : {}),
    },
  });
  return { ok: true, campaign: await campaignWithProgress(campaignId) };
};
