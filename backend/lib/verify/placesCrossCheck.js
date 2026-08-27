import prisma from "../../prismaClient.js";
import { findPlaceForCompany, isPlacesAvailable } from "../adapters/googlePlaces.js";
import { verifyDomainIdentity } from "./domainIdentity.js";
import { ensureSource, recordSourceRecord, recordFact, recordContact } from "../provenance/recorder.js";
import { normalizeDomain } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("verify:places");

/**
 * Corroborate a company against Google Places.
 *
 * Two questions Places answers better than any open source, and the reason this
 * module exists at all:
 *
 *   1. **Is the business still trading?** OpenStreetMap has no concept of a
 *      closure — a restaurant that shut in 2023 stays in OSM as a perfectly
 *      valid node forever. Places marks it CLOSED_PERMANENTLY. Emailing closed
 *      businesses wastes send quota and damages sending-domain reputation.
 *
 *   2. **Is the website we hold plausible?** Places carries the website the
 *      owner registered with Google.
 *
 * A caveat worth stating, because it shaped this design: Places data can itself
 * be stale. The Riyadh restaurant that prompted this work is listed in Places as
 * CLOSED_PERMANENTLY while *still* advertising the domain it lost years ago —
 * a domain now serving gambling spam. So a website read from Places is a
 * candidate, never an answer: it is put through verifyDomainIdentity exactly
 * like every other source before it is allowed near a lead.
 *
 * Storage follows Google Maps Platform terms: `place_id` is persisted (Google
 * permits this indefinitely), and everything else is recorded as a timestamped
 * point-in-time observation used to correct our own open-source record, not as
 * a durable copy of Google's database.
 */

/** Places content is a point-in-time reading; re-check rather than trust an old one. */
const RECHECK_AFTER_DAYS = 30;

const PLACES_ATTRIBUTION =
  "Business status and location corroborated against Google Places at the time shown. " +
  "Place ID retained for re-checking; all other Places content is a point-in-time observation.";

/**
 * @param {string} companyId
 * @param {{budget?:object, force?:boolean}} opts
 * @returns {Promise<{ok:boolean, reason?:string, closed:boolean, corrected:boolean, confidence:number}>}
 */
export const crossCheckWithPlaces = async (companyId, { budget = null, force = false } = {}) => {
  if (!isPlacesAvailable()) return { ok: false, reason: "DISABLED", closed: false, corrected: false, confidence: 0 };

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { domains: true, contacts: true, locations: { take: 1 }, facts: { where: { key: "places_checked_at" }, take: 1 } },
  });
  if (!company) return { ok: false, reason: "NO_COMPANY", closed: false, corrected: false, confidence: 0 };

  // Re-checking every company on every run would burn the budget on data that
  // rarely changes; a closure is not a same-week event.
  const lastChecked = company.facts[0]?.value ? new Date(company.facts[0].value) : null;
  if (!force && lastChecked && Date.now() - lastChecked.getTime() < RECHECK_AFTER_DAYS * 86_400_000) {
    return { ok: true, reason: "RECENTLY_CHECKED", closed: false, corrected: false, confidence: 0 };
  }

  const location = company.locations[0] || null;
  const result = await findPlaceForCompany({
    name: company.name,
    city: company.city,
    countryCode: company.countryCode,
    phones: company.contacts.filter((c) => c.kind === "PHONE").map((c) => c.value),
    domain: company.domains[0]?.domain || null,
    lat: location?.lat ?? null,
    lon: location?.lon ?? null,
  }, { budget });

  if (!result.ok) return { ok: false, reason: result.reason, closed: false, corrected: false, confidence: 0 };

  if (!result.match) {
    // Not finding a business in Places is weak evidence of anything — plenty of
    // small firms are unlisted — so it is recorded, not acted on.
    await recordFact({
      companyId, key: "places_no_match", value: "true", confidenceLevel: "DETECTED",
      extractorName: "placesCrossCheck",
      evidenceSnippet: `No Google Places listing matched "${company.name}" in ${company.city || "its area"} with sufficient confidence (best score ${result.confidence}).`,
    });
    await stampChecked(companyId);
    return { ok: true, reason: "NO_CONFIDENT_MATCH", closed: false, corrected: false, confidence: result.confidence };
  }

  const match = result.match;
  const source = await ensureSource({ kind: "GOOGLE_PLACES", name: "Google Places", attribution: PLACES_ATTRIBUTION });
  const record = await recordSourceRecord({
    sourceId: source.id,
    externalId: match.placeId,
    url: match.placeId ? `https://www.google.com/maps/place/?q=place_id:${match.placeId}` : null,
    payload: {
      placeId: match.placeId, businessStatus: match.businessStatus, primaryType: match.primaryType,
      rating: match.rating, reviewCount: match.reviewCount, matchConfidence: result.confidence,
      observedAt: new Date().toISOString(),
    },
  });

  // place_id is the one Places field we are permitted to keep indefinitely, and
  // it is what makes a cheap re-check possible later.
  await recordFact({
    companyId, key: "google_place_id", value: match.placeId, confidenceLevel: "VERIFIED",
    extractorName: "placesCrossCheck", sourceRecordId: record.id,
    evidenceSnippet: `Matched to the Google Places listing for "${match.name}" with ${result.confidence}% confidence.`,
  });

  let closed = false;
  if (match.businessStatus && match.businessStatus !== "OPERATIONAL") {
    closed = match.businessStatus === "CLOSED_PERMANENTLY";
    await recordFact({
      companyId,
      key: closed ? "business_closed_permanently" : "business_closed_temporarily",
      value: match.businessStatus,
      confidenceLevel: "VERIFIED",
      extractorName: "placesCrossCheck",
      sourceRecordId: record.id,
      evidenceSnippet: `Google Places lists "${match.name}" as ${match.businessStatus} as of ${new Date().toISOString().slice(0, 10)}. Outreach to a closed business wastes send quota and harms domain reputation.`,
    });
    logger.info({ company: company.name, status: match.businessStatus }, "business is not operational — flagged");
  }

  // Review count is a genuine size/traction proxy, and one no open source
  // provides. A 3,000-review business with a weak site is a far stronger lead
  // than a 4-review one with the same site.
  if (typeof match.reviewCount === "number") {
    await recordFact({
      companyId, key: "google_review_count", value: String(match.reviewCount),
      confidenceLevel: "DETECTED", extractorName: "placesCrossCheck", sourceRecordId: record.id,
      evidenceSnippet: `Google Places records ${match.reviewCount} reviews${match.rating ? ` at ${match.rating}★` : ""} as of ${new Date().toISOString().slice(0, 10)}.`,
    });
  }

  // A phone from Places is a real, checkable contact point — recorded as
  // DETECTED because we observed it in a directory, not on the company's site.
  if (match.phone) {
    await recordContact({
      companyId, kind: "PHONE", value: match.phone, roleHint: "GOOGLE_PLACES",
      confidenceLevel: "DETECTED", sourceRecordId: record.id,
    });
  }

  // ── Website reconciliation ──
  // Places' website is treated as a *candidate*, never an answer. A closed
  // business's listing routinely still advertises a lapsed domain.
  let corrected = false;
  const placesDomain = normalizeDomain(match.website);
  const held = new Set(company.domains.map((d) => d.domain));

  if (placesDomain && !held.has(placesDomain) && !closed) {
    const identity = await verifyDomainIdentity(placesDomain, {
      name: company.name,
      city: company.city,
      countryCode: company.countryCode,
      phones: [match.phone, ...company.contacts.filter((c) => c.kind === "PHONE").map((c) => c.value)].filter(Boolean),
    });

    if (identity.verdict === "OWNED") {
      await prisma.companyDomain.upsert({
        where: { domain: identity.domain },
        update: {
          identityStatus: "CONFIRMED", identityScore: identity.score,
          identityReason: identity.reason.slice(0, 500), identityCheckedAt: new Date(),
        },
        create: {
          companyId, domain: identity.domain, discoveredVia: "GOOGLE_PLACES",
          isPrimary: held.size === 0, httpsOk: true,
          identityStatus: "CONFIRMED", identityScore: identity.score,
          identityReason: identity.reason.slice(0, 500), identityCheckedAt: new Date(),
        },
      });
      await recordFact({
        companyId, key: "resolved_domain", value: identity.domain, confidenceLevel: "DETECTED",
        extractorName: "placesCrossCheck", sourceRecordId: record.id,
        evidenceSnippet: identity.reason.slice(0, 500),
      });
      corrected = true;
      logger.info({ company: company.name, domain: identity.domain }, "website corrected from Google Places");
    } else {
      await recordFact({
        companyId, key: "places_website_rejected", value: placesDomain, confidenceLevel: "VERIFIED",
        extractorName: "placesCrossCheck", sourceRecordId: record.id,
        evidenceSnippet: `Google Places lists ${placesDomain} for this business, but it was rejected: ${identity.reason}`.slice(0, 500),
      });
    }
  }

  await stampChecked(companyId);
  return { ok: true, closed, corrected, confidence: result.confidence, placeId: match.placeId };
};

const stampChecked = (companyId) =>
  recordFact({
    companyId, key: "places_checked_at", value: new Date().toISOString(),
    confidenceLevel: "VERIFIED", extractorName: "placesCrossCheck",
    evidenceSnippet: `Google Places corroboration last run ${new Date().toISOString()}.`,
  });

export const __testables = { RECHECK_AFTER_DAYS };
