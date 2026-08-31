import { describe, it, expect } from "vitest";
import { icpFit, bucketsForRange, FIT_CAP } from "../../lib/promoter/fit.js";

/**
 * Scoring a promote run against its own profile.
 *
 * Every case below comes from the first live TracefyHR run, which sourced
 * against an approved ICP and then scored against the agency signal catalogue.
 * All twenty of its leads came out `WEBSITE_DEV`, ranked by jQuery versions and
 * page-load times, and the top one was a school group two orders of magnitude
 * above the profile's 250-staff ceiling. These assert the half that was
 * missing: whether the company is the one the profile asked for.
 */

const TRACEFY_ICP = {
  summary: "Gulf SMBs running payroll on spreadsheets",
  industries: ["Schools and academies", "Medical clinics", "Construction companies"],
  companySize: { min: 10, max: 250, note: "self-serve tiers cap at 250" },
  geographies: [
    { region: "Dubai", countryCode: "AE", priority: 1, reason: "densest SMB market" },
    { region: "Riyadh", countryCode: "SA", priority: 2, reason: "Saudi labour law" },
  ],
  suggestedSearchQueries: [{ label: "x", searchInstruction: "find them", expectedSourceTypes: ["COMPANY_SITE"] }],
};

const company = (over = {}) => ({
  name: "Acme",
  industry: null,
  osmCategory: null,
  city: null,
  countryCode: null,
  sizeBucket: "UNKNOWN",
  ...over,
});

describe("icpFit — does this company match the approved profile", () => {
  it("scores a company in the profile's first-ranked market above one in its second", () => {
    const dubai = icpFit(company({ city: "Dubai", countryCode: "AE" }), TRACEFY_ICP);
    const riyadh = icpFit(company({ city: "Riyadh", countryCode: "SA" }), TRACEFY_ICP);
    expect(dubai.points).toBeGreaterThan(riyadh.points);
    expect(dubai.matched).toBe(true);
  });

  it("scores a country-only match below a named-city match", () => {
    const city = icpFit(company({ city: "Dubai", countryCode: "AE" }), TRACEFY_ICP);
    const country = icpFit(company({ city: "Sharjah", countryCode: "AE" }), TRACEFY_ICP);
    expect(country.points).toBeGreaterThan(0);
    expect(country.points).toBeLessThan(city.points);
  });

  it("recognises an industry the profile names, by OSM tag", () => {
    const fit = icpFit(company({ osmCategory: "amenity=school", industry: "School / academy" }), TRACEFY_ICP);
    expect(fit.reasons.some((r) => r.key === "INDUSTRY")).toBe(true);
  });

  it("recognises an industry from its human label when no OSM tag was recorded", () => {
    const fit = icpFit(company({ industry: "School / academy" }), TRACEFY_ICP);
    expect(fit.reasons.some((r) => r.key === "INDUSTRY")).toBe(true);
  });

  it("does not match an industry the profile never named", () => {
    const fit = icpFit(company({ osmCategory: "amenity=restaurant", industry: "Restaurant" }), TRACEFY_ICP);
    expect(fit.reasons.some((r) => r.key === "INDUSTRY")).toBe(false);
  });

  it("reports no match for a company outside both the market and the industry", () => {
    // The failure this guards: a discovery source returns a Lisbon hair salon,
    // nothing in the profile recognises it, and it becomes a lead anyway.
    const fit = icpFit(company({ city: "Lisbon", countryCode: "PT", industry: "Hair salon" }), TRACEFY_ICP);
    expect(fit.matched).toBe(false);
    expect(fit.points).toBe(0);
  });

  it("penalises a confirmed headcount above the profile's ceiling", () => {
    // GEMS-group schools ranked top of the live run at 78–93 points. The
    // profile caps at 250 staff; above that the sale is a different one.
    const enterprise = icpFit(company({ city: "Dubai", countryCode: "AE", sizeBucket: "LARGE" }), TRACEFY_ICP);
    const rightSized = icpFit(company({ city: "Dubai", countryCode: "AE", sizeBucket: "MEDIUM" }), TRACEFY_ICP);
    expect(enterprise.points).toBeLessThan(rightSized.points);
    expect(enterprise.reasons.find((r) => r.key === "SIZE").points).toBeLessThan(0);
  });

  it("treats an unknown headcount as no evidence rather than a miss", () => {
    // sizeBucket is UNKNOWN on almost every company in the database; scoring it
    // as a miss would zero out the whole book on a field never collected.
    const unknown = icpFit(company({ city: "Dubai", countryCode: "AE", sizeBucket: "UNKNOWN" }), TRACEFY_ICP);
    expect(unknown.reasons.some((r) => r.key === "SIZE")).toBe(false);
    expect(unknown.points).toBeGreaterThan(0);
  });

  it("never exceeds the cap, however many things match", () => {
    const fit = icpFit(
      company({ city: "Dubai", countryCode: "AE", osmCategory: "amenity=school", industry: "School / academy", sizeBucket: "SMALL" }),
      TRACEFY_ICP,
    );
    expect(fit.points).toBeLessThanOrEqual(FIT_CAP);
  });

  it("survives a hand-edited profile that is missing every field", () => {
    // The ICP is edited by hand in a textarea and stored as Json; a fit
    // function that throws on a malformed one takes the whole scoring pass out.
    expect(() => icpFit(company({ city: "Dubai" }), {})).not.toThrow();
    expect(() => icpFit(company({ city: "Dubai" }), null)).not.toThrow();
    expect(icpFit(company({ city: "Dubai" }), null).matched).toBe(false);
  });
});

describe("bucketsForRange — headcount range onto the buckets the database holds", () => {
  it("maps 10–250 onto the two mid bands and excludes LARGE", () => {
    expect(bucketsForRange({ min: 10, max: 250 })).toEqual(["SMALL", "MEDIUM"]);
  });

  it("includes MICRO when the range starts below 10", () => {
    expect(bucketsForRange({ min: 1, max: 50 })).toContain("MICRO");
  });

  it("treats a missing ceiling as open-ended", () => {
    expect(bucketsForRange({ min: 50, max: null })).toContain("LARGE");
  });
});
