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
 * `nwr` covers nodes, ways and relations in one statement; `out center tags`
 * returns a single coordinate per element instead of full geometry.
 */
export const buildQuery = ({ lat, lon, radiusMeters = 10_000, categoryKey, limit = 200, requireName = true, timeoutSec = 60 }) => {
  const category = OSM_CATEGORIES[categoryKey];
  if (!category) throw new Error(`Unknown OSM category: ${categoryKey}`);

  const nameFilter = requireName ? '["name"]' : "";
  const area = `around:${Math.round(radiusMeters)},${lat},${lon}`;
  const statements = category.tags
    .map(([k, v]) => `  nwr["${k}"="${v}"]${nameFilter}(${area});`)
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
  // Attempts get progressively cheaper. A saturated Overpass instance will
  // often answer a smaller query when it refused a larger one, so narrowing
  // the radius is a better response to a timeout than simply giving up.
  const attempts = [
    { radiusMeters, limit, timeoutSec: 50 },
    { radiusMeters: Math.round(radiusMeters * 0.6), limit: Math.min(limit, 80), timeoutSec: 35 },
  ];
  let lastReason = null;
  let lastQuery = null;

  for (const attempt of attempts) {
    const query = buildQuery({ lat, lon, categoryKey, ...attempt });
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

        const elements = (json.elements || []).map(normalizeElement).filter(Boolean);
        logger.info(
          { categoryKey, found: elements.length, endpoint, radiusMeters: attempt.radiusMeters },
          "overpass search complete",
        );
        return { ok: true, elements, query, endpoint, reason: null, raw: json };
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
