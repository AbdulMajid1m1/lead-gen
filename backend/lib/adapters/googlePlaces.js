import {
  GOOGLE_MAPS_API_KEY,
  GOOGLE_PLACES_ENABLED,
  GOOGLE_PLACES_TIMEOUT_MS,
  GOOGLE_PLACES_MAX_CALLS_PER_RUN,
} from "../../configs/envConfig.js";
import { normalizeCompanyName, normalizeDomain, phoneMatchKey } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("googlePlaces");

/**
 * Google Places (New) — a corroboration source, not a system of record.
 *
 * Places has near-complete coverage of commercial businesses in the Gulf and
 * wider MENA markets, where OpenStreetMap is sparse. That makes it the best
 * available referee for two questions this pipeline was previously guessing at:
 *
 *   1. Is the website we hold actually this business's current website?
 *   2. Is this business still trading at all?
 *
 * Deliberate constraints, both legal and financial:
 *
 * • Only `place_id` is persisted long-term. Google Maps Platform terms permit
 *   storing place IDs indefinitely but restrict caching other Places content,
 *   and this product keeps leads for months. Names, phones and websites read
 *   from Places are used to *verify or correct* data we hold from open sources,
 *   then discarded — the durable record stays OpenStreetMap and our own crawl.
 *
 * • Every response is requested with an explicit field mask. Places bills by
 *   the fields returned, so an unmasked request costs several times a masked
 *   one for data we would throw away.
 *
 * • Calls are counted against a per-run ceiling by the caller's budget object,
 *   because a grid sweep across categories multiplies quickly.
 */

const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places";

/**
 * The minimum field set that answers our two questions, plus the signals the
 * scoring engine can use. Every field here is paid for, so nothing decorative.
 */
const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.primaryType",
  "places.rating",
  "places.userRatingCount",
].join(",");

/** A simple per-run call ledger so a sweep cannot silently overspend. */
export const createPlacesBudget = (max = GOOGLE_PLACES_MAX_CALLS_PER_RUN) => {
  let used = 0;
  return {
    get used() { return used; },
    get remaining() { return Math.max(0, max - used); },
    tryConsume() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
};

export const isPlacesAvailable = () => GOOGLE_PLACES_ENABLED;

/**
 * One Places Text Search call.
 *
 * Always resolves — a failing corroboration source must degrade the result,
 * never abort the discovery run that called it.
 */
const searchText = async ({ textQuery, locationBias = null, maxResultCount = 5, languageCode, regionCode }) => {
  if (!GOOGLE_PLACES_ENABLED) return { ok: false, reason: "DISABLED", places: [] };

  const body = { textQuery, maxResultCount: Math.min(maxResultCount, 20) };
  if (languageCode) body.languageCode = languageCode;
  if (regionCode) body.regionCode = regionCode;
  if (locationBias) body.locationBias = locationBias;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_PLACES_TIMEOUT_MS);

  try {
    const res = await fetch(`${PLACES_ENDPOINT}:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The key travels in a header, never a query string, so it cannot leak
        // through request logs, referrers or error messages containing the URL.
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Never log the response body verbatim: Google echoes the request, and a
      // 400 would put the API key into the log file.
      logger.warn({ status: res.status, textQuery }, "places search failed");
      return { ok: false, reason: `HTTP_${res.status}`, places: [] };
    }

    const json = await res.json();
    return { ok: true, places: json.places || [] };
  } catch (err) {
    logger.warn({ err: err.name, textQuery }, "places search errored");
    return { ok: false, reason: err.name === "AbortError" ? "TIMEOUT" : "NETWORK", places: [] };
  } finally {
    clearTimeout(timer);
  }
};

/** Normalise one Places result into our own vocabulary. */
const toRecord = (place) => ({
  placeId: place.id || null,
  name: place.displayName?.text || null,
  address: place.formattedAddress || null,
  lat: place.location?.latitude ?? null,
  lon: place.location?.longitude ?? null,
  phone: place.internationalPhoneNumber || place.nationalPhoneNumber || null,
  website: place.websiteUri || null,
  domain: normalizeDomain(place.websiteUri),
  businessStatus: place.businessStatus || null,
  primaryType: place.primaryType || null,
  rating: place.rating ?? null,
  reviewCount: place.userRatingCount ?? null,
});

/**
 * How confident are we that a Places result is the company we are holding?
 *
 * A wrong match here would "correct" a good lead into a different business, so
 * the bar is high: a matching phone number is decisive, and a name match alone
 * is only accepted when the address also places it in the right city.
 *
 * @returns {number} 0–100
 */
const matchConfidence = (record, company) => {
  let score = 0;

  const knownKeys = new Set((company.phones || []).map(phoneMatchKey).filter(Boolean));
  if (knownKeys.size && record.phone && knownKeys.has(phoneMatchKey(record.phone))) score += 70;

  const a = normalizeCompanyName(record.name || "");
  const b = normalizeCompanyName(company.name || "");
  if (a && b) {
    if (a === b) score += 45;
    else {
      const aw = new Set(a.split(" ").filter((w) => w.length >= 3));
      const bw = new Set(b.split(" ").filter((w) => w.length >= 3));
      const overlap = [...bw].filter((w) => aw.has(w)).length;
      if (overlap && overlap >= Math.min(aw.size, bw.size)) score += 35;
      else if (overlap) score += 15;
    }
  }

  if (company.city && record.address && new RegExp(`\\b${company.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(record.address)) {
    score += 20;
  }

  // Matching the domain we already hold is corroboration, but it must not be
  // the reason we accept the match — that would make the check circular when
  // the domain is exactly what we are trying to validate.
  if (company.domain && record.domain && record.domain === company.domain) score += 10;

  return Math.min(100, score);
};

/** Below this, a Places result is treated as a different business entirely. */
const MATCH_THRESHOLD = 55;

/**
 * Find the Places record for a company we already hold.
 *
 * @param {object} company  { name, city, countryCode, phones[], domain, lat, lon }
 * @param {object} opts     { budget }
 * @returns {Promise<{ok:boolean, reason?:string, match:object|null, confidence:number}>}
 */
export const findPlaceForCompany = async (company, { budget = null } = {}) => {
  if (!GOOGLE_PLACES_ENABLED) return { ok: false, reason: "DISABLED", match: null, confidence: 0 };
  if (!company?.name) return { ok: false, reason: "NO_NAME", match: null, confidence: 0 };
  if (budget && !budget.tryConsume()) return { ok: false, reason: "BUDGET_EXHAUSTED", match: null, confidence: 0 };

  // Including the city in the query text is what keeps a common restaurant name
  // from resolving to a same-named business on another continent.
  const queryParts = [company.name, company.city, company.countryCode === "SA" ? "Saudi Arabia" : null]
    .filter(Boolean);

  const locationBias = company.lat != null && company.lon != null
    ? { circle: { center: { latitude: company.lat, longitude: company.lon }, radius: 3000 } }
    : null;

  const res = await searchText({
    textQuery: queryParts.join(", "),
    locationBias,
    maxResultCount: 5,
    regionCode: company.countryCode || undefined,
  });

  if (!res.ok) return { ok: false, reason: res.reason, match: null, confidence: 0 };

  let best = null;
  let bestScore = 0;
  for (const place of res.places) {
    const record = toRecord(place);
    const score = matchConfidence(record, company);
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
  }

  if (!best || bestScore < MATCH_THRESHOLD) {
    return { ok: true, reason: "NO_CONFIDENT_MATCH", match: null, confidence: bestScore };
  }
  return { ok: true, match: best, confidence: bestScore };
};

/**
 * Discover businesses by category within a radius — the coverage complement to
 * Overpass for markets where OpenStreetMap is thin.
 *
 * Text Search returns at most 20 results per call, so callers sweep a grid of
 * centres rather than widening the radius, which would return the same 20.
 */
export const searchBusinesses = async ({ query, lat, lon, radiusMeters = 5000, countryCode = null, budget = null, maxResultCount = 20 }) => {
  if (!GOOGLE_PLACES_ENABLED) return { ok: false, reason: "DISABLED", records: [] };
  if (budget && !budget.tryConsume()) return { ok: false, reason: "BUDGET_EXHAUSTED", records: [] };

  const res = await searchText({
    textQuery: query,
    locationBias: lat != null && lon != null
      ? { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(radiusMeters, 50_000) } }
      : null,
    maxResultCount,
    regionCode: countryCode || undefined,
  });

  if (!res.ok) return { ok: false, reason: res.reason, records: [] };
  return { ok: true, records: res.places.map(toRecord) };
};

export const __testables = { matchConfidence, toRecord, MATCH_THRESHOLD, SEARCH_FIELD_MASK };
