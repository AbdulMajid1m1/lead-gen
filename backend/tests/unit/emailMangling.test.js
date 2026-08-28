import { describe, it, expect } from "vitest";
import { decodeWordSeparators } from "../../lib/extract/emailDecode.js";
import { emailLooksMangled } from "../../lib/outreach/hygiene.js";
import { expandLocation } from "../../lib/research/brief.js";

/**
 * The word-separator decoder recovers addresses a site deliberately hid. Its
 * failure mode is the expensive one: it used to treat the "at" inside an
 * ordinary word as a hidden at-sign, so the prose "…more information point
 * it…" became the contact `inform@ion.it`. Six per cent of every email in the
 * database was invented this way, and because `ion.it` and `ion.live` are real
 * domains that accept mail, the addresses were deliverable — to companies with
 * no connection to the lead.
 */
describe("decodeWordSeparators", () => {
  it("decodes the obfuscation forms the European long tail actually uses", () => {
    expect(decodeWordSeparators("info (at) acme punkt de")).toBe("info@acme.de");
    expect(decodeWordSeparators("buero ät muster-bau punkt de")).toBe("buero@muster-bau.de");
    expect(decodeWordSeparators("contact arobase societe point fr")).toBe("contact@societe.fr");
    expect(decodeWordSeparators("sales [at] example [dot] com")).toBe("sales@example.com");
    expect(decodeWordSeparators("kontakt klammeraffe firma punkt at")).toBe("kontakt@firma.at");
    expect(decodeWordSeparators("info arroba empresa punto es")).toBe("info@empresa.es");
  });

  it("never splits an ordinary word that happens to contain 'at'", () => {
    for (const prose of [
      "information point it",
      "our reputation. Clinic hours",
      "collaboration live",
      "accurate digital",
      "more education today",
      "operate run",
      "deprivation in",
      "verification id",
      "exploration in",
      "the situation. Live now",
    ]) {
      expect(decodeWordSeparators(prose)).toBe(prose);
    }
  });

  it("still refuses a bare 'at' with no disguised dot", () => {
    expect(decodeWordSeparators("Learn more at stripe.com")).toBe("Learn more at stripe.com");
  });
});

describe("emailLooksMangled", () => {
  it("catches addresses produced by splitting a word on 'at'", () => {
    for (const value of [
      "inform@ion.it", "collabor@ion.live", "regul@ions.in", "depriv@ion.in",
      "verific@ion.id", "explor@ion.in", "oper@e.run", "consult@ion.be",
      "educ@ion.today", "reput@ion.clinic", "tre@ment.world", "accur@e.digital",
      "chocol@e.it", "bre@h.it", "p@ients.it", "n@ion.in",
    ]) {
      expect(emailLooksMangled(value), value).toBe(true);
    }
  });

  it("leaves real mailboxes of the same shape alone", () => {
    for (const value of [
      "careers@stripe.com", "press@wagamama.com", "reception@truesmile.ae",
      "seaport@bostondental.com", "care@gdcabudhabi.ae", "appointments@lmg.ae",
      "hr@mway.io", "gm@shurfa.com", "help@remote.com", "property@johndwood.com",
      "info@acme.de", "sales@ion-group.com", "info@ionics.de",
    ]) {
      expect(emailLooksMangled(value), value).toBe(false);
    }
  });
});

/**
 * A city-level query used to produce a location with no country, and a company
 * born from that run inherited none — which sendPolicyFor() reads as an unknown
 * market and answers RESTRICTED, silently withholding leads it is plainly
 * lawful to contact.
 */
describe("expandLocation", () => {
  it("resolves a city to its country", () => {
    expect(expandLocation({ name: "Abu Dhabi" }).countryCode).toBe("AE");
    expect(expandLocation({ name: "Doha" }).countryCode).toBe("QA");
    expect(expandLocation({ name: "Muscat" }).countryCode).toBe("OM");
    expect(expandLocation({ name: "Manchester" }).countryCode).toBe("GB");
    expect(expandLocation({ name: "Paris" }).countryCode).toBe("FR");
  });

  it("still expands a country to its major cities", () => {
    const sa = expandLocation({ name: "Saudi Arabia" });
    expect(sa.countryCode).toBe("SA");
    expect(sa.cities).toContain("Riyadh");
  });

  it("leaves a place it does not recognise untouched", () => {
    expect(expandLocation({ name: "Nowhereville" }).countryCode).toBeUndefined();
  });
});
