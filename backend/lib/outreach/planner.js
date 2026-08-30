import prisma from "../../prismaClient.js";
import { getAccount } from "./service.js";
import { getWhatsAppAccount } from "./whatsapp.js";
import { warmupDailyCap, WARMUP_DAYS, NO_WARMUP_LIMIT } from "./deliverability.js";
import {
  DAILY_EMAIL_CAP, DAILY_WA_CAP, AUTO_DEFAULT_DAILY_LIMIT, CAMPAIGN_MAX_RECIPIENTS, MAX_SCHEDULE_AHEAD_DAYS,
  sentTodayCount,
} from "./campaigns.js";

/**
 * What a sender can safely take on today, before a campaign is built.
 *
 * The hard limits already live in the drain (`attemptEmail` stops at the
 * mailbox's cap whatever a campaign asked for). This module exists so the
 * person choosing a daily volume sees the same numbers the drain will enforce
 * — how much of the cap is spent, how much other campaigns have already
 * claimed, whether the mailbox is still warming up — instead of discovering
 * them as a campaign that quietly stops after five sends.
 */

const DAY_MS = 86_400_000;

/** The smallest daily volume a schedule can be built on. */
export const MIN_DAILY_LIMIT = 5;

/**
 * Pick a daily limit for a new campaign on a sender. Pure.
 *
 * @param {object} input
 * @param {number} input.hardCap    the most this sender may send in a day, today
 * @param {number} input.committed  daily volume other active campaigns already claim
 * @param {number} [input.standard] the volume a healthy sender defaults to
 * @returns {{recommended: number, headroom: number, fullyBooked: boolean}}
 *   `headroom` is what is left of the cap after other campaigns; `fullyBooked`
 *   means a new campaign would only queue behind them.
 */
export const recommendDailyLimit = ({ hardCap, committed = 0, standard = AUTO_DEFAULT_DAILY_LIMIT }) => {
  const cap = Number.isFinite(hardCap) ? Math.max(0, Math.floor(hardCap)) : standard;
  const headroom = Math.max(0, cap - Math.max(0, committed));
  const ideal = Math.min(standard, cap);
  return {
    recommended: Math.max(MIN_DAILY_LIMIT, Math.min(ideal, headroom)),
    headroom,
    fullyBooked: headroom < MIN_DAILY_LIMIT,
  };
};

/** Where in its warm-up ramp a mailbox is, or null once it has finished. */
export const warmupStage = (account, now = new Date()) => {
  const cap = warmupDailyCap(account, { now });
  if (cap === NO_WARMUP_LIMIT) return null;
  const day = Math.max(1, Math.floor((now.getTime() - new Date(account.warmupStartedAt).getTime()) / DAY_MS) + 1);
  return { day, cap, daysLeft: Math.max(0, WARMUP_DAYS - day) };
};

/** Daily volume the other live AUTO campaigns on a sender add up to. */
const committedOn = async (field, senderId) => {
  const rows = await prisma.outreachCampaign.findMany({
    where: { [field]: senderId, mode: "AUTO", status: { in: ["RUNNING", "SCHEDULED"] } },
    select: { dailyLimit: true },
  });
  return {
    campaigns: rows.length,
    total: rows.reduce((sum, r) => sum + (r.dailyLimit || AUTO_DEFAULT_DAILY_LIMIT), 0),
  };
};

const emailPlan = async (accountId, now) => {
  const account = await getAccount(accountId);
  if (!account) return null;
  const warmup = warmupStage(account, now);
  const hardCap = Math.min(DAILY_EMAIL_CAP, warmup ? warmup.cap : DAILY_EMAIL_CAP);
  const [sentToday, committed] = await Promise.all([sentTodayCount("EMAIL", account.id), committedOn("accountId", account.id)]);
  return {
    channel: "EMAIL", id: account.id, label: account.email,
    hardCap, sentToday, warmup,
    committed: committed.total, activeCampaigns: committed.campaigns,
    ...recommendDailyLimit({ hardCap, committed: committed.total }),
  };
};

const whatsappPlan = async (waAccountId, now) => {
  const device = await getWhatsAppAccount(waAccountId);
  if (!device) return null;
  const [sentToday, committed] = await Promise.all([sentTodayCount("WHATSAPP", device.id), committedOn("waAccountId", device.id)]);
  return {
    channel: "WHATSAPP", id: device.id, label: device.label || device.phoneNumber || "WhatsApp device",
    hardCap: DAILY_WA_CAP, sentToday, warmup: null,
    committed: committed.total, activeCampaigns: committed.campaigns,
    // A WhatsApp number is banned on volume alone, so its standard is lower.
    ...recommendDailyLimit({ hardCap: DAILY_WA_CAP, committed: committed.total, standard: 20 }),
  };
};

/**
 * Everything the bulk-send sheet needs to propose a safe schedule: the
 * recipient cap, how far ahead a start may be, and the state of each sender.
 * A channel with no configured sender comes back null rather than as an error
 * — the sheet already explains that case in its own words.
 */
export const senderPlan = async ({ accountId = null, waAccountId = null } = {}, now = new Date()) => {
  const [email, whatsapp] = await Promise.all([emailPlan(accountId, now), whatsappPlan(waAccountId, now)]);
  return {
    maxRecipients: CAMPAIGN_MAX_RECIPIENTS,
    maxScheduleAheadDays: MAX_SCHEDULE_AHEAD_DAYS,
    minDailyLimit: MIN_DAILY_LIMIT,
    email, whatsapp,
  };
};
