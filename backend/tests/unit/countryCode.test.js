import { describe, it, expect } from "vitest";
import { normaliseCountryCode } from "../../utils/countries.js";

describe("normaliseCountryCode", () => {
  it("accepts a two-letter code in any case", () => {
    expect(normaliseCountryCode("ie")).toBe("IE");
    expect(normaliseCountryCode(" gb ")).toBe("GB");
    // Not every code is in the display table, and that must not reject it.
    expect(normaliseCountryCode("BD")).toBe("BD");
  });

  it("returns null for anything that is not a country code", () => {
    // The caller falls back to the run's own market on null. A half-parsed
    // value would be written onto the company and then read by the send gate
    // as the law that applies to it, which is worse than no value at all.
    for (const bad of ["", "   ", "U", "GBR", "United Kingdom", "G1", null, undefined, 44, {}]) {
      expect(normaliseCountryCode(bad)).toBeNull();
    }
  });
});
