import prisma from "../../prismaClient.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { relativeAge, freshnessBucket } from "../scoring/decay.js";
import { log } from "../../utils/logger.js";
import { pickDisplayPhone } from "../outreach/phoneRank.js";

const logger = log("research:grid");

/**
 * Builds the results grid — the screen the user actually works from.
 *
 * Confidence is carried **per cell**, not per row, because that is how the data
 * really arrives: a company can have a phone number we verified ourselves next
 * to an email the AI merely claimed. Flattening those into one row-level badge
 * would be the single most misleading thing this UI could do.
 */

const cell = (value, confidenceLevel, sourceUrl = null, extra = {}) =>
  value ? { value, confidenceLevel, sourceUrl, ...extra } : null;

/** Pick the best contact of a kind — a verified one always beats a claimed one. */
const RANK = { VERIFIED: 3, DETECTED: 2, INFERRED: 1, AI_GENERATED: 0 };
const best = (contacts) =>
  [...contacts].sort((a, b) => (RANK[b.confidenceLevel] ?? 0) - (RANK[a.confidenceLevel] ?? 0))[0] || null;

export const buildGridRows = async (runId) => {
  const run = await prisma.discoveryRun.findUnique({
    where: { id: runId },
    include: {
      researchBrief: true,
      aiCandidates: { include: { claims: true, citations: true } },
    },
  });
  if (!run) return null;

  // Every company this run touched, whether it came from the map search, the
  // crawler or the AI — they are all first-class here.
  const candidateCompanyIds = run.aiCandidates.filter((c) => c.companyId).map((c) => c.companyId);
  const leads = await prisma.lead.findMany({
    where: {
      status: { notIn: ["DO_NOT_CONTACT", "ARCHIVED"] },
      OR: [{ discoveryRunId: runId }, { companyId: { in: candidateCompanyIds } }],
    },
    include: {
      company: {
        include: {
          domains: true,
          contacts: { where: { isSuppressed: false } },
          locations: { take: 1 },
          facts: { where: { key: { in: ["domain_unresolved", "osm_no_website_tag", "website_description"] } } },
        },
      },
      reasons: { orderBy: { rank: "asc" }, take: 3 },
      emailDrafts: { orderBy: { createdAt: "desc" }, take: 1 },
      actions: { orderBy: { priority: "desc" }, take: 1 },
    },
    orderBy: [{ score: "desc" }, { newestEvidenceAt: "desc" }],
  });

  const candidateByCompany = new Map(run.aiCandidates.filter((c) => c.companyId).map((c) => [c.companyId, c]));

  const rows = leads.map((lead, i) => {
    const c = lead.company;
    const candidate = candidateByCompany.get(c.id);
    const draft = lead.emailDrafts[0] || null;

    const emails = c.contacts.filter((x) => x.kind === "EMAIL" && x.roleHint !== "NON_OUTREACH");
    const phones = c.contacts.filter((x) => x.kind === "PHONE");
    const whatsapps = c.contacts.filter((x) => x.kind === "SOCIAL" && x.roleHint === "WHATSAPP");
    const socials = c.contacts.filter((x) => x.kind === "SOCIAL" && x.roleHint !== "WHATSAPP");
    const bestEmail = best(emails);
    // Ranked by the same rule the sender uses, so the grid never shows a
    // switchboard as "the number" while the campaign quietly picks another.
    const bestPhone = pickDisplayPhone(phones, c.countryCode);
    const bestWhats = best(whatsapps);

    // Claims we could not confirm are shown, clearly marked, never promoted.
    const unverifiedClaims = (candidate?.claims || [])
      .filter((cl) => ["UNVERIFIED", "UNCHECKABLE", "CONTRADICTED"].includes(cl.status))
      .map((cl) => ({ field: cl.field, value: cl.value, status: cl.status, foundOnUrl: cl.foundOnUrl, note: cl.note }));

    const foundBy = [];
    if (candidate) foundBy.push("AI_WEB_SEARCH");
    if (c.locations.length) foundBy.push("OVERPASS");
    if (c.lastCrawledAt) foundBy.push("WEBSITE_CRAWL");

    return {
      rank: i + 1,
      leadId: lead.id,
      companyId: c.id,
      name: c.name,
      nameLocal: candidate?.nameLocal || null,
      // "No website" is only claimed when a source actually established the
      // absence (an OSM listing with no website tag, or a failed resolution
      // attempt). A company nobody checked yet shows as unknown, not absent.
      website: c.domains[0]
        ? { url: `https://${c.domains[0].domain}`, domain: c.domains[0].domain, confidenceLevel: "VERIFIED" }
        : c.facts.some((f) => f.key === "osm_no_website_tag")
          ? { url: null, domain: null, confidenceLevel: "VERIFIED", absent: true }
          : c.facts.some((f) => f.key === "domain_unresolved")
            ? { url: null, domain: null, confidenceLevel: "DETECTED", absent: true }
            : null,
      about: draft?.aboutCompany
        ? { text: draft.aboutCompany, confidenceLevel: draft.generatedBy === "LLM" ? "AI_GENERATED" : "INFERRED" }
        : c.description
          ? { text: c.description, confidenceLevel: "DETECTED" }
          : c.facts.find((f) => f.key === "website_description")?.value
            ? { text: c.facts.find((f) => f.key === "website_description").value, confidenceLevel: "DETECTED" }
            : candidate?.whyMatch
              ? { text: candidate.whyMatch, confidenceLevel: "AI_GENERATED" }
              : null,
      contacts: {
        email: cell(bestEmail?.value, bestEmail?.confidenceLevel, null, { roleHint: bestEmail?.roleHint }),
        phone: cell(bestPhone?.display, bestPhone?.confidenceLevel),
        whatsapp: cell(bestWhats?.value, bestWhats?.confidenceLevel),
        socials: socials.map((s) => ({ network: s.roleHint, url: s.value, confidenceLevel: s.confidenceLevel })),
        unverifiedClaims,
      },
      address: c.locations[0]?.addressLine
        ? { value: [c.locations[0].addressLine, c.locations[0].city].filter(Boolean).join(", "), confidenceLevel: "VERIFIED", source: "OpenStreetMap" }
        : candidate?.claims?.find((cl) => cl.field === "ADDRESS" && cl.status.startsWith("CONFIRMED"))
          ? { value: candidate.claims.find((cl) => cl.field === "ADDRESS").value, confidenceLevel: "DETECTED", source: "cited page" }
          : null,
      city: c.city,
      industry: c.industry,
      score: lead.score,
      freshness: { relative: relativeAge(lead.newestEvidenceAt), bucket: freshnessBucket(lead.newestEvidenceAt) },
      primaryOpportunity: lead.primaryOpportunity,
      primaryOpportunityLabel: SERVICE_LABELS[lead.primaryOpportunity],
      why: lead.reasons.map((r) => ({ text: r.text, confidenceLevel: r.confidenceLevel })),
      recommendedAction: lead.actions[0]?.title || null,
      outreachEmail: draft
        ? { id: draft.id, subject: draft.subject, body: draft.body, generatedBy: draft.generatedBy, confidenceLevel: draft.confidenceLevel, factCount: (draft.groundingFacts || []).length }
        : null,
      citations: (candidate?.citations || []).map((x) => ({ url: x.url, title: x.title })),
      foundBy,
      status: lead.status,
      provenanceUrl: `/api/leads/${lead.id}/provenance`,
    };
  });

  // Candidates that never earned a place in the scored grid, kept visible so
  // "the AI mentioned this but we could not confirm it" is never hidden.
  const rejected = run.aiCandidates
    .filter((c) => c.status.startsWith("REJECTED"))
    .map((c) => ({
      name: c.name,
      nameLocal: c.nameLocal,
      claimedWebsite: c.claimedWebsite,
      claimedCity: c.claimedCity,
      whyMatch: c.whyMatch,
      status: c.status,
      reason: c.rejectedReason,
      citations: c.citations.map((x) => x.url),
    }));

  return { rows, unverified: rejected, brief: run.researchBrief?.brief ?? null, aiUsage: run.aiUsage ?? null };
};

/**
 * Freeze the grid into history.
 *
 * Leads keep changing — re-scored every four hours, re-crawled nightly — so a
 * run opened next week would otherwise show different numbers than the ones the
 * user acted on. The snapshot is what makes history trustworthy.
 */
export const snapshotGrid = async (runId) => {
  const built = await buildGridRows(runId);
  if (!built) return { rows: 0 };

  await prisma.researchResultRow.deleteMany({ where: { runId } });
  for (const row of built.rows) {
    await prisma.researchResultRow.create({
      data: { runId, rank: row.rank, leadId: row.leadId, snapshot: row },
    });
  }
  for (const [i, row] of built.unverified.entries()) {
    await prisma.researchResultRow.create({
      data: { runId, rank: 1000 + i, leadId: null, snapshot: { ...row, unverifiedCandidate: true } },
    });
  }

  logger.info({ runId, rows: built.rows.length, unverified: built.unverified.length }, "grid snapshotted to history");
  return { rows: built.rows.length, unverified: built.unverified.length };
};

/** Serve the frozen grid when one exists, otherwise build it live. */
export const getGrid = async (runId) => {
  const snapshot = await prisma.researchResultRow.findMany({ where: { runId }, orderBy: { rank: "asc" } });
  if (snapshot.length) {
    const run = await prisma.discoveryRun.findUnique({ where: { id: runId }, include: { researchBrief: true } });
    return {
      rows: snapshot.filter((r) => !r.snapshot.unverifiedCandidate).map((r) => r.snapshot),
      unverified: snapshot.filter((r) => r.snapshot.unverifiedCandidate).map((r) => r.snapshot),
      brief: run?.researchBrief?.brief ?? null,
      aiUsage: run?.aiUsage ?? null,
      isSnapshot: true,
    };
  }
  const live = await buildGridRows(runId);
  return live ? { ...live, isSnapshot: false } : null;
};
