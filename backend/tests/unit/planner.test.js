import { describe, it, expect } from "vitest";
import { parseQuery } from "../../lib/nlquery/parser.js";
import { buildResearchPlan } from "../../lib/nlquery/planner.js";

/**
 * Research-plan shape. The regression this guards: a hiring query whose only
 * discovery engines were the two AI searches — so when the account had no
 * credits, the run finished "successfully" with an empty grid, while the same
 * query in quick search returned leads.
 */
const briefFor = (parsed, extra = {}) => ({
  restatedGoal: "test",
  industries: [],
  location: null,
  service: null,
  signals: [],
  icpTraits: [],
  searchStrategies: [
    { label: "A", searchInstruction: "a", expectedSourceTypes: ["DIRECTORY"] },
    { label: "B", searchInstruction: "b", expectedSourceTypes: ["COMPANY_SITE"] },
  ],
  exclusions: [],
  ...extra,
});

const kinds = (plan) => plan.steps.map((s) => s.kind);

describe("buildResearchPlan", () => {
  it("always starts from what the database already knows", () => {
    for (const q of ["companies hiring software developers", "restaurants in Dubai with no website"]) {
      const parsed = parseQuery(q);
      expect(kinds(buildResearchPlan(parsed, briefFor(parsed)))[0], q).toBe("DB_MATCH");
    }
  });

  it("gives a hiring query the deterministic hiring engines, not just AI", () => {
    const parsed = parseQuery("companies hiring software developers");
    const k = kinds(buildResearchPlan(parsed, briefFor(parsed)));
    expect(k).toContain("AGGREGATOR");
    expect(k).toContain("ATS_PROBE");
    // At least three discovery engines must survive an AI outage.
    const nonAi = k.filter((x) => ["DB_MATCH", "AGGREGATOR", "ATS_PROBE", "OVERPASS"].includes(x));
    expect(nonAi.length).toBeGreaterThanOrEqual(3);
  });

  it("gives a geo query the map engine", () => {
    const parsed = parseQuery("restaurants in Dubai with no website");
    const k = kinds(buildResearchPlan(parsed, briefFor(parsed, { location: { name: "Dubai", countryCode: "AE", cities: ["Dubai"] }, industries: ["restaurant"] })));
    expect(k).toContain("OVERPASS");
    expect(k).toContain("CRAWL");
  });

  it("always finishes with verify → signals → score → compose → snapshot", () => {
    const parsed = parseQuery("companies hiring HR managers");
    const k = kinds(buildResearchPlan(parsed, briefFor(parsed)));
    expect(k.slice(-5)).toEqual(["AI_VERIFY", "SIGNALS", "SCORE", "AI_COMPOSE", "SNAPSHOT"]);
  });
});
