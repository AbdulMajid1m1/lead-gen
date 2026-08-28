import { safeFetch, FetchBlockedError } from "../crawler/safeFetch.js";
import { withHostSlot, setCrawlDelay } from "../crawler/hostPolicy.js";
import { OVERPASS_URL } from "../../configs/envConfig.js";
import { normalizeDomain } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("overpass");

/**
 * OpenStreetMap business discovery.
 *
 * This is the backbone for local-business leads: OSM carries name, category,
 * website, phone, email and opening hours for millions of businesses, is free,
 * and is explicitly open data (ODbL — attribution is stored on the Source row
 * and rendered in the provenance UI).
 *
 * The killer property for this product: a business *with* a phone and address
 * but *without* a `website` tag is a directly actionable website-development
 * lead, and OSM states that absence explicitly.
 */

// Ordered by observed reliability. The main overpass-api.de instance is
// frequently saturated and answers 504 within seconds, so it is the fallback
// rather than the default. A configured OVERPASS_URL always takes precedence.
const MIRRORS = [...new Set([
  OVERPASS_URL,
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
])];

// The public instance allows 2 concurrent slots per IP; one at a time with a
// generous gap keeps us well inside that.
for (const m of MIRRORS) setCrawlDelay(new URL(m).host, 4000);

/**
 * Category lexicon: human words → OSM tag filters.
 * Each entry may match several tags, because OSM models the same real-world
 * business under different keys (`amenity`, `shop`, `office`, `craft`).
 */
export const OSM_CATEGORIES = {
  restaurant:      { label: "Restaurant",            tags: [["amenity", "restaurant"]] },
  cafe:            { label: "Café",                  tags: [["amenity", "cafe"]] },
  fast_food:       { label: "Fast food",             tags: [["amenity", "fast_food"]] },
  bar:             { label: "Bar",                   tags: [["amenity", "bar"], ["amenity", "pub"]] },
  bakery:          { label: "Bakery",                tags: [["shop", "bakery"]] },
  hotel:           { label: "Hotel",                 tags: [["tourism", "hotel"], ["tourism", "guest_house"]] },
  dentist:         { label: "Dental clinic",         tags: [["amenity", "dentist"], ["healthcare", "dentist"]] },
  doctor:          { label: "Medical clinic",        tags: [["amenity", "doctors"], ["amenity", "clinic"], ["healthcare", "doctor"]] },
  pharmacy:        { label: "Pharmacy",              tags: [["amenity", "pharmacy"]] },
  veterinary:      { label: "Veterinary clinic",     tags: [["amenity", "veterinary"]] },
  gym:             { label: "Gym / fitness",         tags: [["leisure", "fitness_centre"], ["leisure", "sports_centre"]] },
  salon:           { label: "Hair & beauty salon",   tags: [["shop", "hairdresser"], ["shop", "beauty"]] },
  spa:             { label: "Spa",                   tags: [["leisure", "spa"], ["shop", "massage"]] },
  real_estate:     { label: "Real-estate agency",    tags: [["office", "estate_agent"]] },
  lawyer:          { label: "Law firm",              tags: [["office", "lawyer"]] },
  accountant:      { label: "Accounting firm",       tags: [["office", "accountant"], ["office", "tax_advisor"]] },
  insurance:       { label: "Insurance agency",      tags: [["office", "insurance"]] },
  travel_agency:   { label: "Travel agency",         tags: [["shop", "travel_agency"]] },
  car_dealer:      { label: "Car dealership",        tags: [["shop", "car"]] },
  car_repair:      { label: "Auto repair shop",      tags: [["shop", "car_repair"]] },
  furniture:       { label: "Furniture store",       tags: [["shop", "furniture"]] },
  clothes:         { label: "Clothing store",        tags: [["shop", "clothes"], ["shop", "boutique"]] },
  jewelry:         { label: "Jewellery store",       tags: [["shop", "jewelry"]] },
  florist:         { label: "Florist",               tags: [["shop", "florist"]] },
  supermarket:     { label: "Supermarket / grocery", tags: [["shop", "supermarket"], ["shop", "convenience"]] },
  electronics:     { label: "Electronics store",     tags: [["shop", "electronics"], ["shop", "computer"]] },
  hardware:        { label: "Hardware store",        tags: [["shop", "hardware"], ["shop", "doityourself"]] },
  optician:        { label: "Optician",              tags: [["shop", "optician"]] },
  pet_shop:        { label: "Pet shop",              tags: [["shop", "pet"]] },
  school:          { label: "School / academy",      tags: [["amenity", "school"], ["amenity", "language_school"], ["amenity", "driving_school"]] },
  childcare:       { label: "Childcare / nursery",   tags: [["amenity", "childcare"], ["amenity", "kindergarten"]] },
  construction:    { label: "Construction company",  tags: [["office", "construction_company"], ["craft", "builder"]] },
  plumber:         { label: "Plumbing services",     tags: [["craft", "plumber"]] },
  electrician:     { label: "Electrical services",   tags: [["craft", "electrician"]] },
  cleaning:        { label: "Cleaning services",     tags: [["shop", "laundry"], ["shop", "dry_cleaning"], ["craft", "cleaning"]] },
  logistics:       { label: "Logistics company",     tags: [["office", "logistics"], ["office", "moving_company"]] },
  marketing:       { label: "Marketing agency",      tags: [["office", "advertising_agency"], ["office", "marketing"]] },
  it_company:      { label: "IT / software company", tags: [["office", "it"], ["office", "telecommunication"]] },
  coworking:       { label: "Coworking space",       tags: [["amenity", "coworking_space"], ["office", "coworking"]] },
  company_office:  { label: "Company office",        tags: [["office", "company"]] },
};

/**
 * Build an Overpass QL query for one of our categories.
 *
 * A radius `around:` filter centred on the geocoded point beats a bounding box
 * here: a city's OSM bounding box is often the whole administrative region
 * (Dubai's covers desert out to the Omani border), which both times the server
 * out and returns businesses nobody asked for.
 *
 * Nodes and ways only, deliberately — not `nwr`. Resolving the relation half of
 * `nwr` costs more than the whole rest of the query on the public instance: the
 * same school search around Dubai answers in 32s as node+way with 79 results,
 * and in 68s as `nwr` with a runtime-error remark and nothing at all. Because
 * Overpass reports that failure inside a 200 response, it surfaced as an empty
 * map step rather than an error, so the map engine was quietly returning
 * nothing. A business is a node or a way; the handful of campuses mapped only
 * as a multipolygon relation are not worth losing every other result for.
 *
 * `out center tags` returns a single coordinate per element instead of full
 * geometry.
 */
export const buildQuery = ({ lat, lon, radiusMeters = 10_000, categoryKey, limit = 200, requireName = true, timeoutSec = 60, tags = null }) => {
  const category = OSM_CATEGORIES[categoryKey];
  if (!category) throw new Error(`Unknown OSM category: ${categoryKey}`);

  const nameFilter = requireName ? '["name"]' : "";
  const area = `around:${Math.round(radiusMeters)},${lat},${lon}`;
  const statements = (tags || category.tags)
    .flatMap(([k, v]) => [
      `  node["${k}"="${v}"]${nameFilter}(${area});`,
      `  way["${k}"="${v}"]${nameFilter}(${area});`,
    ])
    .join("\n");

  return `[out:json][timeout:${timeoutSec}];\n(\n${statements}\n);\nout center tags ${limit};`;
};

/** Map raw OSM tags onto the fields we care about. */
export const normalizeElement = (el) => {
  const t = el.tags || {};
  const name = t.name || t["name:en"] || t.brand;
  if (!name) return null;

  const websiteRaw = t.website || t["contact:website"] || t.url || t["contact:url"] || null;
  const domain = normalizeDomain(websiteRaw);

  const city = t["addr:city"] || t["addr:suburb"] || t["addr:town"] || null;
  const addressLine = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null;

  const categoryTag =
    (t.amenity && `amenity=${t.amenity}`) ||
    (t.shop && `shop=${t.shop}`) ||
    (t.office && `office=${t.office}`) ||
    (t.leisure && `leisure=${t.leisure}`) ||
    (t.tourism && `tourism=${t.tourism}`) ||
    (t.craft && `craft=${t.craft}`) ||
    (t.healthcare && `healthcare=${t.healthcare}`) ||
    null;

  return {
    osmType: el.type,
    osmId: el.id,
    osmKey: `${el.type}/${el.id}`,
    name: String(name).slice(0, 255),
    website: websiteRaw,
    domain,
    // A business listed with a phone but no website is the cleanest
    // website-development lead this product can produce.
    hasWebsiteTag: Boolean(websiteRaw),
    phone: t.phone || t["contact:phone"] || t["contact:mobile"] || null,
    email: t.email || t["contact:email"] || null,
    facebook: t["contact:facebook"] || null,
    instagram: t["contact:instagram"] || null,
    openingHours: t.opening_hours || null,
    cuisine: t.cuisine || null,
    brand: t.brand || null,
    operator: t.operator || null,
    categoryTag,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
    addressLine,
    city,
    postalCode: t["addr:postcode"] || null,
    countryCode: t["addr:country"]?.toUpperCase()?.slice(0, 2) || null,
    tags: t,
  };
};

/**
 * Run a category search over a bounding box, falling back to the mirror when
 * the primary instance is busy (Overpass returns 429/504 under load).
 *
 * @returns {Promise<{ok:boolean, elements:Array, query:string, endpoint:string, reason:string|null}>}
 */
export const searchArea = async ({ lat, lon, radiusMeters = 10_000, categoryKey, limit = 200 }) => {
  // One request per tag, not one request for the whole category.
  //
  // A category expands to a statement per tag per element type, and Overpass
  // charges for each as its own polygon scan over the circle. Asking for all of
  // `doctor` at once — amenity=doctors, amenity=clinic, healthcare=doctor — is
  // six scans in one request, and it times out at every radius in the ladder
  // while any one of those tags on its own answers comfortably. Splitting also
  // means a single expensive tag no longer costs us the whole category: the
  // results are merged, and the search succeeds if any tag answered.
  const category = OSM_CATEGORIES[categoryKey];
  if (!category) throw new Error(`Unknown OSM category: ${categoryKey}`);

  if (category.tags.length > 1) {
    const seen = new Set();
    const merged = [];
    const reasons = [];
    let anyOk = false;
    let usedEndpoint = null;
    let lastQuery = null;

    for (const tag of category.tags) {
      const res = await searchOneTag({ lat, lon, radiusMeters, categoryKey, limit, tags: [tag] });
      lastQuery = res.query;
      if (!res.ok) { reasons.push(`${tag.join("=")}: ${res.reason}`); continue; }
      anyOk = true;
      usedEndpoint = res.endpoint;
      for (const el of res.rawElements || []) {
        // A clinic tagged both amenity=clinic and healthcare=doctor comes back
        // from two of these requests and must not become two companies.
        const id = `${el.type}/${el.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(el);
      }
    }

    if (!anyOk) return { ok: false, elements: [], query: lastQuery, endpoint: null, reason: reasons.join(" · ").slice(0, 300) };

    const elements = merged.slice(0, limit).map(normalizeElement).filter(Boolean);
    logger.info({ categoryKey, found: elements.length, tags: category.tags.length, failed: reasons.length }, "overpass search complete (per-tag)");
    return { ok: true, elements, query: lastQuery, endpoint: usedEndpoint, reason: reasons.length ? reasons.join(" · ").slice(0, 300) : null };
  }

  const single = await searchOneTag({ lat, lon, radiusMeters, categoryKey, limit, tags: category.tags });
  return single.ok
    ? { ok: true, elements: (single.rawElements || []).map(normalizeElement).filter(Boolean), query: single.query, endpoint: single.endpoint, reason: null, raw: single.raw }
    : single;
};

/** One tag's worth of search, with the radius/mirror ladder around it. */
const searchOneTag = async ({ lat, lon, radiusMeters = 10_000, categoryKey, limit = 200, tags = null }) => {
  // Attempts get progressively cheaper. A saturated Overpass instance will
  // often answer a smaller query when it refused a larger one, so narrowing
  // the radius is a better response to a timeout than simply giving up.
  // Narrow the area on retry, but never the time budget. The ladder used to cut
  // both at once, which fights the failure it is retrying: Overpass answers a
  // timeout with `runtime error: Query timed out in "query" after N seconds`,
  // and the response to that is to allow more seconds, not fewer. A category
  // expands to one statement per tag per element type, so a three-tag category
  // over a 12km circle is six polygon scans and routinely needs more than the
  // 50s it was being given.
  const attempts = [
    { radiusMeters, limit, timeoutSec: 90 },
    { radiusMeters: Math.round(radiusMeters * 0.5), limit: Math.min(limit, 80), timeoutSec: 90 },
    { radiusMeters: Math.round(radiusMeters * 0.3), limit: Math.min(limit, 60), timeoutSec: 60 },
  ];
  let lastReason = null;
  let lastQuery = null;

  for (const attempt of attempts) {
    const query = buildQuery({ lat, lon, categoryKey, tags, ...attempt });
    lastQuery = query;

    for (const endpoint of MIRRORS) {
      const host = new URL(endpoint).host;
      try {
        const res = await withHostSlot(host, () =>
          safeFetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `data=${encodeURIComponent(query)}`,
            accept: "application/json",
            // A little above the server-side [timeout:N] so we see its own
            // error rather than aborting first, but low enough to fail over.
            timeoutMs: (attempt.timeoutSec + 15) * 1000,
            maxBytes: 24 * 1024 * 1024,
          }),
        );

        if (res.status === 429 || res.status === 504 || res.status >= 500) {
          lastReason = `HTTP_${res.status}`;
          logger.warn({ endpoint, status: res.status }, "Overpass busy — trying next mirror");
          continue;
        }
        if (res.status >= 400) {
          lastReason = `HTTP_${res.status}`;
          continue;
        }

        const json = JSON.parse(res.body);

        // Overpass reports overload, rate-limiting and query timeouts inside a
        // 200 response via `remark`, with an empty element list. Treating that
        // as "no businesses here" would silently produce empty discovery runs,
        // so it is failed over like any other error.
        if (json.remark && /error|timed? out|exceeded|too many|rate.?limit/i.test(json.remark)) {
          lastReason = `OVERPASS_REMARK: ${String(json.remark).slice(0, 120)}`;
          logger.warn({ endpoint, remark: json.remark }, "Overpass returned an error remark — trying next mirror");
          continue;
        }

        // Raw elements, so the caller can merge several tags and de-duplicate
        // by OSM id before anything is normalised into a company.
        const rawElements = json.elements || [];
        logger.debug(
          { categoryKey, tag: (tags || [])[0]?.join("="), found: rawElements.length, endpoint, radiusMeters: attempt.radiusMeters },
          "overpass tag search complete",
        );
        return { ok: true, rawElements, query, endpoint, reason: null, raw: json };
      } catch (err) {
        lastReason = err instanceof FetchBlockedError ? err.reason : "NETWORK_ERROR";
        logger.warn({ endpoint, reason: lastReason, msg: err.message }, "Overpass request failed");
      }
    }
    logger.warn({ categoryKey, radiusMeters: attempt.radiusMeters }, "all mirrors failed — retrying with a narrower search");
  }

  return { ok: false, elements: [], query: lastQuery, endpoint: null, reason: lastReason || "ALL_MIRRORS_FAILED" };
};

export const OVERPASS_ATTRIBUTION =
  "© OpenStreetMap contributors, available under the Open Database Licence (ODbL).";
