import { describe, it, expect } from "vitest";
import { parseQuery, describeQuery } from "../../lib/nlquery/parser.js";

/**
 * Golden tests for the query parser. These encode the product's core promise:
 * a user types a sentence and gets the leads they meant.
 */
describe("parseQuery — acceptance queries", () => {
  it("restaurants in Dubai with outdated websites", () => {
    const r = parseQuery("restaurants in Dubai with outdated websites");
    expect(r.query.industries).toEqual(["restaurant"]);
    expect(r.query.location.name).toBe("Dubai");
    expect(r.query.signals).toContain("OUTDATED_WEBSITE");
    expect(r.query.signals).toContain("NO_MOBILE_VIEWPORT");
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("companies hiring CRM specialists this month", () => {
    const r = parseQuery("companies hiring CRM specialists this month");
    expect(r.query.signals).toContain("HIRING_CRM_ROLE");
    expect(r.query.jobTitleContains).toContain("crm");
    expect(r.query.postedWithinDays).toBe(30);
  });

  it("e-commerce stores on WooCommerce that need a mobile app", () => {
    const r = parseQuery("e-commerce stores on WooCommerce that need a mobile app");
    expect(r.query.technologies).toContain("WooCommerce");
    expect(r.query.service).toBe("MOBILE_APP");
    expect(r.query.signals).toContain("WOOCOMMERCE_DETECTED");
  });

  it("dental clinics in London without online booking", () => {
    const r = parseQuery("dental clinics in London without online booking");
    expect(r.query.industries).toEqual(["dentist"]);
    expect(r.query.location.name).toBe("London");
    expect(r.query.signals).toContain("NO_BOOKING_SYSTEM");
  });
});

describe("parseQuery — location extraction", () => {
  it.each([
    ["cafes in New York that dont have a website", "New York"],
    ["restaurants in New Delhi with outdated websites", "New Delhi"],
    ["businesses in Newcastle needing a new website", "Newcastle"],
    ["salons in Abu Dhabi without online booking", "Abu Dhabi"],
    ["gyms near Manchester not on wordpress", "Manchester"],
    ["hotels in Barcelona with score above 60", "Barcelona"],
    ["Dubai restaurants outdated website", "Dubai"],
  ])("extracts the place from %s", (query, expected) => {
    expect(parseQuery(query).query.location?.name).toBe(expected);
  });

  it("does not treat trailing filter words as part of a place name", () => {
    // Regression: "in London without online booking" once produced
    // "London Online Booking" because stopwords were filtered out of the middle
    // of the run instead of terminating it.
    const r = parseQuery("dental clinics in London without online booking");
    expect(r.query.location.name).toBe("London");
  });

  it("returns no location when none was given", () => {
    expect(parseQuery("companies hiring AI engineers").query.location).toBeNull();
  });
});

describe("parseQuery — negation and modifiers", () => {
  it("reads 'not on X' as a technology exclusion", () => {
    const r = parseQuery("gyms near Manchester not on wordpress");
    expect(r.query.excludeTechnologies).toContain("WordPress");
    expect(r.query.technologies).not.toContain("WordPress");
  });

  it("normalises the many ways of saying 'no website'", () => {
    for (const phrasing of [
      "restaurants with no website",
      "restaurants without a website",
      "restaurants that dont have a website",
      "restaurants missing website",
    ]) {
      expect(parseQuery(phrasing).query.signals, phrasing).toContain("NO_WEBSITE");
    }
  });

  it("reads explicit day ranges and score floors", () => {
    const r = parseQuery("startups hiring developers in the last 14 days with score above 70");
    expect(r.query.postedWithinDays).toBe(14);
    expect(r.query.minScore).toBe(70);
  });

  it("prefers the specific hiring role over the generic hiring signal", () => {
    const r = parseQuery("companies hiring mobile developers");
    expect(r.query.signals).toEqual(["HIRING_MOBILE_ROLE"]);
  });
});

describe("parseQuery — qualified industry phrases", () => {
  it.each([
    ["hair salons in Lisbon with no website", "salon", "Lisbon"],
    ["nail salons in London without online booking", "salon", "London"],
    ["yoga studios in Berlin", "gym", "Berlin"],
    ["car showrooms in Dubai", "car_dealer", "Dubai"],
  ])("consumes the qualifier with the noun in %s", (query, industry, location) => {
    const r = parseQuery(query);
    expect(r.query.industries).toEqual([industry]);
    expect(r.query.location.name).toBe(location);
    // Regression: an unconsumed qualifier ("hair") became a hard company-name
    // filter and silently returned zero results for a correct query.
    expect(r.unparsed).toEqual([]);
  });
});

describe("parseQuery — HR / SaaS vertical (TracefyHR)", () => {
  it("maps HR hiring queries to the specific HR signal, not generic hiring", () => {
    for (const q of ["companies hiring HR managers", "companies hiring recruiters", "companies hiring their first HR officer"]) {
      const r = parseQuery(q);
      expect(r.query.signals, q).toEqual(["HIRING_HR_ROLE"]);
      expect(r.query.jobTitleContains.length, q).toBeGreaterThan(0);
      expect(r.query.location, q).toBeNull();
    }
  });

  it("maps HR-software need to the HR_SOFTWARE service, not dev services", () => {
    const r = parseQuery("growing companies that need HR software");
    expect(r.query.service).toBe("HR_SOFTWARE");
    expect(r.query.signals).toContain("HIRING_MANY_ROLES");
  });

  it("reads 'hiring many roles' as the scale signal alone", () => {
    const r = parseQuery("companies hiring many roles at once");
    expect(r.query.signals).toEqual(["HIRING_MANY_ROLES"]);
    expect(r.query.location).toBeNull();
  });

  it("keeps the location when an HR query names one", () => {
    const r = parseQuery("companies hiring recruiters in Riyadh");
    expect(r.query.location.name).toBe("Riyadh");
    expect(r.query.signals).toEqual(["HIRING_HR_ROLE"]);
  });
});

describe("describeQuery", () => {
  it("restates the query in plain language", () => {
    const r = parseQuery("restaurants in Dubai with outdated websites");
    expect(describeQuery(r)).toBe("Restaurant in Dubai with outdated website");
  });
});

describe("parseQuery — robustness", () => {
  it.each(["", "   ", "a", "!!!", "?????"])("survives degenerate input %j", (q) => {
    const r = parseQuery(q);
    expect(r.query).toBeDefined();
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("never throws on a very long input", () => {
    expect(() => parseQuery("restaurants ".repeat(500))).not.toThrow();
  });
});
