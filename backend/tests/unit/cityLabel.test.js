import { describe, it, expect } from "vitest";
import { normalizeCityLabel } from "../../utils/normalize.js";

describe("normalizeCityLabel", () => {
  it("drops the disambiguating parenthetical but keeps the state code", () => {
    // These read as a database dump inside a sentence: "based in Brentwood
    // (St. Louis), MO" is the tell that no one looked at the business.
    expect(normalizeCityLabel("Brentwood (St. Louis), MO")).toBe("Brentwood, MO");
    expect(normalizeCityLabel("Los Angeles (Hollywood), CA")).toBe("Los Angeles, CA");
  });

  it("takes the first of an either/or pair", () => {
    expect(normalizeCityLabel("Kaukauna / Green Bay, WI")).toBe("Kaukauna, WI");
    expect(normalizeCityLabel("Reading|Wokingham")).toBe("Reading");
  });

  it("leaves a clean city alone, hyphens and all", () => {
    for (const city of ["London", "Cedar Rapids, IA", "Stratford-upon-Avon", "Saint-Denis", "Newcastle upon Tyne"]) {
      expect(normalizeCityLabel(city)).toBe(city);
    }
    expect(normalizeCityLabel("  Dublin  ")).toBe("Dublin");
  });

  it("treats a non-place as no place at all", () => {
    // A job board's "Remote (Germany)" reduces to "Remote", and "based in
    // Remote" reads worse than a sentence with no location in it.
    for (const v of ["Remote (Germany)", "Remote", "remote work", "Worldwide", "Various", "N/A", "Multiple Locations"]) {
      expect(normalizeCityLabel(v)).toBeNull();
    }
  });

  it("returns null when nothing printable is left", () => {
    // The copy templates omit the clause entirely on a null, which is the
    // right outcome — better no location than a parenthetical on its own.
    for (const bad of ["", "   ", "(unknown)", null, undefined]) {
      expect(normalizeCityLabel(bad)).toBeNull();
    }
  });

  it("upper-cases a lower-case state code", () => {
    expect(normalizeCityLabel("Omaha, ne")).toBe("Omaha, NE");
  });
});
