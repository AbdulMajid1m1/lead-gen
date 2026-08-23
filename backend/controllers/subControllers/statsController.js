import { z } from "zod";
import prisma from "../../prismaClient.js";
import { catalogForApi } from "../../lib/signals/signalCatalog.js";
import { SERVICE_LABELS } from "../../lib/scoring/scoreEngine.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { isLlmAvailable } from "../../lib/llm/index.js";
import { aiStatus } from "../../lib/llm/responses.js";

/** GET /api/stats/dashboard */
export const dashboard = asyncHandler(async (req, res) => {
  const dayAgo = new Date(Date.now() - 86_400_000);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [
    totalLeads, newToday, newThisWeek, freshThisWeek,
    companies, activeJobs, crawlsOk, crawlsBlocked,
    byService, byStatus, byType, topLeads, recentRuns, sources,
  ] = await Promise.all([
    prisma.lead.count({ where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT"] } } }),
    prisma.lead.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.lead.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.lead.count({ where: { newestEvidenceAt: { gte: weekAgo }, status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT"] } } }),
    prisma.company.count(),
    prisma.jobPosting.count({ where: { status: "ACTIVE" } }),
    prisma.crawlResult.count({ where: { ok: true } }),
    prisma.crawlResult.count({ where: { ok: false } }),
    prisma.lead.groupBy({ by: ["primaryOpportunity"], _count: { _all: true }, where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT"] } } }),
    prisma.lead.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.lead.groupBy({ by: ["type"], _count: { _all: true }, where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT"] } } }),
    prisma.lead.findMany({
      where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT"] } },
      orderBy: [{ score: "desc" }, { newestEvidenceAt: "desc" }],
      take: 5,
      include: { company: true, reasons: { orderBy: { rank: "asc" }, take: 1 } },
    }),
    prisma.discoveryRun.findMany({ orderBy: { createdAt: "desc" }, take: 5, include: { searchQuery: true } }),
    prisma.source.findMany({ include: { _count: { select: { records: true } } } }),
  ]);

  // Leads created per day for the last 30 days, zero-filled so the chart has a
  // continuous x-axis rather than gaps.
  const recent = await prisma.lead.findMany({
    where: { createdAt: { gte: monthAgo } },
    select: { createdAt: true, score: true },
  });
  const byDay = new Map();
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(d, { date: d, leads: 0, avgScore: 0, _sum: 0 });
  }
  for (const l of recent) {
    const key = l.createdAt.toISOString().slice(0, 10);
    const row = byDay.get(key);
    if (!row) continue;
    row.leads += 1;
    row._sum += l.score;
  }
  const timeline = [...byDay.values()].map(({ _sum, ...r }) => ({ ...r, avgScore: r.leads ? Math.round(_sum / r.leads) : 0 }));

  res.json({
    success: true,
    data: {
      totals: {
        leads: totalLeads,
        newToday,
        newThisWeek,
        freshThisWeek,
        companies,
        activeJobs,
        crawlsOk,
        crawlsBlocked,
      },
      byService: byService.map((r) => ({ service: r.primaryOpportunity, label: SERVICE_LABELS[r.primaryOpportunity], count: r._count._all })).sort((a, b) => b.count - a.count),
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byType: byType.map((r) => ({ type: r.type, count: r._count._all })).sort((a, b) => b.count - a.count),
      timeline,
      topLeads: topLeads.map((l) => ({
        id: l.id, score: l.score, name: l.company.name, city: l.company.city,
        primaryOpportunity: l.primaryOpportunity, topReason: l.reasons[0]?.text || null,
      })),
      recentRuns: recentRuns.map((r) => ({
        id: r.id, status: r.status, trigger: r.trigger, createdAt: r.createdAt,
        query: r.searchQuery?.rawText || null, stats: r.stats,
      })),
      sources: sources.map((s) => ({ kind: s.kind, name: s.name, enabled: s.enabled, records: s._count.records, attribution: s.attribution })),
      aiEnabled: isLlmAvailable(),
    },
  });
});

/** GET /api/signals/catalog */
export const signalCatalog = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { signals: catalogForApi(), services: SERVICE_LABELS } });
});

export const suppressionSchema = z.object({
  kind: z.enum(["DOMAIN", "EMAIL", "COMPANY", "PHONE"]),
  value: z.string().trim().min(2).max(500),
  reason: z.string().max(500).optional(),
});

/** GET /api/suppression */
export const listSuppression = asyncHandler(async (req, res) => {
  const entries = await prisma.suppressionEntry.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  res.json({ success: true, data: { entries } });
});

/** POST /api/suppression */
export const addSuppression = asyncHandler(async (req, res) => {
  const { kind, value, reason } = req.body;
  const normalized = value.toLowerCase().trim();

  const entry = await prisma.suppressionEntry.upsert({
    where: { kind_value: { kind, value: normalized } },
    update: { reason: reason || null },
    create: { kind, value: normalized, reason: reason || null },
  });

  // Applying it retroactively is the whole point — an opt-out that only affects
  // future crawls is not an opt-out.
  if (kind === "EMAIL" || kind === "PHONE") {
    await prisma.contact.updateMany({ where: { kind, value: { equals: normalized, mode: "insensitive" } }, data: { isSuppressed: true } });
  }
  if (kind === "DOMAIN") {
    const domain = await prisma.companyDomain.findUnique({ where: { domain: normalized } });
    if (domain) {
      await prisma.contact.updateMany({ where: { companyId: domain.companyId }, data: { isSuppressed: true } });
      await prisma.lead.updateMany({ where: { companyId: domain.companyId }, data: { status: "DO_NOT_CONTACT" } });
    }
  }
  if (kind === "COMPANY") {
    const company = await prisma.company.findFirst({ where: { normalizedName: normalized } });
    if (company) await prisma.lead.updateMany({ where: { companyId: company.id }, data: { status: "DO_NOT_CONTACT" } });
  }

  res.status(201).json({ success: true, message: "Suppression added and applied to existing records.", data: { entry } });
});

/** DELETE /api/suppression/:id */
export const removeSuppression = asyncHandler(async (req, res) => {
  const entry = await prisma.suppressionEntry.findUnique({ where: { id: req.params.id } });
  if (!entry) throw createError(404, "Suppression entry not found.");
  await prisma.suppressionEntry.delete({ where: { id: entry.id } });
  res.json({ success: true, message: "Suppression removed." });
});

/** GET /api/health */
export const health = asyncHandler(async (req, res) => {
  const checks = { database: "down", api: "up" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "up";
  } catch {
    checks.database = "down";
  }
  const ok = checks.database === "up";
  res.status(ok ? 200 : 503).json({
    success: ok,
    message: ok ? "Healthy" : "Degraded",
    data: { checks, aiEnabled: isLlmAvailable(), ai: aiStatus(), uptimeSeconds: Math.round(process.uptime()) },
  });
});
