import { describe, it, expect } from "vitest";
import { buildQuery, OSM_CATEGORIES } from "../../lib/adapters/overpass.js";

/**
 * The Overpass query shape.
 *
 * The regression this guards is expensive and silent: the query asked for
 * `nwr`, and resolving the relation half of it cost more on the public instance
 * than everything else put together. The same school search around Dubai
 * answered in 32s as node+way with 79 results, and in 68s as `nwr` with a
 * runtime-error remark and no elements. Overpass reports that failure inside a
 * 200 response, so it surfaced as a map step that found nothing rather than as
 * an error — the map engine was quietly dead in every discovery run.
 */
describe("buildQuery", () => {
  const q = buildQuery({ lat: 25.2048, lon: 55.2708, categoryKey: "school", radiusMeters: 12_000, limit: 100, timeoutSec: 50 });

  it("never asks for relations", () => {
    expect(q).not.toMatch(/\bnwr\b/);
    expect(q).not.toMatch(/^\s*relation\[/m);
  });

  it("asks for both nodes and ways, for every tag in the category", () => {
    for (const [k, v] of OSM_CATEGORIES.school.tags) {
      expect(q).toContain(`node["${k}"="${v}"]`);
      expect(q).toContain(`way["${k}"="${v}"]`);
    }
  });

  it("carries the radius, the limit and both timeouts it was given", () => {
    expect(q).toContain("[out:json][timeout:50]");
    expect(q).toContain("around:12000,25.2048,55.2708");
    expect(q).toContain("out center tags 100;");
  });

  it("requires a name, so unnamed geometry never becomes a company", () => {
    // An unnamed polygon cannot be matched, dedup-keyed or written to; it would
    // only ever arrive as a company called "(unnamed)".
    expect(q).toContain('["name"]');
  });

  it("builds a usable query for every category in the catalogue", () => {
    for (const key of Object.keys(OSM_CATEGORIES)) {
      const built = buildQuery({ lat: 25, lon: 55, categoryKey: key });
      expect(built, key).not.toMatch(/\bnwr\b/);
      expect(built, key).toMatch(/^\[out:json\]\[timeout:\d+\];/);
      expect(built, key).toContain("out center tags");
    }
  });

  it("refuses a category it does not know rather than searching for nothing", () => {
    expect(() => buildQuery({ lat: 25, lon: 55, categoryKey: "not_a_category" })).toThrow();
  });
});
