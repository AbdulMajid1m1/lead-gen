import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { normaliseIcp } from "./icp.js";

/**
 * How well one company matches an approved ICP.
 *
 * A promote run sources against the ICP but used to score against the agency
 * signal catalogue, so its leads came out ranked by the state of their
 * *websites*: a Dubai school was an 93-point lead because it ran an old jQuery
 * and had no schema.org markup, neither of which has anything to do with
 * whether it needs an HR platform. Worse, the ranking was close to inverted —
 * the well-run 80-staff company that is the ideal buyer has a tidy modern site
 * and therefore scored near zero.
 *
 * This module supplies the other half: the fit points and the hard gate that
 * scoreCompany() applies when, and only when, it is scoring for a product.
 * Nothing here consults an LLM; it reads the human-approved profile.
 */

/** Deliberately generous — fit is a thesis, not a proof, so it is capped low. */
export const FIT_CAP = 25;

const flatten = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(\w{4,})s\b/g, "$1")
    .trim();

/**
 * The size bands the ICP's headcount range covers.
 *
 * `sizeBucket` is the only headcount the database actually holds, and it is
 * UNKNOWN on most companies — so this maps the ICP's min/max onto buckets and
 * treats UNKNOWN as "no evidence" rather than as a miss. Penalising UNKNOWN
 * would zero out almost every lead on a signal we never collected.
 */
const BUCKET_RANGES = {
  MICRO: [1, 9],
  SMALL: [10, 49],
  MEDIUM: [50, 249],
  LARGE: [250, Infinity],
};

export const bucketsForRange = ({ min, max }) => {
  const lo = Number.isFinite(min) && min > 0 ? min : 1;
  const hi = Number.isFinite(max) && max > 0 ? max : Infinity;
  // Strictly below the ceiling, not "touching" it: an ICP capped at 250 staff
  // must not accept the LARGE bucket, which starts at exactly 250 and reaches
  // to twenty thousand. The boundary case that matters here is a school group
  // whose headcount band overlaps the profile's ceiling by one employee.
  return Object.entries(BUCKET_RANGES)
    .filter(([, [bLo, bHi]]) => bLo < hi && bHi >= lo)
    .map(([bucket]) => bucket);
};

/**
 * Which OSM categories the ICP's free-text industries name.
 *
 * Same mapping icpToParsedQuery() uses to aim the map search, repeated here so
 * a company found by one discovery source is judged by the same vocabulary as
 * one found by another.
 */
const CATEGORY_TERMS = Object.entries(OSM_CATEGORIES).map(([key, { label }]) => ({
  key,
  terms: [...new Set([flatten(key), flatten(label)])].filter(Boolean),
}));

const icpCategoryKeys = (industries) => {
  const keys = new Set();
  for (const industry of industries) {
    const text = ` ${flatten(industry)} `;
    if (text.trim().length < 2) continue;
    for (const { key, terms } of CATEGORY_TERMS) {
      if (terms.some((term) => text.includes(` ${term} `))) keys.add(key);
    }
  }
  return keys;
};

/** Does the company sit in a market the ICP ranked? */
const geographyMatch = (company, geographies) => {
  if (!geographies.length) return null;
  const city = flatten(company.city);
  const code = (company.countryCode || "").toUpperCase();
  // A named city is the stronger match: the ICP ranks Dubai above Riyadh for a
  // reason, and "somewhere in the UAE" is not the same claim.
  const byCity = geographies.find((g) => city && flatten(g.region) && city.includes(flatten(g.region)));
  if (byCity) return { geography: byCity, exact: true };
  const byCountry = geographies.find((g) => g.countryCode && g.countryCode === code);
  return byCountry ? { geography: byCountry, exact: false } : null;
};

/** Does the company's industry appear in the ICP? */
const industryMatch = (company, industries) => {
  const keys = icpCategoryKeys(industries);
  if (!keys.size) return false;
  // The company's own tag first — it is the value the map search matched on.
  const tag = String(company.osmCategory || "");
  for (const key of keys) {
    const tags = (OSM_CATEGORIES[key]?.tags || []).map(([k, v]) => `${k}=${v}`);
    if (tags.includes(tag) || tag === key) return true;
  }
  // Then the human label, for companies that arrived without an OSM tag.
  const label = ` ${flatten(company.industry)} `;
  if (label.trim().length < 2) return false;
  return [...keys].some((key) => {
    const terms = [flatten(key), flatten(OSM_CATEGORIES[key]?.label)].filter(Boolean);
    return terms.some((term) => label.includes(` ${term} `));
  });
};

/**
 * Signals that describe the state of a website rather than the state of a
 * business. Re-exported from the catalogue by the caller; listed here as the
 * set a *product* sale must ignore, which is the same set for the same reason:
 * "the footer says 2024" is a fact about a web page, not about payroll.
 */

/**
 * Score a company against an approved ICP.
 *
 * Returns the fit points, the reasons behind them (rendered in the score
 * breakdown, so a user can see why a lead was judged a match), and whether the
 * profile rules the company out entirely.
 */
export const icpFit = (company, icp) => {
  const safe = normaliseIcp(icp);
  const reasons = [];
  let points = 0;

  const geo = geographyMatch(company, safe.geographies);
  if (geo) {
    // A priority-1 market is worth more than a priority-3 one: the ICP author
    // ranked them, and a ranking nothing reads is not a ranking.
    const rank = geo.geography.priority ?? 99;
    const geoPoints = geo.exact ? Math.max(6, 12 - rank * 2) : 4;
    points += geoPoints;
    reasons.push({
      key: "GEOGRAPHY",
      points: geoPoints,
      text: geo.exact
        ? `${company.city} is a market the profile ranked #${rank}.`
        : `The company is in ${geo.geography.countryCode}, a country the profile targets.`,
    });
  }

  if (industryMatch(company, safe.industries)) {
    points += 8;
    reasons.push({ key: "INDUSTRY", points: 8, text: `${company.industry || "Its industry"} is named in the profile.` });
  }

  const wanted = bucketsForRange(safe.companySize);
  if (company.sizeBucket && company.sizeBucket !== "UNKNOWN") {
    if (wanted.includes(company.sizeBucket)) {
      points += 5;
      reasons.push({ key: "SIZE", points: 5, text: `Its headcount band (${company.sizeBucket}) is inside the profile's range.` });
    } else {
      // A confirmed miss is worth stating and worth costing, unlike an unknown.
      // The 250-staff ceiling on this product's self-serve tiers is a real
      // boundary: above it the sale is a different, longer conversation.
      points -= 8;
      reasons.push({ key: "SIZE", points: -8, text: `Its headcount band (${company.sizeBucket}) is outside the profile's range.` });
    }
  }

  return {
    points: Math.max(0, Math.min(FIT_CAP, points)),
    reasons,
    // Whether anything at all corroborated that this company belongs in the
    // profile. A company matching on neither market nor industry is in the run
    // because some discovery source returned it, not because the ICP asked for
    // it — and on a product run that is the definition of noise.
    matched: reasons.some((r) => r.points > 0),
  };
};
