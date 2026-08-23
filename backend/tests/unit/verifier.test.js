import { describe, it, expect } from "vitest";
import { extractContacts } from "../../lib/extract/contacts.js";
import { phoneMatchKey, normalizeDomain } from "../../utils/normalize.js";

/**
 * The value-matching rules the claim verifier uses to decide whether a page
 * really does contain what the AI said it contains.
 *
 * These are exercised directly (rather than through the DB layer) because they
 * are where a wrong answer becomes a wrong contact in a real outreach email.
 */

// Mirrors lib/research/verifier.js#valuesMatch.
const valuesMatch = (field, claimed, observed) => {
  if (!claimed || !observed) return false;
  switch (field) {
    case "EMAIL": return claimed.trim().toLowerCase() === observed.trim().toLowerCase();
    case "PHONE":
    case "WHATSAPP": {
      const a = phoneMatchKey(claimed); const b = phoneMatchKey(observed);
      return Boolean(a && b && a === b);
    }
    case "WEBSITE": return normalizeDomain(claimed) === normalizeDomain(observed);
    case "ADDRESS": {
      const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const a = norm(claimed); const b = norm(observed);
      return a.length > 8 && (b.includes(a) || a.includes(b));
    }
    default: return false;
  }
};

describe("claim value matching", () => {
  it("accepts the same email in different casing", () => {
    expect(valuesMatch("EMAIL", "Info@Acme.SA", "info@acme.sa")).toBe(true);
  });

  it("rejects a similar but different email", () => {
    // The classic hallucination: the model guesses info@ when the page says sales@.
    expect(valuesMatch("EMAIL", "info@acme.sa", "sales@acme.sa")).toBe(false);
  });

  it("accepts the same phone written in different formats", () => {
    expect(valuesMatch("PHONE", "+966 11 456 7890", "011-456-7890")).toBe(true);
    expect(valuesMatch("PHONE", "00966114567890", "+966114567890")).toBe(true);
  });

  it("rejects a phone that differs in its significant digits", () => {
    expect(valuesMatch("PHONE", "+966114567890", "+966114567899")).toBe(false);
  });

  it("compares websites by registrable domain", () => {
    expect(valuesMatch("WEBSITE", "https://www.acme.sa/contact", "http://acme.sa")).toBe(true);
    expect(valuesMatch("WEBSITE", "https://acme.sa", "https://acme-group.sa")).toBe(false);
  });

  it("requires a substantial address overlap, not a coincidental word", () => {
    expect(valuesMatch("ADDRESS", "King Fahd Road, Riyadh", "Unit 4, King Fahd Road, Riyadh 11564")).toBe(true);
    expect(valuesMatch("ADDRESS", "Riyadh", "Jeddah")).toBe(false);
  });

  it("never matches on empty or missing values", () => {
    for (const field of ["EMAIL", "PHONE", "WEBSITE", "ADDRESS"]) {
      expect(valuesMatch(field, null, "x")).toBe(false);
      expect(valuesMatch(field, "x", null)).toBe(false);
      expect(valuesMatch(field, "", "")).toBe(false);
    }
  });
});

describe("what a fetched page actually proves", () => {
  const page = `<html><body>
    <a href="mailto:info@acme.sa">Email us</a>
    <a href="tel:+966114567890">Call</a>
    <a href="https://wa.me/966501234567">WhatsApp us</a>
  </body></html>`;

  const observed = (html) => {
    const f = extractContacts(html, { pageUrl: "https://acme.sa/contact" });
    return {
      EMAIL: f.emails.map((e) => e.value),
      PHONE: f.phones.map((p) => p.value),
      WHATSAPP: f.socials.filter((s) => s.network === "WHATSAPP").map((s) => s.handle || s.url),
    };
  };

  it("confirms a claimed email that really is on the page", () => {
    const o = observed(page);
    expect(o.EMAIL.some((v) => valuesMatch("EMAIL", "info@acme.sa", v))).toBe(true);
  });

  it("refuses to confirm an email the page does not contain", () => {
    const o = observed(page);
    expect(o.EMAIL.some((v) => valuesMatch("EMAIL", "contact@acme.sa", v))).toBe(false);
  });

  it("confirms WhatsApp only from an explicit wa.me link", () => {
    const o = observed(page);
    expect(o.WHATSAPP.some((v) => valuesMatch("WHATSAPP", "+966501234567", v))).toBe(true);
  });

  it("does NOT treat an ordinary phone number as proof of WhatsApp", () => {
    // A page with a phone but no wa.me link proves nothing about WhatsApp.
    // Claiming otherwise would put a green "verified" badge on a guess.
    const phoneOnly = '<html><body><a href="tel:+966114567890">Call</a></body></html>';
    const o = observed(phoneOnly);
    expect(o.WHATSAPP).toEqual([]);
    expect(o.WHATSAPP.some((v) => valuesMatch("WHATSAPP", "+966114567890", v))).toBe(false);
  });
});

/**
 * Domain-resolution guards. A wrong website means a wrong email address, which
 * means outreach to a stranger — the most damaging error this product can make.
 */
const PARKED_MARKERS = /\b(?:domainster|sedo|afternic|dan\.com|hugedomains|buydomains|namecheap parking|godaddy(?:\.com)? (?:parking|auctions)|this domain (?:is|may be) for sale|buy this domain|the domain .{0,40} is for sale|parked (?:free )?(?:domain|courtesy)|inquire about this domain)\b/i;

const pageCorroboratesLocation = (html, { city, countryCode, domain }) => {
  if (!city && !countryCode) return { ok: true };
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (city && new RegExp(`\\b${city}\\b`, "i").test(text)) return { ok: true };
  const ccTld = { SA: ".sa", AE: ".ae", GB: ".uk" }[countryCode];
  if (ccTld && domain.endsWith(ccTld)) return { ok: true };
  const countryNames = { SA: "saudi", AE: "emirates|dubai", GB: "united kingdom|england" }[countryCode];
  if (countryNames && new RegExp(`\\b(?:${countryNames})\\b`, "i").test(text)) return { ok: true };
  return { ok: false };
};

describe("domain resolution guards", () => {
  it("rejects a parked domain-broker page", () => {
    // Regression: "Gad" in Riyadh was resolved to gad.com and acquired
    // info@domainster.com as its business email.
    expect(PARKED_MARKERS.test("<title>gad.com</title><p>This domain is for sale. Inquire about this domain</p>")).toBe(true);
    expect(PARKED_MARKERS.test("<p>Powered by HugeDomains</p>")).toBe(true);
  });

  it("does not flag an ordinary business page as parked", () => {
    expect(PARKED_MARKERS.test("<title>Herfy — Restaurants across Saudi Arabia</title>")).toBe(false);
  });

  it("rejects a same-name business in the wrong country", () => {
    // Regression: "French Corner" in Riyadh matched a US bakery's site.
    const usPage = "<title>French Corner Bakery</title><p>Visit us in Chicago, Illinois. Call 760-230-2221</p>";
    expect(pageCorroboratesLocation(usPage, { city: "Riyadh", countryCode: "SA", domain: "frenchcorner.com" }).ok).toBe(false);
  });

  it("accepts a page that names the company's own city", () => {
    const page = "<title>French Corner</title><p>Our café in Riyadh, open daily.</p>";
    expect(pageCorroboratesLocation(page, { city: "Riyadh", countryCode: "SA", domain: "frenchcorner.com" }).ok).toBe(true);
  });

  it("accepts a country-code domain as geographic proof", () => {
    expect(pageCorroboratesLocation("<title>Herfy</title>", { city: "Riyadh", countryCode: "SA", domain: "herfy.com.sa" }).ok).toBe(true);
  });

  it("accepts a page naming the country even without the city", () => {
    const page = "<title>Herfy</title><p>Serving customers across Saudi Arabia since 1981.</p>";
    expect(pageCorroboratesLocation(page, { city: "Riyadh", countryCode: "SA", domain: "herfy.com" }).ok).toBe(true);
  });
});
