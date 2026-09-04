import prisma from "../../prismaClient.js";
import { getAccount, sendInitialEmail, sendWhatsAppForLead } from "./service.js";
import { getWhatsAppAccount } from "./whatsapp.js";
import { pickWhatsAppNumber } from "./phoneRank.js";
import { sendPolicyFor, isRoleAddress, isSendBlocked, POLICY } from "./sendPolicy.js";
import { domainHasMx, emailLooksMangled, BROKER_DOMAIN_RE } from "./hygiene.js";
import { buyerInboxes, inboxScore } from "./inboxFit.js";
import { emailBelongsToPlatform } from "../verify/hostedPlatforms.js";
import { classifyCompanyExclusion } from "../qualify/excludedCategories.js";
import { emailMatchesName } from "../extract/people.js";
import { bounceRate, shouldPauseForBounces, warmupDailyCap, BOUNCE_PAUSE_THRESHOLD } from "./deliverability.js";
import { composeEmailForLead, gatherFacts, promotedProductForLead } from "../research/compose.js";
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
/**
 * The most leads one campaign may hold. Generous on purpose: the daily cap,
 * not the list size, is what protects the sender — a 2,000-lead campaign at
 * 40 a day is seven weeks of unremarkable volume, not a blast.
 */
export const CAMPAIGN_MAX_RECIPIENTS = Math.max(1, Number(process.env.OUTREACH_MAX_RECIPIENTS || 2000));
/** A start time further out than this is almost certainly a typo in the year. */
export const MAX_SCHEDULE_AHEAD_DAYS = 90;
/** Every local weekday, the meaning of a null `sendDays`. */
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

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

/** Day of week (0 = Sunday … 6 = Saturday) at the campaign's timezone offset. */
export const localWeekday = (tzOffsetMinutes, now = new Date()) =>
  new Date(now.getTime() + tzOffsetMinutes * 60_000).getUTCDay();

/**
 * The local weekdays a campaign may send on. Null or an empty list means every
 * day — the behaviour of every campaign created before the field existed.
 */
export const sendDaysOf = (campaign) => {
  const days = Array.isArray(campaign.sendDays) ? campaign.sendDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return days.length ? [...new Set(days)].sort((a, b) => a - b) : ALL_DAYS;
};

/**
 * Whether today (locally) is a day this campaign sends on. DIRECT campaigns
 * ignore the calendar; the day rule is part of the AUTO schedule.
 *
 * A B2B email that lands on a Saturday is read on Monday under forty others,
 * and a burst of cold mail on a weekend is itself a spam signal — so the UI
 * defaults AUTO campaigns to working days and offers the Sun–Thu week for the
 * Gulf markets.
 */
export const isSendDay = (campaign, now = new Date()) => {
  if (campaign.mode !== "AUTO") return true;
  return sendDaysOf(campaign).includes(localWeekday(campaign.tzOffsetMinutes, now));
};

/**
 * DIRECT campaigns send around the clock; AUTO only inside its local window,
 * on its send days.
 */
export const isWithinSendWindow = (campaign, now = new Date()) => {
  if (campaign.mode !== "AUTO") return true;
  if (!isSendDay(campaign, now)) return false;
  const h = localHour(campaign.tzOffsetMinutes, now);
  return h >= campaign.windowStart && h < campaign.windowEnd;
};

/**
 * Whether a start time means "later" rather than "now". A minute of slack
 * absorbs the gap between a browser filling in "now" and the request landing,
 * so a campaign asked to start immediately never sits SCHEDULED for a tick.
 */
export const isFutureStart = (startAt, now = new Date()) =>
  startAt instanceof Date && !Number.isNaN(startAt.getTime()) && startAt.getTime() > now.getTime() + 60_000;

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

/**
 * Best usable email on a lead's company, source-authored proof first.
 *
 * `icp` is optional and only ever breaks ties the confidence ranking leaves
 * open: when it is supplied, an address belonging to the department that
 * actually buys this product outranks one belonging to a department that does
 * not. Without it the behaviour is exactly as before.
 */
export const pickEmailContact = (contacts, icp = null, { people = [], countryCode = null } = {}) => {
  const usable = contacts.filter((c) =>
    c.kind === "EMAIL" && !c.isSuppressed && c.roleHint !== "NON_OUTREACH"
    // Belt and braces: an address on the ordering platform or help desk whose
    // page it was read from is never the business's, whatever it was stored as.
    && !emailBelongsToPlatform(c.value));
  const buyer = icp ? buyerInboxes(icp) : [];

  // The owner's own address beats every generic inbox — but only where a
  // named address is lawful to cold-email. In the Gulf markets the legal
  // basis rests on the address identifying no individual (see sendPolicy.js),
  // so there the role mailbox stays preferred and a person's is a fallback.
  const namedAllowed = sendPolicyFor({ countryCode, channel: "EMAIL", roleAddress: false }).policy === POLICY.ALLOWED;
  const decisionMakers = namedAllowed
    ? (people || []).filter((p) => p.seniority === "OWNER" || p.seniority === "EXECUTIVE")
    : [];
  const ownerBonus = (c) => {
    const match = decisionMakers.find((p) =>
      (p.email && p.email.toLowerCase() === c.value.toLowerCase()) || emailMatchesName(c.value, p.fullName));
    if (!match) return 0;
    return match.seniority === "OWNER" ? 4 : 3;
  };

  const rank = (c) =>
    (c.confidenceLevel === "VERIFIED" ? 2 : 1)
    + (c.roleHint === "ROLE" ? 1 : 0)
    // Weighted above the two flags combined, because a verified address at the
    // wrong desk still reaches the wrong person: `admissions@` answers parents,
    // and an HR pitch dies there however well the address was proved.
    + (icp ? inboxScore(c.value, buyer) : 0)
    // And the person who decides beats the desk that forwards.
    + ownerBonus(c);
  return usable.sort((a, b) => rank(b) - rank(a))[0] || null;
};

/** Best number to WhatsApp: an explicit WhatsApp contact beats a plain phone. */
// Re-exported rather than redefined: which number to try on WhatsApp is one
// decision, and it lives in phoneRank.js. Keeping the name exported here means
// every existing importer (and its tests) is unaffected by the move.
export { pickWhatsAppNumber };

/** Statuses that mean a human has decided this lead is not to be pitched. */
export const LOCKED_LEAD_STATUSES = [
  "DO_NOT_CONTACT", "ARCHIVED", "DISQUALIFIED", "NOT_INTERESTED", "CONVERTED",
];
const LOCKED = new Set(LOCKED_LEAD_STATUSES);

/**
 * Decide each lead's per-channel starting state.
 *
 * Extracted so the autopilot can top up a standing campaign through exactly the
 * same gate a hand-launched one passes through. Duplicating this would mean two
 * places deciding whether a cold message is lawful, and the automated one — the
 * one no human reads before it sends — would be the copy that drifted.
 *
 * Each lead needs `company.contacts` and `threads` loaded.
 */
export const buildRecipientRows = (leads, { wantEmail, wantWa }) => leads.map((lead) => {
  const locked = LOCKED.has(lead.status);
  // A trade this agency does not work with. The scoring engine disqualifies
  // these, but a lead scored before the rule existed may still read NEW until
  // the next re-score, and this is the last gate before a message leaves.
  const excluded = classifyCompanyExclusion(lead.company);
  // The product this lead was sourced to sell, when it was sourced to sell one
  // — its approved profile names the buyer, and the buyer decides which of the
  // company's inboxes is the right one to write to.
  const icp = lead.discoveryRun?.promotedProduct?.icp || null;
  const email = pickEmailContact(lead.company.contacts, icp, { people: lead.company.people || [], countryCode: lead.company.countryCode });
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
    : excluded ? ["SKIPPED", `Excluded line of business (${excluded.label}: "${excluded.matched}").`]
    : isSendBlocked(emailPolicy) ? ["SKIPPED", `Cold email is not lawful in ${emailPolicy.country} (${emailPolicy.law}).`]
    : locked ? ["SKIPPED", `Lead status is ${lead.status} — locked by a human decision.`]
    : hasEmailThread ? ["SKIPPED", "Already in an email conversation."]
    : !email ? ["SKIPPED", "No usable email address on this lead."]
    : ["PENDING", email.value];

  const waState = !wantWa ? ["SKIPPED", "Channel not in this campaign."]
    : excluded ? ["SKIPPED", `Excluded line of business (${excluded.label}: "${excluded.matched}").`]
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
  sendDays = null, startAt = null,
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

  const uniqueIds = [...new Set(leadIds)].slice(0, CAMPAIGN_MAX_RECIPIENTS);
  const leads = await prisma.lead.findMany({
    where: { id: { in: uniqueIds } },
    include: {
      // People, so the owner's own address can outrank the generic inbox.
      company: { include: { contacts: { where: { isSuppressed: false } }, people: true } },
      // An existing conversation means this campaign must not pitch again.
      threads: { select: { channel: true } },
      // The approved profile behind a promoter lead, which names the buyer and
      // so decides which of the company's inboxes to write to.
      discoveryRun: { select: { promotedProduct: { select: { icp: true } } } },
    },
  });
  if (leads.length === 0) return { ok: false, error: "None of the selected leads exist any more." };

  const recipients = buildRecipientRows(leads, { wantEmail, wantWa });

  const sendable = recipients.filter((r) => r.emailState === "PENDING" || r.waState === "PENDING");

  // A start in the future parks the campaign as SCHEDULED; the worker promotes
  // it on the first tick at or after `startAt`. A start in the past (or within
  // the next minute) is simply "now", so the row records when it began.
  const scheduled = isFutureStart(startAt);
  const status = !sendable.length ? "COMPLETED" : scheduled ? "SCHEDULED" : "RUNNING";
  // The day rule only means something on an AUTO schedule; a DIRECT campaign
  // drains at its pace regardless, so nothing misleading is stored for it.
  const days = mode === "AUTO" ? sendDaysOf({ sendDays }) : null;

  const campaign = await prisma.outreachCampaign.create({
    data: {
      name: (name || `Bulk send · ${new Date().toLocaleDateString("en-GB")}`).slice(0, 160),
      channels, accountId: wantEmail ? accountId : null, waAccountId: wantWa ? waAccountId : null,
      paceSeconds: Math.max(20, Math.min(600, paceSeconds)),
      mode,
      dailyLimit: mode === "AUTO" ? (dailyLimit || AUTO_DEFAULT_DAILY_LIMIT) : null,
      windowStart, windowEnd, tzOffsetMinutes,
      // "Every day" is left NULL (the column default) so an old row and a new
      // every-day row read the same way. Omitted rather than set to null:
      // Prisma refuses a bare null on a Json column.
      ...(days && days.length < 7 ? { sendDays: days } : {}),
      startAt: scheduled ? startAt : new Date(),
      createdById: actor?.id ?? null, createdByName: actor?.name ?? null,
      status,
      completedAt: sendable.length ? null : new Date(),
      // One INSERT for the whole list rather than one per lead: at the
      // recipient cap the difference is a request that returns in well under a
      // second versus one that holds a transaction open for several.
      recipients: { createMany: { data: recipients } },
    },
  });

  logger.info({ campaignId: campaign.id, leads: leads.length, sendable: sendable.length, channels, status, startAt: campaign.startAt, createdBy: actor?.id || "system" }, "campaign created");
  return { ok: true, campaign: await campaignWithProgress(campaign.id), skippedUpfront: recipients.length - sendable.length };
};

/**
 * Promote every SCHEDULED campaign whose start time has arrived. Runs at the
 * top of each tick so a campaign scheduled for 09:00 sends its first message
 * on the 09:00 tick, not the one after.
 *
 * @returns {Promise<number>} how many campaigns started
 */
export const startDueCampaigns = async (now = new Date()) => {
  const { count } = await prisma.outreachCampaign.updateMany({
    where: { status: "SCHEDULED", startAt: { lte: now } },
    data: { status: "RUNNING" },
  });
  if (count) logger.info({ count }, "scheduled campaigns started");
  return count;
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
    const platform = emailBelongsToPlatform(recipient.emailDetail);
    if (platform) {
      return ["SKIPPED", `${recipient.emailDetail} belongs to ${platform.domain} (a ${platform.label}), not to the business.`];
    }
    if (!(await domainHasMx(domain))) {
      return ["SKIPPED", `${domain} has no mail server — the address would bounce.`];
    }

    // The freshest draft *that pitches the right thing* wins; a lead without
    // one gets the deterministic template through the same composer the
    // research flow uses.
    //
    // Scoped to the lead's own product rather than taken as "newest of any",
    // because the two kinds of draft live in the same table and a lead can
    // hold both. A promoter lead accumulates agency drafts every time
    // regenerateDrafts runs over the whole book, and those are written later
    // than the product pitch that the run itself composed — so "newest" sent
    // an HR-platform prospect a website-redesign pitch, which is both the
    // wrong offer and a stranger's first impression of the sender. Which
    // product a lead is for is a property of the lead (via its discovery run),
    // not of the campaign, so a mixed campaign still gets this right per row.
    const product = await promotedProductForLead(recipient.leadId);
    let draft = await prisma.leadEmailDraft.findFirst({
      where: { leadId: recipient.leadId, promotedProductId: product?.id ?? null },
      orderBy: { createdAt: "desc" },
    });
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
  const started = await startDueCampaigns();
  const campaigns = await prisma.outreachCampaign.findMany({ where: { status: "RUNNING" }, orderBy: { createdAt: "asc" } });
  const summary = { campaigns: campaigns.length, started, sent: 0, skipped: 0, failed: 0, completed: 0, paused: 0 };

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
    // The calendar side of the schedule: which local days it sends on, and
    // when it starts (or started). Both are what the card needs to say
    // "starts Monday 09:00, weekdays only" instead of just "scheduled".
    sendDays: campaign.mode === "AUTO" ? sendDaysOf(campaign) : null,
    startAt: campaign.startAt,
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
  // A campaign that has not begun has nothing to pause. It can be started
  // early (RUNNING) or dropped (CANCELLED); PAUSED would only make "resume"
  // ambiguous about whether the original start time still applies.
  if (campaign.status === "SCHEDULED" && status === "PAUSED") {
    return { ok: false, error: "This campaign has not started yet — start it now or cancel it instead." };
  }
  const startingEarly = campaign.status === "SCHEDULED" && status === "RUNNING";
  // Resuming a campaign the bounce guard stopped is the human saying "the
  // addresses are cleaned". The guard's sample restarts from now on that
  // mailbox; otherwise the bounces it already reported re-pause the campaign
  // on the very next tick, for as long as they sit inside the 30-day window.
  const resumingAfterBounces =
    campaign.status === "PAUSED" && status === "RUNNING" && /^Paused automatically/.test(campaign.pausedReason || "");
  if (resumingAfterBounces) {
    const account = await getAccount(campaign.accountId);
    if (account) {
      await prisma.emailAccount.update({ where: { id: account.id }, data: { bounceGuardResetAt: new Date() } });
      logger.info({ campaignId, accountId: account.id }, "bounce guard sample reset by resume");
    }
  }

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
      // "Start now" on a scheduled campaign: the record says when it really
      // began, not when it was once meant to.
      ...(startingEarly ? { startAt: new Date() } : {}),
    },
  });
  return { ok: true, campaign: await campaignWithProgress(campaignId), started: startingEarly };
};
