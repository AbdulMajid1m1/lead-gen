import prisma from "../../prismaClient.js";
import { searchAndParse, citationsAreGrounded, isResearchAvailable } from "../llm/responses.js";
import { DISCOVER_SYSTEM, buildDiscoverUser, DISCOVER_SCHEMA } from "./prompts.js";
import { ensureSource, recordSourceRecord, resolveCompany } from "../provenance/recorder.js";
import { normalizeDomain, normalizeCompanyName } from "../../utils/normalize.js";
import { classifyExcludedBusiness, exclusionNote } from "../qualify/excludedCategories.js";
import { AI_MAX_CANDIDATES, AI_SEARCH_MODEL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("research:discover");

const CLAIM_FIELDS = [
  ["email", "EMAIL", "email"],
  ["phone", "PHONE", "phone"],
  ["whatsapp", "WHATSAPP", "whatsapp"],
  ["addressText", "ADDRESS", "address"],
  ["website", "WEBSITE", "website"],
];

/**
 * Run one web-search strategy and land the results as quarantined candidates.
 *
 * Nothing here writes a Contact or an ExtractedFact. The whole output is
 * `AiCandidate` + `AiClaim` rows — claims waiting to be checked. The immutable
 * API response is stored as a SourceRecord first, so even a rejected candidate
 * remains explainable afterwards.
 */
export const discoverViaWebSearch = async ({ runId, strategy, brief, tracker, maxCompanies = 12 }) => {
  if (!isResearchAvailable()) return { ok: false, reason: "AI_UNAVAILABLE", created: 0 };

  const region = brief.location?.name || "worldwide";
  const result = await searchAndParse({
    system: DISCOVER_SYSTEM,
    user: buildDiscoverUser({ strategy, brief, region, maxCompanies }),
    schema: DISCOVER_SCHEMA,
    schemaName: "company_discovery",
    model: AI_SEARCH_MODEL,
    searchContextSize: "medium",
    country: brief.location?.countryCode || null,
    city: brief.location?.cities?.[0] || null,
    tracker,
  });

  if (!result?.data?.companies) {
    return { ok: false, reason: tracker?.lastError ? "AI_ERROR" : "NO_RESULTS", created: 0 };
  }

  const source = await ensureSource({
    kind: "AI_WEB_SEARCH",
    name: "AI web search",
    attribution: `Companies surfaced by OpenAI web search (${result.model}); every claim independently verified before use.`,
  });

  // The full response — including the list of pages the search actually
  // retrieved — is the provenance root for every candidate below.
  const record = await recordSourceRecord({
    sourceId: source.id,
    externalId: `${runId}:${strategy.label}`.slice(0, 255),
    url: null,
    payload: { strategy, companies: result.data.companies, searchNotes: result.data.searchNotes, sources: result.sources, model: result.model },
  });

  const existing = await prisma.aiCandidate.count({ where: { runId } });
  let created = 0;
  let uncited = 0;

  for (const company of result.data.companies) {
    if (existing + created >= AI_MAX_CANDIDATES) break;
    if (!company?.name?.trim()) continue;
    if (!normalizeCompanyName(company.name)) continue;

    // Citation guard: a source URL the search never visited means the model
    // wrote a plausible-looking link rather than reporting one it read.
    const grounded = citationsAreGrounded(company.sourceUrls || [], result.sources || []);

    try {
      const candidate = await prisma.aiCandidate.create({
        data: {
          runId,
          sourceRecordId: record.id,
          strategyLabel: strategy.label.slice(0, 120),
          name: company.name.slice(0, 160),
          nameLocal: company.nameLocal?.slice(0, 160) ?? null,
          claimedWebsite: company.website?.slice(0, 300) ?? null,
          claimedCity: company.city?.slice(0, 80) ?? null,
          industryGuess: company.industryGuess?.slice(0, 60) ?? null,
          whyMatch: (company.whyMatch || "").slice(0, 300),
          matchConfidence: grounded ? (company.matchConfidence || "MEDIUM") : "LOW",
          uncited: !grounded,
          status: grounded ? "PENDING" : "REJECTED_UNCITED",
          rejectedReason: grounded ? null : "Cited a source page that the web search did not actually retrieve.",
          claims: {
            create: CLAIM_FIELDS
              .filter(([key]) => company[key])
              .map(([key, field, sourceKey]) => ({
                field,
                value: String(company[key]).slice(0, 500),
                foundOnUrl: company.detailSources?.[sourceKey]?.slice(0, 600)
                  || company.sourceUrls?.[0]?.slice(0, 600)
                  || null,
              })),
          },
          citations: {
            create: (company.sourceUrls || []).slice(0, 5).map((url) => ({
              url: String(url).slice(0, 600),
              inSources: (result.sources || []).some((s) => s === url),
            })),
          },
        },
      });
      created += 1;
      if (!grounded) uncited += 1;
      logger.debug({ name: candidate.name, grounded }, "candidate recorded");
    } catch (err) {
      // A duplicate name inside one run is expected; anything else is logged.
      if (!String(err.message).includes("Unique constraint")) {
        logger.debug({ name: company.name, msg: err.message }, "candidate not recorded");
      }
    }
  }

  return { ok: true, created, uncited, searched: (result.sources || []).length, notes: result.data.searchNotes };
};

/**
 * Resolve candidates onto real companies.
 *
 * Reuses the existing dedupe ladder, so a business the map search already found
 * is enriched rather than duplicated — and an AI-only company enters through
 * exactly the same door as every other source.
 */
export const resolveCandidates = async (runId, { exclusions = [], countryCode = null } = {}) => {
  const candidates = await prisma.aiCandidate.findMany({ where: { runId, status: "PENDING" } });
  const stats = { matched: 0, created: 0, excluded: 0 };

  // Each exclusion is matched as the phrase it is, against the candidate's
  // name and website only. It used to be split into words and tested against
  // the description too, so "Zoho People" on a promote run's competitor list
  // became a bare "People" keyword — and every candidate whose evidence
  // mentioned a People Operations or People & Culture vacancy was thrown out
  // as if it were the competitor. Those were the strongest HR-buying signals
  // in the whole run.
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exclusionRe = exclusions.length
    ? new RegExp(
        exclusions
          .map((e) => String(e || "").trim())
          .filter((e) => e.length > 2)
          .map((e) => `\\b${escape(e).replace(/\s+/g, "\\s+")}\\b`)
          .join("|"),
        "i",
      )
    : null;

  for (const candidate of candidates) {
    // The standing exclusions come first and do not depend on the brief: the
    // model is told not to return bars, casinos and the rest, but a claim is a
    // claim and is checked here regardless.
    const trade = classifyExcludedBusiness({
      name: candidate.name, industry: candidate.industryGuess, description: candidate.whyMatch,
    });
    if (trade) {
      await prisma.aiCandidate.update({
        where: { id: candidate.id },
        data: { status: "REJECTED_EXCLUDED", rejectedReason: exclusionNote(trade).slice(0, 500) },
      });
      stats.excluded += 1;
      continue;
    }

    // Honour the brief's exclusions — "businesses that need POS software" must
    // not return the companies that sell it.
    if (exclusionRe && exclusionRe.test(`${candidate.name} ${candidate.claimedWebsite || ""}`)) {
      await prisma.aiCandidate.update({
        where: { id: candidate.id },
        data: { status: "REJECTED_EXCLUDED", rejectedReason: "Matched an exclusion from the research brief." },
      });
      stats.excluded += 1;
      continue;
    }

    const suppressed = await prisma.suppressionEntry.findFirst({
      where: { OR: [{ kind: "COMPANY", value: normalizeCompanyName(candidate.name) },
                    ...(normalizeDomain(candidate.claimedWebsite) ? [{ kind: "DOMAIN", value: normalizeDomain(candidate.claimedWebsite) }] : [])] },
    });
    if (suppressed) {
      await prisma.aiCandidate.update({
        where: { id: candidate.id },
        data: { status: "REJECTED_EXCLUDED", rejectedReason: "On the suppression list." },
      });
      stats.excluded += 1;
      continue;
    }

    const phoneClaim = await prisma.aiClaim.findFirst({ where: { candidateId: candidate.id, field: "PHONE" } });

    const { company, created, matchedOn } = await resolveCompany({
      name: candidate.name,
      domain: normalizeDomain(candidate.claimedWebsite),
      phone: phoneClaim?.value || null,
      city: candidate.claimedCity,
      // The market the run was aimed at. Without it a candidate-born company
      // has no countryCode, and sendPolicyFor() then reads it as an unknown
      // market and answers RESTRICTED — which silently withholds every lead
      // this path produces, however clearly it is legal to contact.
      countryCode,
      industry: candidate.industryGuess && candidate.industryGuess !== "OTHER" ? candidate.industryGuess : null,
      discoveredVia: "AI_WEB_SEARCH",
    });

    await prisma.aiCandidate.update({
      where: { id: candidate.id },
      data: { companyId: company.id, matchedOn: matchedOn ?? null, status: created ? "CREATED_COMPANY" : "MATCHED_EXISTING" },
    });
    if (created) stats.created += 1;
    else stats.matched += 1;
  }

  logger.info({ runId, ...stats }, "candidates resolved");
  return stats;
};
