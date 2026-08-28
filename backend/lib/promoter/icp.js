import { parseStructured, isResearchAvailable } from "../llm/responses.js";
import { PRODUCT_ICP_SYSTEM, buildProductIcpUser, PRODUCT_ICP_SCHEMA } from "../research/prompts.js";
import { expandLocation } from "../research/brief.js";
import { SIGNAL_CATALOG } from "../signals/signalCatalog.js";
import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { HIRING_ROLE_TERMS } from "../nlquery/lexicon.js";
import { normalizeJobTitle } from "../../utils/normalize.js";
import { AI_FAST_MODEL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("promoter");

/**
 * The ideal customer profile: who should be contacted about this product.
 *
 * The model drafts it, a human edits and approves it, and from then on it is
 * the authority for every search and every email. That makes the edited JSON
 * untrusted input on its way back in — it is written by hand, stored as Json,
 * and later interpolated into prompt text — so normaliseIcp() runs on both the
 * draft and the human version and is the only shape the rest of the code sees.
 */

const MAX_ITEMS = 8;
const MAX_QUERIES = 5;
const MAX_TITLE_TERMS = 6;

const DETECTABLE_VIA = new Set([
  "JOB_POSTING", "TECH_STACK", "COMPANY_AGE", "WEBSITE_CONTENT",
  "DIRECTORY_LISTING", "SIGNAL_CATALOG", "OTHER",
]);

const SOURCE_TYPES = new Set([
  "DIRECTORY", "NEWS", "REVIEW_SITE", "VENDOR_PAGE", "SOCIAL",
  "MAPS_LISTING", "COMPANY_SITE", "JOB_BOARD", "OTHER",
]);

const str = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed || null;
};

const strList = (value, max, limit = MAX_ITEMS) =>
  (Array.isArray(value) ? value : []).map((v) => str(v, max)).filter(Boolean).slice(0, limit);

const objList = (value) => (Array.isArray(value) ? value : []).filter((v) => v && typeof v === "object" && !Array.isArray(v));

/** Headcounts are counts: zero, fractions and negatives are all malformed. */
const positiveInt = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const countryCode = (value) => {
  const code = str(value, 8);
  return code && /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : null;
};

/**
 * The defensive shape every consumer of an ICP relies on.
 *
 * Never throws. A human editing this JSON in a textarea will at some point send
 * a string where an array belongs or a max below the min, and the failure that
 * must not happen is a saved product that crashes discovery days later — so
 * every field is coerced to something usable rather than rejected.
 */
export const normaliseIcp = (icp) => {
  const src = icp && typeof icp === "object" && !Array.isArray(icp) ? icp : {};

  let min = positiveInt(src.companySize?.min);
  let max = positiveInt(src.companySize?.max);
  // "10-2 employees" is a typo, not an empty range; swapping keeps the intent.
  if (min && max && min > max) [min, max] = [max, min];

  return {
    summary: str(src.summary, 500),
    industries: strList(src.industries, 80),
    companySize: { min, max, note: str(src.companySize?.note, 300) },
    geographies: objList(src.geographies)
      .map((g) => ({
        region: str(g.region, 120),
        countryCode: countryCode(g.countryCode),
        reason: str(g.reason, 300),
        priority: positiveInt(g.priority) ?? 99,
      }))
      .filter((g) => g.region)
      .slice(0, MAX_ITEMS),
    buyerTitles: {
      decisionMakers: strList(src.buyerTitles?.decisionMakers, 80),
      champions: strList(src.buyerTitles?.champions, 80),
    },
    painPoints: objList(src.painPoints)
      .map((p) => ({ pain: str(p.pain, 300), productAnswer: str(p.productAnswer, 300) }))
      .filter((p) => p.pain)
      .slice(0, MAX_ITEMS),
    buyingSignals: objList(src.buyingSignals)
      .map((s) => ({
        signal: str(s.signal, 300),
        detectableVia: DETECTABLE_VIA.has(s.detectableVia) ? s.detectableVia : "OTHER",
        signalKey: str(s.signalKey, 60)?.toUpperCase() || null,
      }))
      // A signal with no text describes nothing a researcher could look for.
      .filter((s) => s.signal)
      .slice(0, MAX_ITEMS),
    disqualifiers: strList(src.disqualifiers, 200),
    competitorsToDisplace: strList(src.competitorsToDisplace, 120),
    suggestedSearchQueries: objList(src.suggestedSearchQueries)
      .map((q) => ({
        label: str(q.label, 120),
        searchInstruction: str(q.searchInstruction, 600),
        expectedSourceTypes: (Array.isArray(q.expectedSourceTypes) ? q.expectedSourceTypes : [])
          .filter((t) => SOURCE_TYPES.has(t))
          .slice(0, SOURCE_TYPES.size),
      }))
      // The instruction is the whole payload; a label alone gives discovery
      // nothing to search for.
      .filter((q) => q.searchInstruction)
      .slice(0, MAX_QUERIES),
  };
};

/** An ICP with no search instruction cannot source a single lead. */
export const icpIsUsable = (icp) => normaliseIcp(icp).suggestedSearchQueries.length > 0;

/**
 * Drafts the ICP from the researched product.
 *
 * Failure here is not fatal to the product: it lands in ICP_REVIEW with nothing
 * drafted and a human writes the profile by hand, which is the same gate the
 * successful path passes through anyway.
 */
export const draftIcp = async ({ product, tracker = null }) => {
  if (!isResearchAvailable()) {
    return {
      ok: false,
      reason: "AI is unavailable — write the ideal customer profile by hand before approving it.",
      icp: null,
      model: null,
    };
  }

  const result = await parseStructured({
    system: PRODUCT_ICP_SYSTEM,
    user: buildProductIcpUser({ product }),
    schema: PRODUCT_ICP_SCHEMA,
    schemaName: "product_icp",
    model: AI_FAST_MODEL,
    timeoutMs: 60_000,
    tracker,
  });

  if (!result?.data?.suggestedSearchQueries?.length) {
    logger.warn({ product: product?.name }, "no usable ICP drafted — a human has to write one");
    return {
      ok: false,
      reason: "No usable ideal customer profile could be drafted from this product — write one by hand before approving it.",
      icp: null,
      model: result?.model || null,
    };
  }

  return { ok: true, reason: null, icp: normaliseIcp(result.data), model: result.model || null };
};

/** The strategy shape the discovery pipeline already reads. */
export const icpToSearchStrategies = (icp) =>
  normaliseIcp(icp).suggestedSearchQueries.map((q) => ({
    label: q.label || q.searchInstruction.slice(0, 80),
    searchInstruction: q.searchInstruction,
    expectedSourceTypes: q.expectedSourceTypes.length ? q.expectedSourceTypes : ["COMPANY_SITE"],
  }));

/**
 * Free-text industries onto the closed category vocabulary.
 *
 * The ICP names industries the way a person would ("dental clinics", "hotels
 * and resorts"); OSM_CATEGORIES is the only vocabulary the map search and
 * buildWhere() understand. Anything that does not map is dropped rather than
 * approximated — an invented key silently matches nothing, which reads as a
 * search that found no companies rather than as a bug.
 */
const flatten = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(\w{4,})s\b/g, "$1")
    .trim();

const CATEGORY_TERMS = Object.entries(OSM_CATEGORIES).map(([key, { label }]) => ({
  key,
  terms: [...new Set([flatten(key), flatten(label)])].filter(Boolean),
}));

const mapIndustries = (industries) => {
  const keys = [];
  for (const industry of industries) {
    const text = ` ${flatten(industry)} `;
    if (text.trim().length < 2) continue;
    for (const { key, terms } of CATEGORY_TERMS) {
      if (keys.includes(key)) continue;
      if (terms.some((term) => text.includes(` ${term} `))) keys.push(key);
    }
  }
  return keys.slice(0, MAX_ITEMS);
};

/**
 * Job-title needles for the hiring filter.
 *
 * buildWhere() does a `contains` against normalizedTitle, so the needle has to
 * be the distinctive fragment rather than the full title: "HR Manager" as a
 * whole misses "HR & Admin Manager", while "hr " matches both. The hiring
 * lexicon already holds needles tuned for exactly that match, so a signal or a
 * buyer title that it recognises contributes its needles; anything it does not
 * recognise falls back to the words in the title that carry the domain.
 */
const GENERIC_TITLE_WORDS = new Set([
  "head", "chief", "officer", "vp", "vice", "president", "director", "manager",
  "lead", "senior", "junior", "principal", "executive", "assistant", "associate",
  "specialist", "coordinator", "generalist", "global", "regional", "country",
  "of", "and", "the", "for", "at", "in", "co", "founder", "owner", "partner",
  "team", "staff", "department", "business", "corporate", "general",
]);

/** Every needle the lexicon knows, for scanning prose that names a role in passing. */
const ALL_TITLE_NEEDLES = [...new Set(HIRING_ROLE_TERMS.flatMap((r) => r.titleContains))];

const deriveJobTitleContains = (icp) => {
  const needles = [];
  // Kept verbatim, never trimmed: the lexicon's needles carry a trailing space
  // on purpose ("hr " rather than "hr", so "chrome engineer" does not match),
  // and trimming that away turns a precise filter into a noisy one.
  const add = (needle) => {
    const value = String(needle || "");
    if (value.trim() && !needles.includes(value)) needles.push(value);
  };

  const lexiconEntryFor = (text) =>
    HIRING_ROLE_TERMS.find((role) => role.phrases.some((p) => text.includes(` ${p} `) || text.includes(`${p} `)));

  // A buying signal is a sentence describing an event — "Advertising a first or
  // additional HR, payroll or admin role". Splitting prose into words the way a
  // job title can be split yields needles like "advertising", "first" and
  // "role", and because buildWhere does a `contains` against the title, an
  // "advertising" needle then matches every Advertising Manager vacancy in the
  // market. So a sentence only ever contributes needles the lexicon recognises
  // inside it; one that names no known role contributes nothing at all.
  for (const signal of icp.buyingSignals.filter((s) => s.detectableVia === "JOB_POSTING")) {
    const text = ` ${normalizeJobTitle(signal.signal)} `;
    if (text.trim().length < 2) continue;

    const entry = lexiconEntryFor(text);
    if (entry) {
      entry.titleContains.forEach(add);
      continue;
    }
    ALL_TITLE_NEEDLES.filter((n) => text.includes(n.trim())).forEach(add);
  }

  // A buyer title genuinely is a title, so the word-level fallback is sound
  // here: the words left after the generic ones are the role itself.
  for (const title of [...icp.buyerTitles.decisionMakers, ...icp.buyerTitles.champions]) {
    const text = ` ${normalizeJobTitle(title)} `;
    if (text.trim().length < 2) continue;

    const entry = lexiconEntryFor(text);
    if (entry) {
      entry.titleContains.forEach(add);
      continue;
    }
    for (const word of text.trim().split(" ")) {
      if (word.length >= 3 && !GENERIC_TITLE_WORDS.has(word)) add(word);
    }
  }

  return needles.slice(0, MAX_TITLE_TERMS);
};

/** The market to search, from the geography the ICP ranked first. */
const deriveLocation = (geographies) => {
  const best = [...geographies].sort((a, b) => a.priority - b.priority)[0];
  if (!best) return null;
  return expandLocation({ name: best.region, countryCode: best.countryCode, cities: [], raw: best.region.toLowerCase() });
};

const SIGNAL_KEYS = new Set(Object.keys(SIGNAL_CATALOG));

/**
 * The approved ICP as the `parsed` object startDiscoveryRun() expects.
 *
 * Same shape parseQuery() produces, because every step downstream reads
 * parsed.query and must not care whether a run came from a typed sentence or an
 * approved profile. Confidence is 1: a human read this and pressed approve,
 * which is a stronger warrant than any parse.
 */
export const icpToParsedQuery = (icp) => {
  const safe = normaliseIcp(icp);
  const industries = mapIndustries(safe.industries);
  const location = deriveLocation(safe.geographies);
  const jobTitleContains = deriveJobTitleContains(safe);
  // The schema already constrains signalKey to the catalog, but a hand-edited
  // ICP does not go through the schema — an unknown type here would filter
  // every company out and report an empty run rather than a rejected value.
  const signals = [...new Set(safe.buyingSignals.map((s) => s.signalKey).filter((k) => k && SIGNAL_KEYS.has(k)))];

  const chips = [
    ...industries.map((key) => ({ kind: "INDUSTRY", label: OSM_CATEGORIES[key].label, value: key })),
    ...(location ? [{ kind: "LOCATION", label: location.name, value: location.raw || location.name }] : []),
    ...signals.map((s) => ({ kind: "SIGNAL", label: SIGNAL_CATALOG[s].label, value: [s] })),
    ...(jobTitleContains.length ? [{ kind: "HIRING", label: `hiring ${jobTitleContains.slice(0, 3).join(", ")}`, value: jobTitleContains }] : []),
  ];

  return {
    query: {
      industries,
      location: location ? { ...location, name: location.name, raw: location.raw || location.name } : null,
      signals,
      technologies: [],
      excludeTechnologies: [],
      service: "SAAS_PRODUCT",
      jobTitleContains,
      postedWithinDays: null,
      sizeBucket: null,
      minScore: null,
      freeText: [],
    },
    chips,
    confidence: 1,
    unparsed: [],
  };
};
