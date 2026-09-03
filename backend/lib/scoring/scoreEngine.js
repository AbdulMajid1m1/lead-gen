import prisma from "../../prismaClient.js";
import { SIGNAL_CATALOG, REACHABILITY_SIGNALS, isOpportunitySignal, DISQUALIFYING_SIGNALS, WEBSITE_PITCH_SIGNALS } from "../signals/signalCatalog.js";
import { decayFactor } from "./decay.js";
import { buildRecommendation } from "./recommend.js";
import { icpFit, FIT_CAP } from "../promoter/fit.js";
import { classifyCompanyExclusion, exclusionNote } from "../qualify/excludedCategories.js";
import { log } from "../../utils/logger.js";

const logger = log("scoring");

export const SCORE_VERSION = 2;

const CAPS = { opportunity: 50, freshness: 25, reachability: 15, fit: 10 };
/**
 * A promote run's caps. Fit is worth far more and website debt is worth
 * nothing, because on a product sale the approved ICP *is* the thesis and the
 * state of the prospect's website is not evidence either way.
 */
const PRODUCT_CAPS = { opportunity: 45, freshness: 20, reachability: 15, fit: FIT_CAP };
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
export const scoreCompany = async (companyId, { searchQueryId = null, discoveryRunId = null, product = null } = {}) => {
  // A promote run sells one named product against one approved profile. That
  // changes three things and nothing else: website debt stops counting as an
  // opportunity, fit against the ICP starts counting for real, and the lead's
  // opportunity is the product rather than a service guessed from its signals.
  const caps = product ? PRODUCT_CAPS : CAPS;
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

  // A line of trade this agency does not work with — alcohol, gambling and the
  // rest — is a lead-level verdict, not a score. Checked here, on every scoring
  // pass, so it covers every source at once: a company that entered before the
  // rule existed is disqualified the next time the scheduler re-scores it,
  // and the "resurrect ARCHIVED/DISQUALIFIED to NEW" step further down never
  // gets to run for it.
  const excludedTrade = classifyCompanyExclusion(company);
  if (excludedTrade) {
    if (company.leads[0] && company.leads[0].status !== "DISQUALIFIED") {
      await setStatus(company.leads[0].id, "DISQUALIFIED", exclusionNote(excludedTrade));
    }
    return { skipped: true, reason: "EXCLUDED_CATEGORY", category: excludedTrade.category, matched: excludedTrade.matched };
  }

  // A disqualified company must never surface as a lead either, however well it
  // would otherwise score. A permanently closed business still has a website
  // worth auditing, a phone number and a full set of tech-debt signals — it
  // would rank perfectly well while being uncontactable by definition. The same
  // holds for a company whose domain has been taken over by somebody else:
  // every signal derived from that site describes the wrong business.
  const disqualifier = company.signals.find((sig) => DISQUALIFYING_SIGNALS.has(sig.type));
  if (disqualifier) {
    const label = SIGNAL_CATALOG[disqualifier.type]?.label || disqualifier.type;
    if (company.leads[0]) {
      await setStatus(company.leads[0].id, "DO_NOT_CONTACT", `Disqualified: ${label}.`);
    }
    return { skipped: true, reason: "DISQUALIFIED", disqualifier: disqualifier.type };
  }

  // A company with no website of its own is a website-development lead by
  // definition, and the exact opposite of a SaaS buyer: the reason it is in
  // the database is a gap this product does not fill, it published no email to
  // sell to, and at that size it sits under the floor of every self-serve
  // pricing tier. Five of these ranked in a single TracefyHR run, each with a
  // "listed but has no website at all" reason that reads as an argument for
  // hiring an agency. Gated here rather than filtered in the UI so they never
  // become leads, and never become drafts.
  if (product && company.signals.some((sig) => sig.type === "NO_WEBSITE")) {
    return { skipped: true, reason: "NO_WEBSITE_FOR_PRODUCT" };
  }

  const now = Date.now();

  // ─── Opportunity points ─────────────────────────────────────────────────────
  const contributions = [];
  const serviceTotals = new Map();

  for (const signal of company.signals) {
    if (!isOpportunitySignal(signal.type)) continue;
    // On a product run the website diagnostics carry no opportunity: an
    // end-of-life jQuery is not a reason to buy payroll software, and letting
    // it score put schools with old websites at the top of a list meant to be
    // ranked by HR pain.
    if (product && WEBSITE_PITCH_SIGNALS.has(signal.type)) continue;
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
  const opportunity = Math.min(caps.opportunity, rawOpportunity);

  // ─── Freshness ──────────────────────────────────────────────────────────────
  // Driven by the *best-preserved* of the three newest signals, so one fresh
  // hiring signal lifts a lead even when it also carries old structural debt.
  const newest = [...company.signals]
    .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
    .slice(0, 3);
  const bestDecay = newest.length ? Math.max(...newest.map((s) => decayFactor(s, now))) : 0;
  const freshness = Math.round(caps.freshness * bestDecay);

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
  // On a product run this is the approved ICP's own judgement of the company —
  // its market, its industry, its headcount band — rather than the agency's
  // standing list of industries it sells into.
  let fit = 0;
  let fitDetail = null;
  if (product) {
    fitDetail = icpFit(company, product.icp);
    fit = fitDetail.points;
    // Outside the profile's headcount band is outside the profile. Handled
    // like the other disqualifiers above — a human-set status is kept, an
    // existing NEW lead is parked — rather than as a low score, because a low
    // score still ranks and still gets emailed.
    if (fitDetail.excluded) {
      if (company.leads[0] && company.leads[0].status === "NEW") {
        await setStatus(company.leads[0].id, "DISQUALIFIED", `Not a fit for ${product.name}: ${fitDetail.excluded}`);
      }
      return { skipped: true, reason: "ICP_EXCLUDED", detail: fitDetail.excluded };
    }
  } else {
    if (TARGET_INDUSTRY_RE.test(`${company.industry || ""} ${company.osmCategory || ""}`)) fit += 5;
    if (["MICRO", "SMALL", "MEDIUM"].includes(company.sizeBucket)) fit += 3;
    if (company.countryCode) fit += 2;
    fit = Math.min(caps.fit, fit);
  }

  const total = Math.max(0, Math.min(100, Math.round(opportunity + freshness + reachability + fit)));

  // ─── Below the bar ──────────────────────────────────────────────────────────
  // A promote lead may stand on ICP fit alone — "a 40-staff Dubai clinic" is a
  // real prospect for an HR platform even with no detected buying event, and
  // that is precisely what one of the approved search strategies asks for. It
  // will rank below anything with an actual trigger, which is the honest order.
  // What it may not do is stand on *nothing*: a company matching neither the
  // market nor the industry is in the run because a discovery source returned
  // it, not because the profile wanted it.
  const hasBasis = product ? (contributions.length > 0 || fitDetail?.matched) : contributions.length > 0;
  if (total < MIN_SCORE_TO_CREATE_LEAD || !hasBasis) {
    if (company.leads[0]) {
      await prisma.lead.update({
        where: { id: company.leads[0].id },
        data: { score: total, scoredAt: new Date(), status: company.leads[0].status === "NEW" ? "ARCHIVED" : company.leads[0].status },
      });
    }
    return { skipped: true, reason: contributions.length === 0 ? "NO_SIGNALS" : "BELOW_THRESHOLD", score: total };
  }

  // ─── Opportunities & lead type ──────────────────────────────────────────────
  // A promote run has exactly one opportunity and it is not in dispute: the
  // product the run was launched to sell. Deriving it from the signal mix the
  // way an agency lead does produced `WEBSITE_DEV` on every lead of a run
  // started to sell an HR platform, which then drove the ranking, the grid's
  // "opportunity" column and the copy the composer reached for.
  const opportunities = product
    ? [{ service: "SAAS_PRODUCT", points: Math.round(opportunity + fit) }]
    : [...serviceTotals.entries()]
        .map(([service, points]) => ({ service, points: Math.round(points * 10) / 10 }))
        .sort((a, b) => b.points - a.points)
        .slice(0, 4);
  const primaryOpportunity = product ? "SAAS_PRODUCT" : (opportunities[0]?.service || "WEBSITE_DEV");

  // Lead type comes from whichever signal category carries the most points.
  const typeTotals = new Map();
  for (const c of contributions) {
    const leadType = SIGNAL_CATALOG[c.type]?.leadType;
    if (leadType) typeTotals.set(leadType, (typeTotals.get(leadType) || 0) + c.points);
  }
  // TECH_DEBT is the right default for an agency lead with no dominant signal
  // category, and the wrong one for a promote lead standing on ICP fit: it
  // labels a company "technical debt" on the strength of website diagnostics
  // that were deliberately excluded from its score.
  const type = [...typeTotals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || (product ? "DIGITAL_GAP" : "TECH_DEBT");

  const scoreBreakdown = {
    version: SCORE_VERSION,
    categories: { opportunity: Math.round(opportunity), freshness, reachability, fit },
    caps,
    signals: contributions,
    rawOpportunity: Number(rawOpportunity.toFixed(2)),
    // What the approved profile actually recognised in this company, so the
    // breakdown a user opens explains a fit score rather than just asserting it.
    ...(fitDetail ? { icpFit: { product: product.name, matched: fitDetail.matched, reasons: fitDetail.reasons } } : {}),
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
      // ARCHIVED is the engine's own disposition (scored below the bar on an
      // earlier pass), so fresh evidence may lift it back to NEW. DISQUALIFIED
      // is a person's decision — and it used to be resurrected here too, the
      // comment above the line saying the opposite of what the line did. A
      // school judged out of profile by hand came back as a NEW lead on the
      // next run that touched its company.
      ...(existing && existing.status === "ARCHIVED" ? { status: "NEW" } : {}),
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
  // A promote lead that matched on profile alone has no contributing signal to
  // build a sentence from, and a lead card reading "why this is a lead:
  // nothing" is worse than the honest answer — which is that the approved ICP
  // asked for companies like this one and no buying event has been observed
  // yet. The fit reasons are appended rather than substituted, so a lead with
  // both a real trigger and a profile match still leads with the trigger.
  const reasons = [
    ...buildReasons(contributions, company),
    ...(fitDetail?.reasons || [])
      .filter((r) => r.points > 0)
      .map((r) => ({ text: r.text.slice(0, 500), signalId: null, confidenceLevel: "INFERRED" })),
  ].slice(0, 6);
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
  // Promote runs pitch a named product, so the label the composer actually uses
  // comes from the PromotedProduct row. This is the fallback for anything that
  // renders a service name without that context.
  SAAS_PRODUCT: "software",
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
