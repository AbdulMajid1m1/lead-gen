import prisma from "../../prismaClient.js";
import { buildRecipientRows, LOCKED_LEAD_STATUSES, DAILY_EMAIL_CAP } from "./campaigns.js";
import { getAccount } from "./service.js";
import { warmupDailyCap, WARMUP_DAYS } from "./deliverability.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:promoter-autopilot");

/**
 * The standing automation for a promoted product.
 *
 * The agency autopilot (autopilot.js) deliberately never touches promoter
 * leads: they were sourced for one product and are pitched from that product's
 * own mailbox, on that product's own clock. This module is the same idea with
 * the product as the unit instead of the region — one AUTO campaign per
 * product, topped up with newly eligible leads, budgeted from the mailbox's
 * warm-up ramp. Not one message is sent from here; `runCampaignTick` drains
 * the campaign under the same pacing, cap, bounce guard and legal gate as
 * everything else.
 */

const DAY_MS = 86_400_000;
const DEFAULT_SEND_DAYS = [1, 2, 3, 4, 5];

/** The campaign name a product owns. Found again by id, so the name is cosmetic. */
export const productCampaignName = (product) => `Promoter · ${String(product?.name || "product").trim()}`.slice(0, 160);

/** Load the product's settings row, creating the default (disabled) one on first read. */
export const getPromoterAutopilot = async (productId) => {
  const existing = await prisma.promoterAutopilot.findUnique({ where: { productId } });
  if (existing) return existing;
  return prisma.promoterAutopilot.create({ data: { productId } });
};

export const updatePromoterAutopilot = async (productId, patch) => {
  await getPromoterAutopilot(productId);
  return prisma.promoterAutopilot.update({ where: { productId }, data: patch });
};

/** The mailbox a product sends from: its own when set and usable, else the default. */
export const productAccount = async (settings) => {
  if (settings?.accountId) {
    const own = await getAccount(settings.accountId);
    if (own) return own;
  }
  return getAccount(null);
};

/**
 * What the mailbox can take today. The warm-up ramp is the real ceiling on a
 * young mailbox and it moves every few days, so it is recomputed per tick.
 */
export const dailyCeiling = (account, { now = new Date() } = {}) => {
  if (!account) return 0;
  return Math.min(DAILY_EMAIL_CAP, warmupDailyCap(account, { now }));
};

/** Which day of its 21-day ramp a mailbox is on, or null once it has finished. */
export const warmupDay = (account, { now = new Date() } = {}) => {
  const started = account?.warmupStartedAt ? new Date(account.warmupStartedAt) : null;
  if (!started || Number.isNaN(started.getTime())) return null;
  const day = Math.max(1, Math.floor((now.getTime() - started.getTime()) / DAY_MS) + 1);
  return day >= WARMUP_DAYS ? null : day;
};

/** The day's budget: the operator's figure, never above what the mailbox can take. */
export const productBudget = ({ settings, ceiling }) => {
  if (ceiling <= 0) return 0;
  return Math.max(1, Math.min(settings?.dailyLimit || ceiling, ceiling));
};

/**
 * Leads this product could still pitch: sourced by one of its runs, not locked
 * by a human, not already in a conversation, and with an address the legal
 * gate will accept — `buildRecipientRows` makes that last call, through the
 * same code a hand-launched campaign uses.
 */
export const eligibleProductLeads = async ({ productId, excludeLeadIds = [], take = 300 }) =>
  prisma.lead.findMany({
    where: {
      status: { notIn: LOCKED_LEAD_STATUSES },
      threads: { none: {} },
      discoveryRun: { promotedProductId: productId },
      ...(excludeLeadIds.length ? { id: { notIn: excludeLeadIds } } : {}),
    },
    include: {
      company: { include: { contacts: { where: { isSuppressed: false } }, people: true } },
      threads: { select: { channel: true } },
      discoveryRun: { select: { promotedProduct: { select: { icp: true } } } },
    },
    orderBy: [{ score: "desc" }, { createdAt: "asc" }],
    take,
  });

/** The product's standing campaign, whatever state it is in. */
export const findProductCampaign = (productId) =>
  prisma.outreachCampaign.findFirst({
    where: { promotedProductId: productId, mode: "AUTO" },
    orderBy: { createdAt: "desc" },
  });

const pendingCount = (campaignId) =>
  prisma.campaignRecipient.count({ where: { campaignId, emailState: "PENDING" } });

/**
 * One pass for one product: top the campaign up and re-set the day's limit.
 * Never throws — a product that cannot run records why and the others continue.
 */
export const runProductAutopilot = async (productId, now = new Date()) => {
  const settings = await getPromoterAutopilot(productId);
  const finish = async (result) => {
    await prisma.promoterAutopilot.update({ where: { productId }, data: { lastRunAt: now, lastResult: result } });
    return result;
  };
  if (!settings.enabled) return { skipped: "autopilot disabled" };

  const product = await prisma.promotedProduct.findUnique({ where: { id: productId }, select: { id: true, name: true, status: true } });
  if (!product || product.status === "ARCHIVED") return finish({ skipped: "product archived" });

  const account = await productAccount(settings);
  if (!account) return finish({ skipped: "no connected email account" });

  const ceiling = dailyCeiling(account, { now });
  const budget = productBudget({ settings, ceiling });
  const sendDays = Array.isArray(settings.sendDays) && settings.sendDays.length ? settings.sendDays : DEFAULT_SEND_DAYS;

  const campaign = await findProductCampaign(productId);
  const existingIds = campaign
    ? (await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id }, select: { leadId: true } })).map((r) => r.leadId)
    : [];
  const leads = await eligibleProductLeads({ productId, excludeLeadIds: existingIds });
  const rows = buildRecipientRows(leads, { wantEmail: true, wantWa: false });
  const sendable = rows.filter((r) => r.emailState === "PENDING");

  const result = { product: product.name, account: account.email, budget, ceiling, added: 0, created: false, pending: 0 };

  let target = campaign;
  if (!target && sendable.length) {
    target = await prisma.outreachCampaign.create({
      data: {
        name: productCampaignName(product),
        channels: ["EMAIL"],
        accountId: account.id,
        mode: "AUTO",
        status: "RUNNING",
        dailyLimit: budget,
        windowStart: settings.windowStart,
        windowEnd: settings.windowEnd,
        tzOffsetMinutes: settings.tzOffsetMinutes,
        sendDays,
        startAt: now,
        createdByName: `Autopilot · ${product.name}`,
        promotedProductId: productId,
        recipients: { createMany: { data: rows } },
      },
    });
    result.created = true;
    result.added = sendable.length;
  } else if (target && rows.length) {
    // skipDuplicates guards the race where a lead was added between the
    // eligibility read and this write.
    const added = await prisma.campaignRecipient.createMany({
      data: rows.map((r) => ({ ...r, campaignId: target.id })),
      skipDuplicates: true,
    });
    result.added = added.count;
  }

  if (target) {
    const pending = await pendingCount(target.id);
    result.pending = pending;
    await prisma.outreachCampaign.update({
      where: { id: target.id },
      data: {
        // The mailbox may have changed in Settings since the campaign was made.
        accountId: account.id,
        dailyLimit: budget,
        windowStart: settings.windowStart,
        windowEnd: settings.windowEnd,
        tzOffsetMinutes: settings.tzOffsetMinutes,
        sendDays,
        // A campaign the drain completed is revived once it has work again. A
        // PAUSED one is left alone: the bounce guard or a person stopped it.
        ...(pending > 0 && target.status === "COMPLETED" ? { status: "RUNNING", completedAt: null } : {}),
      },
    });
  } else {
    result.note = "no eligible leads";
  }

  logger.info(result, "promoter autopilot tick");
  return finish(result);
};

/** Every enabled product, one after another. Called from the worker on the autopilot cadence. */
export const runPromoterAutopilotTick = async (now = new Date()) => {
  const enabled = await prisma.promoterAutopilot.findMany({ where: { enabled: true }, select: { productId: true } });
  const results = {};
  for (const { productId } of enabled) {
    try {
      results[productId] = await runProductAutopilot(productId, now);
    } catch (err) {
      logger.error({ productId, msg: err.message }, "promoter autopilot failed");
      results[productId] = { error: String(err.message).slice(0, 300) };
    }
  }
  return { products: enabled.length, results };
};

/** Stop the product's campaign now, rather than after the day's quota. */
export const pauseProductCampaign = async (productId, reason = "Autopilot switched off.") => {
  const { count } = await prisma.outreachCampaign.updateMany({
    where: { promotedProductId: productId, mode: "AUTO", status: { in: ["RUNNING", "SCHEDULED"] } },
    data: { status: "PAUSED", pausedReason: reason.slice(0, 300) },
  });
  return count;
};

/** Resume a campaign the switch itself paused, leaving bounce-guard pauses stopped. */
export const resumeProductCampaign = async (productId) => {
  const { count } = await prisma.outreachCampaign.updateMany({
    where: {
      promotedProductId: productId, mode: "AUTO", status: "PAUSED",
      pausedReason: { startsWith: "Autopilot switched off" },
    },
    data: { status: "RUNNING", pausedReason: null },
  });
  return count;
};

/**
 * What the product's Outreach tab shows: the switch, the mailbox and its ramp,
 * today's progress, and how the campaign has done so far. Read-only.
 */
export const promoterAutopilotStatus = async (productId, now = new Date()) => {
  const settings = await getPromoterAutopilot(productId);
  const account = await productAccount(settings);
  const ceiling = dailyCeiling(account, { now });
  const campaign = await findProductCampaign(productId);

  const eligible = await prisma.lead.count({
    where: {
      status: { notIn: LOCKED_LEAD_STATUSES },
      threads: { none: {} },
      discoveryRun: { promotedProductId: productId },
    },
  });

  let progress = { pending: 0, sent: 0, skipped: 0, failed: 0, sentToday: 0 };
  let outcomes = { replied: 0, bounced: 0, awaiting: 0 };
  if (campaign) {
    const since = new Date(now.getTime() - DAY_MS);
    const [byState, sentToday, threads] = await Promise.all([
      prisma.campaignRecipient.groupBy({ by: ["emailState"], where: { campaignId: campaign.id }, _count: { _all: true } }),
      prisma.campaignRecipient.count({ where: { campaignId: campaign.id, emailState: "SENT", processedAt: { gte: since } } }),
      prisma.outreachThread.groupBy({
        by: ["status"],
        where: { channel: "EMAIL", lead: { discoveryRun: { promotedProductId: productId } } },
        _count: { _all: true },
      }),
    ]);
    const count = (list, key, field) => list.find((r) => r[field] === key)?._count?._all || 0;
    progress = {
      pending: count(byState, "PENDING", "emailState"),
      sent: count(byState, "SENT", "emailState"),
      skipped: count(byState, "SKIPPED", "emailState"),
      failed: count(byState, "FAILED", "emailState"),
      sentToday,
    };
    outcomes = {
      replied: count(threads, "REPLIED", "status"),
      bounced: count(threads, "BOUNCED", "status"),
      awaiting: count(threads, "AWAITING_REPLY", "status"),
    };
  }

  return {
    settings: {
      enabled: settings.enabled,
      accountId: settings.accountId,
      dailyLimit: settings.dailyLimit,
      windowStart: settings.windowStart,
      windowEnd: settings.windowEnd,
      tzOffsetMinutes: settings.tzOffsetMinutes,
      sendDays: Array.isArray(settings.sendDays) ? settings.sendDays : DEFAULT_SEND_DAYS,
      lastRunAt: settings.lastRunAt,
      lastResult: settings.lastResult,
    },
    account: account
      ? {
          id: account.id, email: account.email, displayName: account.displayName,
          isDefault: account.isDefault, warmupDay: warmupDay(account, { now }),
        }
      : null,
    // Both figures, so the panel can say "10 today, not 40" while a mailbox ramps.
    emailCeiling: account ? DAILY_EMAIL_CAP : null,
    warmupCap: account ? warmupDailyCap(account, { now }) : null,
    budget: productBudget({ settings, ceiling }),
    eligible,
    campaign: campaign
      ? {
          id: campaign.id, name: campaign.name, status: campaign.status, pausedReason: campaign.pausedReason,
          dailyLimit: campaign.dailyLimit, windowStart: campaign.windowStart, windowEnd: campaign.windowEnd,
          tzOffsetMinutes: campaign.tzOffsetMinutes, createdAt: campaign.createdAt,
        }
      : null,
    progress,
    outcomes,
  };
};
