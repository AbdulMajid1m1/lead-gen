import { describe, it, expect } from "vitest";
import { parseCertificates } from "../../lib/adapters/crtsh.js";

/**
 * Certificate Transparency parsing, tested against a fixture in the exact shape
 * crt.sh returns. The live endpoint is frequently unavailable (it answered 502
 * during development), so the fetching path degrades to a recorded reason —
 * but the parsing that drives the NEW_DOMAIN and NEW_SUBDOMAIN signals must
 * still be provably correct.
 */
const FIXTURE = [
  { id: 1, name_value: "acme.co.uk\nwww.acme.co.uk", not_before: "2019-03-14T00:00:00", not_after: "2019-06-12T00:00:00" },
  { id: 2, name_value: "acme.co.uk", not_before: "2026-07-01T00:00:00", not_after: "2026-09-29T00:00:00" },
  { id: 3, name_value: "shop.acme.co.uk", not_before: "2026-08-01T00:00:00", not_after: "2026-10-30T00:00:00" },
  { id: 4, name_value: "booking.acme.co.uk\n*.acme.co.uk", not_before: "2026-08-10T00:00:00", not_after: "2026-11-08T00:00:00" },
  { id: 5, name_value: "blog.acme.co.uk", not_before: "2020-01-05T00:00:00", not_after: "2020-04-04T00:00:00" },
  { id: 6, name_value: "deep.nested.acme.co.uk", not_before: "2026-08-11T00:00:00", not_after: "2026-11-09T00:00:00" },
];

describe("parseCertificates", () => {
  it("dates the domain by its earliest certificate", () => {
    const { firstSeen } = parseCertificates(FIXTURE, "acme.co.uk");
    expect(firstSeen.toISOString().slice(0, 10)).toBe("2019-03-14");
  });

  it("surfaces only commercially meaningful subdomains", () => {
    const { subdomains } = parseCertificates(FIXTURE, "acme.co.uk");
    const hosts = subdomains.map((s) => s.host);
    expect(hosts).toContain("shop.acme.co.uk");
    expect(hosts).toContain("booking.acme.co.uk");
    // A blog is not a signal that new capability is being stood up.
    expect(hosts).not.toContain("blog.acme.co.uk");
  });

  it("ignores wildcards, the apex, and multi-level names", () => {
    const hosts = parseCertificates(FIXTURE, "acme.co.uk").subdomains.map((s) => s.host);
    expect(hosts).not.toContain("acme.co.uk");
    expect(hosts.some((h) => h.startsWith("*."))).toBe(false);
    expect(hosts).not.toContain("deep.nested.acme.co.uk");
  });

  it("dates each subdomain by its own earliest certificate, newest first", () => {
    const { subdomains } = parseCertificates(FIXTURE, "acme.co.uk");
    expect(subdomains[0].host).toBe("booking.acme.co.uk");
    expect(subdomains[0].firstSeen.toISOString().slice(0, 10)).toBe("2026-08-10");
  });

  it("handles an empty or malformed payload without throwing", () => {
    expect(parseCertificates([], "acme.co.uk")).toEqual({ firstSeen: null, subdomains: [] });
    expect(parseCertificates(null, "acme.co.uk")).toEqual({ firstSeen: null, subdomains: [] });
    expect(() => parseCertificates([{ name_value: null, not_before: "nonsense" }], "acme.co.uk")).not.toThrow();
  });
});
