import prisma from "../../prismaClient.js";
import {
  buildRecipientRows, LOCKED_LEAD_STATUSES, DAILY_EMAIL_CAP, DAILY_WA_CAP,
  pickEmailContact,
} from "./campaigns.js";
import { getAccount } from "./service.js";
import { getWhatsAppAccount } from "./whatsapp.js";
import { sendPolicyFor, isRoleAddress, POLICY } from "./sendPolicy.js";
import { warmupDailyCap } from "./deliverability.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:autopilot");

/**
 * The standing automation.
 *
 * Everything here is *scheduling*: which leads become eligible, which regional
 * campaign they join, and how the day's budget is split between those
 * campaigns. Not one message is sent from this file. The campaigns it maintains
 * are ordinary AUTO campaigns, drained by `runCampaignTick` under the same
 * pacing, caps, warm-up ramp, bounce guard and legal gate as a campaign a human
 * launched by hand — which is the point. An automation that sends unattended is
 * the last place to fork the safety rules.
 */

/** Only ever one settings row. */
export const AUTOPILOT_ID = "singleton";

/**
 * Regional lanes.
 *
 * One campaign carries one `tzOffsetMinutes`, so a single 09:00 window cannot
 * be local for London, Riyadh and New York at once. Splitting by region is what
 * makes "send at 9am their time" true rather than approximately true, and the
 * offsets stagger the lanes across the day so they rarely contend for the
 * mailbox at the same minute.
 *
 * `UK_EU` is last and takes everything unmatched, including leads whose country
 * we never resolved — UK hours are the safest middle for an unknown location.
 */
export const LANES = [
  {
    key: "GULF",
    label: "Gulf",
    tzOffsetMinutes: 180, // Riyadh; Dubai is one hour later and still in window
    countries: ["AE", "SA", "QA", "KW", "BH", "OM"],
  },
  {
    key: "US",
    label: "North America",
    tzOffsetMinutes: -300, // US Eastern; a west-coast lead gets late morning
    countries: ["US", "CA"],
  },
  {
    key: "UK_EU",
    label: "UK & Europe",
    tzOffsetMinutes: 60,
    countries: null, // the catch-all
  },
];

const NAMED_COUNTRIES = LANES.flatMap((l) => l.countries || []);

/** The lane a country belongs to. Unknown or unlisted countries fall to UK_EU. */
export const laneFor = (countryCode) => {
  const code = String(countryCode || "").toUpperCase();
  return LANES.find((l) => l.countries?.includes(code)) || LANES[LANES.length - 1];
};

/** The campaign name a lane owns. Stable, because it is how the lane is found again. */
export const laneCampaignName = (lane) => `Autopilot · ${lane.label}`;

/** Load the settings row, creating the default (disabled) one on first read. */
export const getAutopilot = async () => {
  const existing = await prisma.outreachAutopilot.findUnique({ where: { id: AUTOPILOT_ID } });
  if (existing) return existing;
  return prisma.outreachAutopilot.create({ data: { id: AUTOPILOT_ID } });
};

export const updateAutopilot = async (patch) => {
  await getAutopilot();
  return prisma.outreachAutopilot.update({ where: { id: AUTOPILOT_ID }, data: patch });
};

/**
 * Whether this lead may be emailed automatically under the chosen policy.
 *
 * BLOCKED is never sendable by anyone. The three settings differ only over
 * RESTRICTED markets:
 *
 *   SEND      — as a hand-launched campaign behaves today.
 *   ROLE_ONLY — the verdict must come back ALLOWED, which for the Gulf markets
 *               happens exactly when the address is a role mailbox: it
 *               identifies no individual, so the data-protection law that
 *               restricts the market does not reach it.
 *   HOLD      — the country's own rule must be ALLOWED, ignoring the role-mailbox
 *               lift, which leaves only the opt-out markets.
 */
export const emailAdmissible = (lead, restrictedPolicy) => {
  const countryCode = lead.company?.countryCode;
  const contact = pickEmailContact(lead.company?.contacts || []);
  if (!contact) return false;

  const verdict = sendPolicyFor({ countryCode, channel: "EMAIL", roleAddress: isRoleAddress(contact) });
  if (verdict.policy === POLICY.BLOCKED) return false;
  if (restrictedPolicy === "SEND") return true;
  if (restrictedPolicy === "ROLE_ONLY") return verdict.policy === POLICY.ALLOWED;

  const base = sendPolicyFor({ countryCode, channel: "EMAIL", roleAddress: false });
  return base.policy === POLICY.ALLOWED;
};

/** WhatsApp has no role-mailbox equivalent, so only BLOCKED and HOLD apply. */
export const whatsappAdmissible = (lead, restrictedPolicy) => {
  const verdict = sendPolicyFor({ countryCode: lead.company?.countryCode, channel: "WHATSAPP" });
  if (verdict.policy === POLICY.BLOCKED) return false;
  if (restrictedPolicy === "HOLD") return verdict.policy === POLICY.ALLOWED;
  return true;
};

/** Country filter for a lane, written so a NULL countryCode lands in the catch-all. */
const laneCompanyWhere = (lane) =>
  lane.countries
    ? { countryCode: { in: lane.countries } }
    : { OR: [{ countryCode: null }, { countryCode: { notIn: NAMED_COUNTRIES } }] };

/**
 * Leads this lane could still pitch.
 *
 * Promoter leads are excluded outright: they were found for a specific product
 * campaign and are worked deliberately, not swept up by a standing automation.
 */
export const eligibleLeads = async ({ lane, settings, excludeLeadIds = [], take = 200 }) => {
  const channels = Array.isArray(settings.channels) ? settings.channels : [];
  const wantEmail = channels.includes("EMAIL");
  const wantWa = channels.includes("WHATSAPP");

  const leads = await prisma.lead.findMany({
    where: {
      status: { notIn: LOCKED_LEAD_STATUSES },
      // A lead already in any conversation is not a cold prospect any more.
      threads: { none: {} },
      company: { is: laneCompanyWhere(lane) },
      // Leads only, never the promoter book. A lead with no run at all is an
      // ordinary lead, so the null case has to be spelled out separately —
      // a relation filter alone would drop it.
      OR: [{ discoveryRunId: null }, { discoveryRun: { promotedProductId: null } }],
      ...(excludeLeadIds.length ? { id: { notIn: excludeLeadIds } } : {}),
    },
    include: {
      company: { include: { contacts: { where: { isSuppressed: false } }, people: true } },
      threads: { select: { channel: true } },
      // Same reason as the hand-launched path: a promoter lead's approved
      // profile names the buyer, and buildRecipientRows picks the inbox from it.
      discoveryRun: { select: { promotedProduct: { select: { icp: true } } } },
    },
    orderBy: [{ score: "desc" }, { createdAt: "asc" }],
    take,
  });

  return leads.filter((lead) =>
    (wantEmail && emailAdmissible(lead, settings.restrictedPolicy))
    || (wantWa && whatsappAdmissible(lead, settings.restrictedPolicy)));
};

/**
 * The day's total send budget, and how it divides between lanes.
 *
 * Every lane shares one mailbox, so the cap is global — giving each lane the
 * full 40 would mean the first lane to wake up spends the whole day's budget
 * and the others silently stall. The split is proportional to how much work
 * each lane actually has, with a floor so a small lane is never starved to
 * nothing by a large one.
 */
export const allocateBudget = ({ total, pendingByLane, minPerLane = 5 }) => {
  const lanes = Object.entries(pendingByLane).filter(([, n]) => n > 0);
  if (!lanes.length || total <= 0) return {};

  // The floor cannot hold when the whole day's budget is smaller than it — and
  // that is precisely where a warming mailbox starts, at five a day across
  // three regions. Shrinking the floor to what the budget actually covers keeps
  // the split honest; keeping it at five would hand out three times the cap and
  // leave the lanes racing each other for a budget only one of them can spend.
  const floor = Math.min(minPerLane, Math.floor(total / lanes.length));

  const work = lanes.reduce((sum, [, n]) => sum + n, 0);
  const share = {};
  for (const [key, n] of lanes) share[key] = Math.max(floor, Math.round((n / work) * total));

  const busiestFirst = lanes.map(([key]) => key).sort((a, b) => pendingByLane[b] - pendingByLane[a]);
  let assigned = Object.values(share).reduce((a, b) => a + b, 0);

  // Rounding can land either side of the cap. Trim the largest shares first,
  // never below the floor; hand any slack to the lanes with the most work.
  while (assigned > total) {
    const key = busiestFirst.slice().sort((a, b) => share[b] - share[a])[0];
    if (share[key] <= floor) break;
    share[key] -= 1;
    assigned -= 1;
  }
  for (let i = 0; assigned < total; i += 1) {
    share[busiestFirst[i % busiestFirst.length]] += 1;
    assigned += 1;
  }
  return share;
};

/** The lane's standing campaign, whatever state it is in. */
const findLaneCampaign = (lane) =>
  prisma.outreachCampaign.findFirst({
    where: { name: laneCampaignName(lane), mode: "AUTO" },
    orderBy: { createdAt: "desc" },
  });

/**
 * One pass: top every lane up and re-split the day's budget.
 *
 * Runs on a slow cadence — the campaigns drain themselves every minute, so this
 * only has to notice new leads and keep the limits honest.
 */
export const runAutopilotTick = async (now = new Date()) => {
  const settings = await getAutopilot();
  if (!settings.enabled) return { skipped: "autopilot disabled" };

  const channels = Array.isArray(settings.channels) ? settings.channels : [];
  const wantEmail = channels.includes("EMAIL");
  const wantWa = channels.includes("WHATSAPP");
  if (!wantEmail && !wantWa) return { skipped: "no channels enabled" };

  const account = wantEmail ? await getAccount(null) : null;
  const device = wantWa ? await getWhatsAppAccount(null) : null;
  if (wantEmail && !account) return { skipped: "no connected email account" };
  if (wantWa && !device) return { skipped: "no linked WhatsApp device" };

  // The ramp is the real ceiling on a young mailbox, and it moves every few
  // days — so the budget is recomputed here rather than frozen at setup.
  const rampCap = account ? warmupDailyCap(account) : Infinity;
  const emailCeiling = Math.min(DAILY_EMAIL_CAP, rampCap);
  const ceiling = wantEmail ? emailCeiling : DAILY_WA_CAP;
  const total = Math.max(1, Math.min(settings.dailyLimit || ceiling, ceiling));

  const lanes = [];
  for (const lane of LANES) {
    const campaign = await findLaneCampaign(lane);
    const existingIds = campaign
      ? (await prisma.campaignRecipient.findMany({
          where: { campaignId: campaign.id }, select: { leadId: true },
        })).map((r) => r.leadId)
      : [];

    const leads = await eligibleLeads({ lane, settings, excludeLeadIds: existingIds });
    lanes.push({ lane, campaign, leads });
  }

  // Nothing to do at all: say so rather than leaving empty campaigns running.
  const anyWork = lanes.some((l) => l.leads.length > 0 || l.campaign);
  if (!anyWork) {
    await updateAutopilot({ lastRunAt: now, lastResult: { toppedUp: 0, note: "no eligible leads" } });
    return { toppedUp: 0, note: "no eligible leads" };
  }

  const result = { lanes: {}, toppedUp: 0, created: 0, budget: total };

  for (const { lane, campaign, leads } of lanes) {
    const rows = buildRecipientRows(leads, { wantEmail, wantWa });
    const sendable = rows.filter((r) => r.emailState === "PENDING" || r.waState === "PENDING");

    let target = campaign;
    if (!target && sendable.length) {
      target = await prisma.outreachCampaign.create({
        data: {
          name: laneCampaignName(lane),
          channels,
          accountId: wantEmail ? account.id : null,
          waAccountId: wantWa ? device.id : null,
          mode: "AUTO",
          status: "RUNNING",
          dailyLimit: 1, // re-set from the budget split below
          windowStart: settings.windowStart,
          windowEnd: settings.windowEnd,
          tzOffsetMinutes: lane.tzOffsetMinutes,
          sendDays: settings.sendDays,
          startAt: now,
          createdByName: "Autopilot",
          recipients: { createMany: { data: rows } },
        },
      });
      result.created += 1;
      result.lanes[lane.key] = { created: true, added: sendable.length };
    } else if (target && rows.length) {
      // skipDuplicates guards the race where a lead was added between the
      // eligibility read and this write.
      const added = await prisma.campaignRecipient.createMany({
        data: rows.map((r) => ({ ...r, campaignId: target.id })),
        skipDuplicates: true,
      });
      result.toppedUp += added.count;
      result.lanes[lane.key] = { added: added.count };
    } else {
      result.lanes[lane.key] = { added: 0 };
    }
  }

  // Re-split the budget over lanes that still have work, then wake any lane
  // that had run dry and has now been topped up.
  const pendingByLane = {};
  const campaignByLane = {};
  for (const lane of LANES) {
    const campaign = await findLaneCampaign(lane);
    if (!campaign) continue;
    campaignByLane[lane.key] = campaign;
    pendingByLane[lane.key] = await prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, OR: [{ emailState: "PENDING" }, { waState: "PENDING" }] },
    });
  }

  const split = allocateBudget({ total, pendingByLane });
  for (const [key, campaign] of Object.entries(campaignByLane)) {
    const limit = split[key] || 0;
    const pending = pendingByLane[key] || 0;
    await prisma.outreachCampaign.update({
      where: { id: campaign.id },
      data: {
        dailyLimit: Math.max(1, limit),
        windowStart: settings.windowStart,
        windowEnd: settings.windowEnd,
        sendDays: settings.sendDays,
        // A campaign the drain completed is revived once it has work again.
        // A PAUSED one is left alone: it was stopped by the bounce guard or by
        // a person, and reviving it automatically would override that.
        ...(pending > 0 && campaign.status === "COMPLETED"
          ? { status: "RUNNING", completedAt: null }
          : {}),
      },
    });
    result.lanes[key] = { ...(result.lanes[key] || {}), dailyLimit: Math.max(1, limit), pending };
  }

  await updateAutopilot({ lastRunAt: now, lastResult: result });
  logger.info(result, "autopilot tick");
  return result;
};

/**
 * Pause every lane. Called when the switch is turned off, so the drain stops on
 * the next tick rather than after the current day's quota.
 */
export const pauseAllLanes = async (reason = "Autopilot switched off.") => {
  const names = LANES.map(laneCampaignName);
  const { count } = await prisma.outreachCampaign.updateMany({
    where: { name: { in: names }, mode: "AUTO", status: { in: ["RUNNING", "SCHEDULED"] } },
    data: { status: "PAUSED", pausedReason: reason.slice(0, 300) },
  });
  return count;
};

/** Resume lanes the switch itself paused, leaving bounce-guard pauses stopped. */
export const resumeAllLanes = async () => {
  const names = LANES.map(laneCampaignName);
  const { count } = await prisma.outreachCampaign.updateMany({
    where: {
      name: { in: names }, mode: "AUTO", status: "PAUSED",
      pausedReason: { startsWith: "Autopilot switched off" },
    },
    data: { status: "RUNNING", pausedReason: null },
  });
  return count;
};

/**
 * What the settings panel shows: the switch, today's progress per lane, and how
 * much work is left. Read-only.
 */
export const autopilotStatus = async (now = new Date()) => {
  const settings = await getAutopilot();
  const account = await getAccount(null);
  const rampCap = account ? warmupDailyCap(account) : Infinity;
  const emailCeiling = Math.min(DAILY_EMAIL_CAP, rampCap);

  const lanes = [];
  for (const lane of LANES) {
    const campaign = await findLaneCampaign(lane);
    if (!campaign) {
      lanes.push({ key: lane.key, label: lane.label, status: null, pending: 0, sentToday: 0, dailyLimit: 0 });
      continue;
    }
    const [pending, sentToday] = await Promise.all([
      prisma.campaignRecipient.count({
        where: { campaignId: campaign.id, OR: [{ emailState: "PENDING" }, { waState: "PENDING" }] },
      }),
      prisma.campaignRecipient.count({
        where: {
          campaignId: campaign.id,
          processedAt: { gte: new Date(now.getTime() - 86_400_000) },
          OR: [{ emailState: "SENT" }, { waState: "SENT" }],
        },
      }),
    ]);
    lanes.push({
      key: lane.key, label: lane.label, campaignId: campaign.id,
      status: campaign.status, pausedReason: campaign.pausedReason,
      dailyLimit: campaign.dailyLimit, pending, sentToday,
      windowStart: campaign.windowStart, windowEnd: campaign.windowEnd,
      tzOffsetMinutes: campaign.tzOffsetMinutes,
    });
  }

  return {
    settings,
    emailCeiling: Number.isFinite(emailCeiling) ? emailCeiling : null,
    warmupCap: Number.isFinite(rampCap) ? rampCap : null,
    account: account ? { email: account.email, warmupStartedAt: account.warmupStartedAt } : null,
    lanes,
  };
};
