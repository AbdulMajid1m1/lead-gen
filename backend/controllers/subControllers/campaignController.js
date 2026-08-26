import { z } from "zod";
import prisma from "../../prismaClient.js";
import {
  createCampaign, listCampaigns, campaignWithProgress, setCampaignStatus,
  DAILY_EMAIL_CAP, DAILY_WA_CAP, sentTodayCount,
} from "../../lib/outreach/campaigns.js";
import { listAccounts } from "../../lib/outreach/service.js";
import { listWhatsAppAccounts } from "../../lib/outreach/whatsapp.js";
import { regenerateDrafts } from "../../lib/research/compose.js";
import { runContactHygiene } from "../../lib/outreach/hygiene.js";
import { createError } from "../../utils/createError.js";
import { asyncHandler } from "../../middlewares/validate.js";

export const campaignCreateSchema = z.object({
  name: z.string().trim().max(160).optional(),
  leadIds: z.array(z.string().min(1).max(64)).min(1, "Select at least one lead.").max(500, "A campaign is capped at 500 leads."),
  channels: z.array(z.enum(["EMAIL", "WHATSAPP"])).min(1, "Pick at least one channel."),
  accountId: z.string().max(64).optional(),
  waAccountId: z.string().max(64).optional(),
  paceSeconds: z.coerce.number().int().min(20).max(600).default(45),
  // AUTO = spread sends across a daily local-hours window under a per-day
  // limit (deliverability protection); DIRECT = start now at paceSeconds.
  mode: z.enum(["DIRECT", "AUTO"]).default("DIRECT"),
  dailyLimit: z.coerce.number().int().min(5).max(150).optional(),
  windowStart: z.coerce.number().int().min(0).max(22).default(9),
  windowEnd: z.coerce.number().int().min(1).max(23).default(18),
  tzOffsetMinutes: z.coerce.number().int().min(-720).max(840).default(0),
}).refine((v) => v.windowEnd > v.windowStart, {
  message: "The sending window must end after it starts.", path: ["windowEnd"],
});

/** POST /api/outreach/campaigns — start a paced bulk send. */
export const create = asyncHandler(async (req, res) => {
  const { name, leadIds, channels, accountId, waAccountId, paceSeconds,
    mode, dailyLimit, windowStart, windowEnd, tzOffsetMinutes } = req.body;
  const result = await createCampaign({ name, leadIds, channels, accountId, waAccountId, paceSeconds,
    mode, dailyLimit, windowStart, windowEnd, tzOffsetMinutes });
  if (!result.ok) throw createError(400, result.error);
  res.status(201).json({
    success: true,
    message: result.skippedUpfront
      ? `Campaign started — ${result.skippedUpfront} lead(s) had nothing sendable and were skipped upfront.`
      : "Campaign started.",
    data: { campaign: result.campaign },
  });
});

/** GET /api/outreach/campaigns */
export const list = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { campaigns: await listCampaigns() } });
});

/** GET /api/outreach/campaigns/:id — progress plus the per-lead ledger. */
export const detail = asyncHandler(async (req, res) => {
  const campaign = await campaignWithProgress(req.params.id);
  if (!campaign) throw createError(404, "Campaign not found.");

  const recipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: req.params.id },
    orderBy: { id: "asc" },
    include: { lead: { select: { id: true, score: true, status: true, company: { select: { name: true, city: true } } } } },
  });

  res.json({
    success: true,
    data: {
      campaign,
      recipients: recipients.map((r) => ({
        leadId: r.leadId,
        company: r.lead?.company?.name ?? "(deleted lead)",
        city: r.lead?.company?.city ?? null,
        score: r.lead?.score ?? null,
        leadStatus: r.lead?.status ?? null,
        email: { state: r.emailState, detail: r.emailDetail },
        whatsapp: { state: r.waState, detail: r.waDetail },
        processedAt: r.processedAt,
      })),
    },
  });
});

const transition = (status) => asyncHandler(async (req, res) => {
  const result = await setCampaignStatus(req.params.id, status);
  if (!result.ok) throw createError(400, result.error);
  res.json({ success: true, message: `Campaign ${status.toLowerCase()}.`, data: { campaign: result.campaign } });
});
export const pause = transition("PAUSED");
export const resume = transition("RUNNING");
export const cancel = transition("CANCELLED");

/**
 * POST /api/outreach/drafts/regenerate — rebuild every contactable lead's
 * draft with the current prompts and templates. Drafts are snapshots; copy
 * improvements change nothing until this runs. AI writes where a provider is
 * up (spend-capped), templates cover the rest.
 */
export const regenerate = asyncHandler(async (req, res) => {
  req.setTimeout(0); // an AI-assisted pass over hundreds of leads outlives the default timeout
  const summary = await regenerateDrafts({});
  res.json({
    success: true,
    message: `Rewrote ${summary.written} drafts (${summary.aiWritten} by AI, ${summary.templated} from templates).`,
    data: summary,
  });
});

/**
 * POST /api/outreach/contacts/hygiene — suppress unsendable addresses
 * (broker domains, extraction-mangled locals, domains with no MX) before
 * they cost a bounce.
 */
export const hygiene = asyncHandler(async (req, res) => {
  req.setTimeout(0); // one MX lookup per unique domain can take a while on a large list
  const summary = await runContactHygiene({});
  res.json({
    success: true,
    message: `Checked ${summary.checked} addresses, suppressed ${summary.suppressed}.`,
    data: summary,
  });
});

/**
 * GET /api/outreach/stats — the numbers behind the outreach page.
 * Daily series per channel + replies, headline totals, per-sender cap usage,
 * and the most recent replies for the feed at the bottom.
 */
export const statsSchema = z.object({ days: z.coerce.number().int().min(7).max(90).default(30) });

export const stats = asyncHandler(async (req, res) => {
  const { days } = req.validatedQuery;
  const since = new Date(Date.now() - days * 86_400_000);

  // One grouped query covers every series; shaping happens in JS.
  const rows = await prisma.$queryRaw`
    SELECT date_trunc('day', COALESCE(m."sentAt", m."receivedAt", m."createdAt"))::date AS day,
           t."channel"::text AS channel, m."direction"::text AS direction, COUNT(*)::int AS n
    FROM "OutreachMessage" m
    JOIN "OutreachThread" t ON t."id" = m."threadId"
    WHERE COALESCE(m."sentAt", m."receivedAt", m."createdAt") >= ${since}
    GROUP BY 1, 2, 3
    ORDER BY 1`;

  // Zero-filled continuous series so the chart has no gaps.
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(key, { date: key, email: 0, whatsapp: 0, replies: 0 });
  }
  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10);
    const bucket = byDay.get(key);
    if (!bucket) continue;
    if (r.direction === "INBOUND") bucket.replies += r.n;
    else if (r.channel === "WHATSAPP") bucket.whatsapp += r.n;
    else bucket.email += r.n;
  }
  const daily = [...byDay.values()];

  const sum = (list, field) => list.reduce((acc, d) => acc + d[field], 0);
  const today = daily[daily.length - 1] || { email: 0, whatsapp: 0, replies: 0 };
  const week = daily.slice(-7);
  const sentTotal = sum(daily, "email") + sum(daily, "whatsapp");
  const replyTotal = sum(daily, "replies");

  // Per-sender cap usage, so "why did my campaign pause" answers itself.
  const [emailAccounts, waAccounts] = await Promise.all([listAccounts(), listWhatsAppAccounts()]);
  const senders = [
    ...(await Promise.all(emailAccounts.map(async (a) => ({
      channel: "EMAIL", id: a.id, label: a.email, status: a.status,
      sentToday: await sentTodayCount("EMAIL", a.id), cap: DAILY_EMAIL_CAP,
    })))),
    ...(await Promise.all(waAccounts.map(async (a) => ({
      channel: "WHATSAPP", id: a.id, label: a.label || a.phoneNumber || "WhatsApp device", status: a.status ?? "PAIRED",
      sentToday: await sentTodayCount("WHATSAPP", a.id), cap: DAILY_WA_CAP,
    })))),
  ];

  const recentReplies = await prisma.outreachMessage.findMany({
    where: { direction: "INBOUND" },
    orderBy: [{ receivedAt: "desc" }, { createdAt: "desc" }],
    take: 25,
    include: { thread: { include: { lead: { select: { id: true, company: { select: { name: true, city: true } } } } } } },
  });

  res.json({
    success: true,
    data: {
      totals: {
        sentToday: today.email + today.whatsapp,
        emailToday: today.email,
        whatsappToday: today.whatsapp,
        repliesToday: today.replies,
        sentThisWeek: sum(week, "email") + sum(week, "whatsapp"),
        repliesThisWeek: sum(week, "replies"),
        sentInRange: sentTotal,
        repliesInRange: replyTotal,
        replyRate: sentTotal ? Math.round((replyTotal / sentTotal) * 100) : 0,
      },
      daily,
      senders,
      recentReplies: recentReplies.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        channel: m.thread.channel,
        from: m.fromAddress,
        company: m.thread.lead?.company?.name ?? "(deleted lead)",
        city: m.thread.lead?.company?.city ?? null,
        leadId: m.thread.lead?.id ?? null,
        subject: m.subject,
        snippet: String(m.body || "").replace(/\s+/g, " ").trim().slice(0, 220),
        receivedAt: m.receivedAt || m.createdAt,
      })),
    },
  });
});
