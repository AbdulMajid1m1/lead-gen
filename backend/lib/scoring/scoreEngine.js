import prisma from "../../prismaClient.js";
import { SIGNAL_CATALOG, REACHABILITY_SIGNALS, isOpportunitySignal } from "../signals/signalCatalog.js";
import { decayFactor } from "./decay.js";
import { buildRecommendation } from "./recommend.js";
import { log } from "../../utils/logger.js";

const logger = log("scoring");

export const SCORE_VERSION = 2;

const CAPS = { opportunity: 50, freshness: 25, reachability: 15, fit: 10 };
const MIN_SCORE_TO_CREATE_LEAD = 20;

/** Industries this agency actually sells into — a small fit nudge, not a gate. */
const TARGET_INDUSTRY_RE = /restaurant|cafe|retail|clothes|hotel|dentist|doctor|clinic|salon|spa|gym|fitness|real.?estate|lawyer|accountant|school|construction|logistics|marketing|travel|car|furniture|jewelry|electronics|supermarket|pharmacy|optician|veterinar/i;

/**
 * Score one company and upsert its Lead.
 *
 * Every point is attributable: `scoreBreakdown` lists each contributing signal
 * with its raw weight, strength, decay factor and resulting points, which is
 * exactly what the UI renders. Nothing here consults an LLM.
 */
export const scoreCompany = async (companyId, { searchQueryId = null, discoveryRunId = null } = {}) => {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      contacts: { where: { isSuppressed: false } },
      domains: true,
      signals: { where: { active: true } },
      jobPostings: { where: { status: "ACTIVE" }, include: { skills: true } },
      audits: { orderBy: { auditedAt: "desc" }, take: 1 },
      tech: true,
      leads: true,
    },
  });
  if (!company) throw new Error(`Company ${companyId} not found`);

  // A company on the suppression list must never surface as a lead.
  const suppressed = await prisma.suppressionEntry.findFirst({
    where: {
      OR: [
        { kind: "COMPANY", value: company.normalizedName },
        ...(company.domains.length ? [{ kind: "DOMAIN", value: { in: company.domains.map((d) => d.domain) } }] : []),
      ],
    },
  });
  if (suppressed) {
    if (company.leads[0]) {
      await setStatus(company.leads[0].id, "DO_NOT_CONTACT", `Suppressed: ${suppressed.reason || suppressed.kind}`);
    }
    return { skipped: true, reason: "SUPPRESSED" };
  }

  const now = Date.now();

  // ─── Opportunity points ─────────────────────────────────────────────────────
  const contributions = [];
  const serviceTotals = new Map();

  for (const signal of company.signals) {
    if (!isOpportunitySignal(signal.type)) continue;
    const def = SIGNAL_CATALOG[signal.type];
    if (!def) continue;

    const decay = decayFactor(signal, now);
    const points = signal.weight * signal.strength * decay;
    if (points < 0.05) continue;

    contributions.push({
      signalId: signal.id,
      type: signal.type,
      label: def.label,
      raw: signal.weight,
      strength: Number(signal.strength.toFixed(3)),
      decay: Number(decay.toFixed(3)),
      points: Number(points.toFixed(2)),
      detectedAt: signal.detectedAt,
      context: signal.context || {},
    });

    for (const [service, share] of Object.entries(def.services)) {
      serviceTotals.set(service, (serviceTotals.get(service) || 0) + points * share);
    }
  }

  contributions.sort((a, b) => b.points - a.points);
  const rawOpportunity = contributions.reduce((sum, c) => sum + c.points, 0);
  const opportunity = Math.min(CAPS.opportunity, rawOpportunity);

  // ─── Freshness ──────────────────────────────────────────────────────────────
  // Driven by the *best-preserved* of the three newest signals, so one fresh
  // hiring signal lifts a lead even when it also carries old structural debt.
  const newest = [...company.signals]
    .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
    .slice(0, 3);
  const bestDecay = newest.length ? Math.max(...newest.map((s) => decayFactor(s, now))) : 0;
  const freshness = Math.round(CAPS.freshness * bestDecay);

  const evidenceDates = [
    ...company.signals.map((s) => s.detectedAt),
    ...company.jobPostings.map((j) => j.lastSeenActiveAt || j.postedAt).filter(Boolean),
    company.audits[0]?.auditedAt,
    company.lastCrawledAt,
  ].filter(Boolean);
  const newestEvidenceAt = evidenceDates.length
    ? new Date(Math.max(...evidenceDates.map((d) => new Date(d).getTime())))
    : company.lastSeenAt;

  // ─── Reachability ───────────────────────────────────────────────────────────
  const hasEmail = company.contacts.some((c) => c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH");
  const hasPhone = company.contacts.some((c) => c.kind === "PHONE");
  const hasForm = company.contacts.some((c) => c.kind === "CONTACT_FORM");
  const reachability = hasEmail ? 15 : hasPhone ? 10 : hasForm ? 6 : 0;

  // ─── Fit ────────────────────────────────────────────────────────────────────
  let fit = 0;
  if (TARGET_INDUSTRY_RE.test(`${company.industry || ""} ${company.osmCategory || ""}`)) fit += 5;
  if (["MICRO", "SMALL", "MEDIUM"].includes(company.sizeBucket)) fit += 3;
  if (company.countryCode) fit += 2;
  fit = Math.min(CAPS.fit, fit);

  const total = Math.max(0, Math.min(100, Math.round(opportunity + freshness + reachability + fit)));

  // ─── Below the bar ──────────────────────────────────────────────────────────
  if (total < MIN_SCORE_TO_CREATE_LEAD || contributions.length === 0) {
    if (company.leads[0]) {
      await prisma.lead.update({
        where: { id: company.leads[0].id },
        data: { score: total, scoredAt: new Date(), status: company.leads[0].status === "NEW" ? "ARCHIVED" : company.leads[0].status },
      });
    }
    return { skipped: true, reason: contributions.length === 0 ? "NO_SIGNALS" : "BELOW_THRESHOLD", score: total };
  }

  // ─── Opportunities & lead type ──────────────────────────────────────────────
  const opportunities = [...serviceTotals.entries()]
    .map(([service, points]) => ({ service, points: Math.round(points * 10) / 10 }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 4);
  const primaryOpportunity = opportunities[0]?.service || "WEBSITE_DEV";

  // Lead type comes from whichever signal category carries the most points.
  const typeTotals = new Map();
  for (const c of contributions) {
    const leadType = SIGNAL_CATALOG[c.type]?.leadType;
    if (leadType) typeTotals.set(leadType, (typeTotals.get(leadType) || 0) + c.points);
  }
  const type = [...typeTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "TECH_DEBT";

  const scoreBreakdown = {
    version: SCORE_VERSION,
    categories: { opportunity: Math.round(opportunity), freshness, reachability, fit },
    caps: CAPS,
    signals: contributions,
    rawOpportunity: Number(rawOpportunity.toFixed(2)),
    total,
    scoredAt: new Date().toISOString(),
  };

  // ─── Persist ────────────────────────────────────────────────────────────────
  const existing = company.leads[0];
  const lead = await prisma.lead.upsert({
    where: { companyId },
    update: {
      type,
      primaryOpportunity,
      score: total,
      scoreBreakdown,
      freshnessScore: freshness,
      newestEvidenceAt,
      scoredAt: new Date(),
      // Never resurrect a lead a human has already dispositioned.
      ...(existing && ["ARCHIVED", "DISQUALIFIED"].includes(existing.status) ? { status: "NEW" } : {}),
      ...(searchQueryId ? { searchQueryId } : {}),
      ...(discoveryRunId ? { discoveryRunId } : {}),
    },
    create: {
      companyId,
      type,
      primaryOpportunity,
      score: total,
      scoreBreakdown,
      freshnessScore: freshness,
      newestEvidenceAt,
      searchQueryId,
      discoveryRunId,
      status: "NEW",
    },
  });

  if (!existing) {
    await prisma.leadStatusHistory.create({
      data: { leadId: lead.id, toStatus: "NEW", note: "Lead created by the scoring engine." },
    });
  }

  // Opportunities, reasons, actions and outreach are fully derived — replaced
  // on every scoring pass so they can never drift from the current score.
  await prisma.leadOpportunity.deleteMany({ where: { leadId: lead.id } });
  await prisma.leadOpportunity.createMany({
    data: opportunities.map((o, i) => ({
      leadId: lead.id,
      service: o.service,
      points: Math.round(o.points),
      rank: i + 1,
      rationale: rationaleForService(o.service, contributions),
    })),
  });

  await prisma.leadReason.deleteMany({ where: { leadId: lead.id } });
  const reasons = buildReasons(contributions, company);
  await prisma.leadReason.createMany({
    data: reasons.map((r, i) => ({
      leadId: lead.id,
      rank: i + 1,
      text: r.text,
      signalId: r.signalId,
      confidenceLevel: r.confidenceLevel,
    })),
  });

  const recommendation = buildRecommendation({
    company,
    lead: { ...lead, score: total, type, primaryOpportunity },
    contributions,
    reasons,
    contacts: { hasEmail, hasPhone, hasForm },
  });

  await prisma.recommendedAction.deleteMany({ where: { leadId: lead.id } });
  await prisma.recommendedAction.createMany({
    data: recommendation.actions.map((a) => ({
      leadId: lead.id,
      actionType: a.actionType,
      title: a.title,
      rationale: a.rationale,
      priority: a.priority,
    })),
  });

  await prisma.outreachRecommendation.deleteMany({ where: { leadId: lead.id } });
  if (recommendation.outreach) {
    await prisma.outreachRecommendation.create({
      data: {
        leadId: lead.id,
        channel: recommendation.outreach.channel,
        subjectLine: recommendation.outreach.subjectLine,
        openingLine: recommendation.outreach.openingLine,
        talkingPoints: recommendation.outreach.talkingPoints,
        generatedBy: "RULE",
        confidenceLevel: "DETECTED",
      },
    });
  }

  logger.debug({ companyId, score: total, type, primaryOpportunity }, "lead scored");
  return { skipped: false, lead, score: total, breakdown: scoreBreakdown, reasons, recommendation };
};

/** Render each contributing signal's sentence, best first. */
const buildReasons = (contributions, company) => {
  const out = [];
  for (const c of contributions.slice(0, 6)) {
    const def = SIGNAL_CATALOG[c.type];
    if (!def?.reason) continue;
    let text;
    try {
      text = def.reason({ companyName: company.name, industry: company.industry, ...c.context });
    } catch {
      text = def.label;
    }
    out.push({
      text: String(text).slice(0, 500),
      signalId: c.signalId,
      // A signal built from a live board fetch or a response header is verified;
      // capability gaps are inferences from absence of evidence.
      confidenceLevel: INFERRED_SIGNALS.has(c.type) ? "INFERRED" : "DETECTED",
      points: c.points,
      type: c.type,
    });
  }
  return out;
};

/** Signals asserted from the *absence* of something are inferences, not facts. */
const INFERRED_SIGNALS = new Set(["NO_ONLINE_ORDERING", "NO_BOOKING_SYSTEM", "NO_WEBSITE", "NO_ANALYTICS", "MANUAL_PROCESS_HINT"]);

const SERVICE_LABELS = {
  WEBSITE_DEV: "website development",
  CRM_DEV: "CRM development",
  MOBILE_APP: "mobile app development",
  AI_AUTOMATION: "AI automation",
  ECOMMERCE_DEV: "e-commerce development",
  SAAS_DEV: "SaaS development",
  CUSTOM_SOFTWARE: "custom software development",
  HR_SOFTWARE: "HR software",
};

const rationaleForService = (service, contributions) => {
  const supporting = contributions
    .filter((c) => Object.keys(SIGNAL_CATALOG[c.type]?.services || {}).includes(service))
    .slice(0, 3)
    .map((c) => SIGNAL_CATALOG[c.type].label.toLowerCase());
  return supporting.length
    ? `Supports ${SERVICE_LABELS[service] || service} based on: ${supporting.join(", ")}.`
    : `Potential ${SERVICE_LABELS[service] || service} opportunity.`;
};

export const setStatus = async (leadId, toStatus, note = null) => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new Error(`Lead ${leadId} not found`);
  if (lead.status === toStatus) return lead;
  const [updated] = await prisma.$transaction([
    prisma.lead.update({ where: { id: leadId }, data: { status: toStatus } }),
    prisma.leadStatusHistory.create({ data: { leadId, fromStatus: lead.status, toStatus, note } }),
  ]);
  return updated;
};

export { SERVICE_LABELS };
