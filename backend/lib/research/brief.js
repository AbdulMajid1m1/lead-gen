import prisma from "../../prismaClient.js";
import { parseStructured, isResearchAvailable } from "../llm/responses.js";
import { BRIEF_SYSTEM, buildBriefUser, BRIEF_SCHEMA, PROMPT_VERSION } from "./prompts.js";
import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { AI_FAST_MODEL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("research:brief");

/**
 * Region knowledge for the deterministic path. A country (or region) is too
 * coarse for a map search — Overpass works on a radius around a point, and the
 * centroid of Saudi Arabia is empty desert. Expanding to major cities is what
 * turns "in Saudi Arabia" into map searches that actually return businesses.
 */
const REGION_HINTS = [
  { match: /\b(?:saudi arabia|saudi|ksa)\b/i, countryCode: "SA", cities: ["Riyadh", "Jeddah", "Dammam"] },
  { match: /\b(?:united arab emirates|uae|emirates)\b/i, countryCode: "AE", cities: ["Dubai", "Abu Dhabi", "Sharjah"] },
  { match: /\bqatar\b/i, countryCode: "QA", cities: ["Doha"] },
  { match: /\bkuwait\b/i, countryCode: "KW", cities: ["Kuwait City"] },
  { match: /\bbahrain\b/i, countryCode: "BH", cities: ["Manama"] },
  { match: /\boman\b/i, countryCode: "OM", cities: ["Muscat"] },
  { match: /\b(?:gulf|gcc)\b/i, countryCode: null, cities: ["Riyadh", "Dubai", "Doha"] },
  { match: /\b(?:united kingdom|uk|britain|england)\b/i, countryCode: "GB", cities: ["London", "Manchester", "Birmingham"] },
  { match: /\bgermany\b/i, countryCode: "DE", cities: ["Berlin", "Munich"] },
  { match: /\bfrance\b/i, countryCode: "FR", cities: ["Paris", "Lyon"] },
  { match: /\bspain\b/i, countryCode: "ES", cities: ["Madrid", "Barcelona"] },
  { match: /\bportugal\b/i, countryCode: "PT", cities: ["Lisbon", "Porto"] },
  { match: /\bnetherlands\b/i, countryCode: "NL", cities: ["Amsterdam", "Rotterdam"] },
  { match: /\bitaly\b/i, countryCode: "IT", cities: ["Milan", "Rome"] },
  { match: /\beurope\b/i, countryCode: null, cities: ["London", "Berlin", "Amsterdam"] },
  { match: /\bpakistan\b/i, countryCode: "PK", cities: ["Karachi", "Lahore", "Islamabad"] },
  { match: /\bindia\b/i, countryCode: "IN", cities: ["Mumbai", "Bangalore"] },
  { match: /\b(?:united states|usa|america)\b/i, countryCode: "US", cities: ["New York", "Los Angeles"] },
  // US states are named as often as countries in this product's queries, and a
  // state is exactly the case REGION_HINTS exists for: too coarse to search as
  // one point, but carrying a country the company would otherwise never get.
  { match: /\bflorida\b/i, countryCode: "US", cities: ["Miami", "Orlando"] },
  { match: /\btexas\b/i, countryCode: "US", cities: ["Houston", "Dallas"] },
];

/**
 * City → country, for the markets this product actually sells into.
 *
 * REGION_HINTS only recognises country and region names, so a city-level query
 * ("dental clinics in Abu Dhabi") produced a location with no countryCode at
 * all. That is not cosmetic: a company created from that run inherits no
 * country, and sendPolicyFor() reads a missing country as an unknown market and
 * answers RESTRICTED — so the leads a city query finds were withheld from
 * outreach even where cold email is plainly lawful. Written out by hand, like
 * REGION_HINTS, so a wrong answer is visible and correctable.
 */
const CITY_HINTS = [
  [/\b(?:dubai|abu dhabi|sharjah|ajman|fujairah|ras al khaimah)\b/i, "AE"],
  [/\b(?:riyadh|jeddah|dammam|khobar|mecca|makkah|medina|madinah)\b/i, "SA"],
  [/\bdoha\b/i, "QA"],
  [/\bkuwait city\b/i, "KW"],
  [/\b(?:manama|seef|juffair)\b/i, "BH"],
  [/\b(?:muscat|salalah)\b/i, "OM"],
  [/\b(?:london|manchester|birmingham|leeds|glasgow|liverpool|bristol|edinburgh|sheffield|nottingham|leicester|cardiff|newcastle|belfast)\b/i, "GB"],
  [/\b(?:paris|lyon|marseille|nice|toulouse|bordeaux|lille)\b/i, "FR"],
  [/\b(?:dublin|cork|galway)\b/i, "IE"],
  [/\b(?:brussels|antwerp|ghent)\b/i, "BE"],
  [/\b(?:lisbon|lisboa|porto)\b/i, "PT"],
  [/\b(?:new york|los angeles|chicago|austin|miami|houston|boston|seattle|denver|atlanta)\b/i, "US"],
  // Florida and Texas metros, so a city-level query in either state resolves a
  // country the same way "Dubai" does.
  [/\b(?:orlando|tampa|jacksonville|fort lauderdale|west palm beach|st petersburg|sarasota|naples|boca raton)\b/i, "US"],
  [/\b(?:dallas|san antonio|fort worth|el paso|arlington|plano|corpus christi|lubbock|mckinney|sugar land)\b/i, "US"],
];

/** Fill countryCode + cities for a country/region-level location. */
export const expandLocation = (location) => {
  if (!location?.name) return location;

  // A city name carries its country even though it expands to no city list —
  // the place is already specific enough to search.
  if (!location.countryCode) {
    const city = CITY_HINTS.find(([re]) => re.test(location.name));
    if (city) location = { ...location, countryCode: city[1] };
  }

  if (location.cities?.length) return location;
  const hint = REGION_HINTS.find((h) => h.match.test(location.name));
  if (!hint) return location;
  return { ...location, countryCode: location.countryCode || hint.countryCode, cities: hint.cities };
};

/**
 * Turns the user's sentence into a research brief.
 *
 * The brief is the fan-out point: it produces both the closed-vocabulary
 * parameters our deterministic engine understands *and* the diversified search
 * instructions the AI engine needs. When the model is unavailable it falls back
 * to a brief derived purely from the deterministic parse, so the run still
 * happens — just without the expansion.
 */
export const buildBrief = async ({ rawQuery, parsed, tracker = null }) => {
  const fallback = deterministicBrief({ rawQuery, parsed });
  if (!isResearchAvailable()) return { brief: fallback, producedBy: "DETERMINISTIC", model: null };

  const result = await parseStructured({
    system: BRIEF_SYSTEM,
    user: buildBriefUser({ rawQuery, deterministicParse: parsed.query }),
    schema: BRIEF_SCHEMA,
    schemaName: "research_brief",
    model: AI_FAST_MODEL,
    timeoutMs: 40_000,
    tracker,
  });

  if (!result?.data?.searchStrategies?.length) {
    logger.warn("brief unavailable — using the deterministic plan");
    return { brief: fallback, producedBy: "DETERMINISTIC", model: null };
  }

  // The deterministic parse stays authoritative for the closed vocabulary it
  // recognised; the model owns the location *shape* — its cleaned place name,
  // countryCode and city expansion beat the parser's raw token run.
  const merged = {
    ...result.data,
    industries: parsed.query.industries?.length ? parsed.query.industries : result.data.industries,
    signals: [...new Set([...(parsed.query.signals || []), ...(result.data.signals || [])])],
    service: parsed.query.service || result.data.service || null,
    location: expandLocation(result.data.location || parsed.query.location || null),
    keywords: parsed.query.freeText?.length ? parsed.query.freeText : result.data.keywords || [],
  };

  return { brief: merged, producedBy: "LLM", model: result.model };
};

/** A usable brief built from the deterministic parse alone. */
const deterministicBrief = ({ rawQuery, parsed }) => {
  const q = parsed.query;
  const industryLabels = (q.industries || []).map((k) => OSM_CATEGORIES[k]?.label || k);
  const location = expandLocation(q.location ? { name: q.location.name, countryCode: null, cities: [] } : null);
  const where = location?.name ? ` in ${location.name}` : "";
  const keywords = q.freeText || [];
  const about = keywords.length ? ` related to ${keywords.join(" ")}` : "";
  const subject = `${industryLabels.join(" or ") || "businesses"}${about}${where}`;

  return {
    restatedGoal: `Find ${industryLabels.join(" and ") || "businesses"}${about}${where} matching: ${rawQuery}`,
    industries: q.industries || [],
    location,
    service: q.service || null,
    signals: q.signals || [],
    keywords,
    icpTraits: [],
    searchStrategies: [
      {
        label: "Directory and map listings",
        searchInstruction: `Find ${subject} listed in business directories or map listings, noting their website and contact details.`,
        expectedSourceTypes: ["DIRECTORY", "MAPS_LISTING"],
      },
      {
        label: "Company websites",
        searchInstruction: `Find the official websites of ${subject} and note contact details published on them.`,
        expectedSourceTypes: ["COMPANY_SITE"],
      },
    ],
    exclusions: [],
    fallback: true,
  };
};

export const saveBrief = async ({ runId, searchQueryId, brief, producedBy, model }) =>
  prisma.researchBrief.upsert({
    where: { runId },
    update: { brief, producedBy, model, promptVersion: PROMPT_VERSION },
    create: { runId, searchQueryId, brief, producedBy, model, promptVersion: PROMPT_VERSION },
  });
