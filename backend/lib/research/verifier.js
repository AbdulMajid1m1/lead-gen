import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { extractContacts } from "../extract/contacts.js";
import { recordContact, recordSourceRecord, ensureSource, isSuppressed } from "../provenance/recorder.js";
import { phoneMatchKey, normalizeDomain } from "../../utils/normalize.js";
import { AI_MAX_CITATION_FETCHES } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("aiVerify");

/**
 * Turns AI claims into facts — or refuses to.
 *
 * The rule this module exists to enforce: **the model may point, only
 * observation may assert.** An AI-claimed email address is worth nothing until
 * our own crawler has fetched a real page and seen that exact address on it.
 * Everything else stays visibly labelled as an unverified AI claim.
 *
 * The confidence a claim can earn:
 *   VERIFIED  — observed on the company's own website
 *   DETECTED  — observed on the third-party page the model cited
 *   (nothing) — never observed; stays an AiClaim, never becomes a Contact
 */

/** Compare two claimed values the way a human would consider them "the same". */
const valuesMatch = (field, claimed, observed) => {
  if (!claimed || !observed) return false;
  switch (field) {
    case "EMAIL":
      return claimed.trim().toLowerCase() === observed.trim().toLowerCase();
    case "PHONE":
    case "WHATSAPP": {
      // Numbers are written a dozen ways; compare on the last 9 digits, which
      // survives country-code and formatting differences.
      const a = phoneMatchKey(claimed);
      const b = phoneMatchKey(observed);
      return Boolean(a && b && a === b);
    }
    case "WEBSITE":
      return normalizeDomain(claimed) === normalizeDomain(observed);
    case "ADDRESS": {
      const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const a = norm(claimed);
      const b = norm(observed);
      return a.length > 8 && (b.includes(a) || a.includes(b));
    }
    default:
      return false;
  }
};

const CONTACT_KIND = { EMAIL: "EMAIL", PHONE: "PHONE", WHATSAPP: "PHONE" };

/** Everything our crawler already observed on a page, as comparable values. */
const observedValuesFrom = (html, pageUrl) => {
  const found = extractContacts(html, { pageUrl });
  return {
    EMAIL: found.emails.map((e) => e.value),
    PHONE: found.phones.map((p) => p.value),
    // A WhatsApp claim is only ever satisfied by an explicit wa.me link — a
    // phone number merely existing never means the business is on WhatsApp.
    WHATSAPP: found.socials.filter((s) => s.network === "WHATSAPP").map((s) => s.handle || s.url),
    WEBSITE: [pageUrl],
    ADDRESS: [],
  };
};

/**
 * Verify every claim on one candidate.
 *
 * @returns {Promise<{confirmed:number, contradicted:number, uncheckable:number, fetches:number}>}
 */
export const verifyCandidateClaims = async (candidateId, { fetchBudget = AI_MAX_CITATION_FETCHES } = {}) => {
  const candidate = await prisma.aiCandidate.findUnique({
    where: { id: candidateId },
    include: { claims: true, company: { include: { contacts: true, domains: true } } },
  });
  if (!candidate?.companyId || !candidate.company) {
    return { confirmed: 0, contradicted: 0, uncheckable: 0, fetches: 0 };
  }

  const company = candidate.company;
  const ownDomains = new Set(company.domains.map((d) => d.domain));
  const stats = { confirmed: 0, contradicted: 0, uncheckable: 0, fetches: 0 };

  // Contacts already gathered by the normal crawl of the company's own site.
  // A claim matching one of these is confirmed for free — no extra request.
  const ownSiteValues = {
    EMAIL: company.contacts.filter((c) => c.kind === "EMAIL").map((c) => c.value),
    PHONE: company.contacts.filter((c) => c.kind === "PHONE").map((c) => c.value),
    WHATSAPP: company.contacts.filter((c) => c.kind === "SOCIAL" && c.roleHint === "WHATSAPP").map((c) => c.value),
    WEBSITE: [...ownDomains],
    ADDRESS: [],
  };

  for (const claim of candidate.claims) {
    if (claim.status !== "UNVERIFIED") continue;

    // Suppression wins over everything, including a confirmed observation.
    if (["EMAIL", "PHONE"].includes(claim.field) && (await isSuppressed(claim.field, claim.value))) {
      await setClaim(claim.id, "SUPPRESSED", { note: "Value is on the suppression list." });
      continue;
    }

    // ── 1. Already observed on the company's own site → VERIFIED ─────────────
    const ownHit = (ownSiteValues[claim.field] || []).find((v) => valuesMatch(claim.field, claim.value, v));
    if (ownHit) {
      const contact = company.contacts.find((c) => c.value === ownHit);
      await setClaim(claim.id, "CONFIRMED_OWN_SITE", {
        verifiedContactId: contact?.id ?? null,
        note: "Observed by our crawler on the company's own website.",
      });
      stats.confirmed += 1;
      continue;
    }

    // ── 2. Go and look at the page the model cited ───────────────────────────
    if (!claim.foundOnUrl || stats.fetches >= fetchBudget) {
      await setClaim(claim.id, "UNCHECKABLE", {
        note: claim.foundOnUrl ? "Verification budget for this run was exhausted." : "The model gave no source page for this value.",
      });
      stats.uncheckable += 1;
      continue;
    }

    stats.fetches += 1;
    const res = await fetchPage(claim.foundOnUrl, { timeoutMs: 12_000 });

    if (!res.ok || !res.body) {
      // Being unable to check is not evidence of anything — record why, and
      // leave the claim visibly unverified rather than quietly trusting it.
      await setClaim(claim.id, "UNCHECKABLE", {
        note: `Could not read the cited page: ${res.blockReason || "no content"}.`,
      });
      stats.uncheckable += 1;
      continue;
    }

    const observed = observedValuesFrom(res.body, res.finalUrl);
    const hit = (observed[claim.field] || []).find((v) => valuesMatch(claim.field, claim.value, v));

    if (!hit) {
      await setClaim(claim.id, "CONTRADICTED", {
        note: "The cited page was fetched but does not contain this value.",
      });
      stats.contradicted += 1;
      continue;
    }

    // Observed on a third party's page — real, but weaker than the company's
    // own site, so it earns DETECTED rather than VERIFIED.
    const source = await ensureSource({
      kind: "AI_WEB_SEARCH",
      name: "AI web search (cited page)",
      attribution: "Contact detail observed by our crawler on a page cited by AI web search.",
    });
    const record = await recordSourceRecord({
      sourceId: source.id,
      externalId: null,
      url: res.finalUrl,
      payload: { url: res.finalUrl, status: res.status, contentHash: res.contentHash, verifiedField: claim.field, verifiedValue: hit },
    });

    const kind = CONTACT_KIND[claim.field];
    let contactId = null;
    if (kind) {
      const contact = await recordContact({
        companyId: company.id,
        kind,
        value: hit,
        roleHint: claim.field === "WHATSAPP" ? "WHATSAPP" : "AI_CITED_PAGE",
        confidenceLevel: "DETECTED",
        sourceRecordId: record.id,
      });
      contactId = contact.id;
    }

    await setClaim(claim.id, "CONFIRMED_THIRD_PARTY", {
      verifiedContactId: contactId,
      note: `Observed on the cited page ${res.finalUrl}.`,
    });
    stats.confirmed += 1;
  }

  logger.debug({ candidate: candidate.name, ...stats }, "claims verified");
  return stats;
};

const setClaim = (id, status, { verifiedContactId = null, crawlResultId = null, note = null } = {}) =>
  prisma.aiClaim.update({
    where: { id },
    data: { status, verifiedContactId, crawlResultId, note: note?.slice(0, 300) ?? null, checkedAt: new Date() },
  });

/**
 * The existence gate.
 *
 * A business the AI invented has no website we can fetch, no map record and no
 * confirmed contact detail. Requiring at least one of those before a candidate
 * becomes a scored lead makes hallucinated companies structurally incapable of
 * reaching the results grid.
 */
export const passesExistenceGate = async (candidateId) => {
  const candidate = await prisma.aiCandidate.findUnique({
    where: { id: candidateId },
    include: { claims: true, company: { include: { domains: true, locations: true, contacts: true } } },
  });
  if (!candidate?.company) return { passed: false, reason: "No company was resolved for this candidate." };

  const c = candidate.company;
  const hasFetchedSite = Boolean(c.lastCrawledAt) && c.domains.length > 0;
  const hasMapRecord = c.locations.length > 0;
  const hasConfirmedClaim = candidate.claims.some((cl) =>
    ["CONFIRMED_OWN_SITE", "CONFIRMED_THIRD_PARTY"].includes(cl.status));
  const hasIndependentContact = c.contacts.some((ct) => ct.confidenceLevel === "VERIFIED");

  if (hasFetchedSite || hasMapRecord || hasConfirmedClaim || hasIndependentContact) {
    return { passed: true, reason: null };
  }
  return {
    passed: false,
    reason: "No fetchable website, no map record and no independently confirmed contact detail — the business could not be shown to exist.",
  };
};
