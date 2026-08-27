import { describe, it, expect } from "vitest";
import {
  phoneLineKind, rankWhatsAppCandidates, pickWhatsAppNumber, pickDisplayPhone, isDialable,
} from "../../lib/outreach/phoneRank.js";

/**
 * Which number gets WhatsApped.
 *
 * The rule this file pins down was written after a Berlin switchboard
 * (+49 30 78001738) was chosen for a WhatsApp message purely because it was the
 * first phone number on the record. The ordering matters more than any single
 * verdict: getting it wrong wastes a send and marks a reachable lead as
 * unreachable.
 */

describe("phoneLineKind", () => {
  it("reads the country code off an international number", () => {
    expect(phoneLineKind("+49 171 2345678")).toBe("MOBILE");
    expect(phoneLineKind("+49 30 78001738")).toBe("LANDLINE");
    expect(phoneLineKind("+966 50 123 4567")).toBe("MOBILE");
    expect(phoneLineKind("+966 11 234 5678")).toBe("LANDLINE");
    expect(phoneLineKind("+44 7700 900123")).toBe("MOBILE");
    expect(phoneLineKind("+44 20 7946 0000")).toBe("LANDLINE");
  });

  it("ignores a trunk zero written inside the international form", () => {
    // Sources write the same German mobile both ways.
    expect(phoneLineKind("+49 (0)171 234567")).toBe("MOBILE");
    expect(phoneLineKind("+491712345678")).toBe("MOBILE");
  });

  it("uses the company's country for a number written nationally", () => {
    expect(phoneLineKind("0501234567", "SA")).toBe("MOBILE");
    expect(phoneLineKind("0111111111", "SA")).toBe("LANDLINE");
    expect(phoneLineKind("07700 900123", "GB")).toBe("MOBILE");
    // Without the hint the same digits are unclassifiable, and we say so.
    expect(phoneLineKind("0501234567")).toBe("UNKNOWN");
  });

  it("admits it cannot tell, rather than guessing", () => {
    // The NANP carries no mobile/landline signal at all.
    expect(phoneLineKind("+1 415 555 0123")).toBe("UNKNOWN");
    expect(phoneLineKind("+1 415 555 0123", "US")).toBe("UNKNOWN");
    expect(phoneLineKind("12345")).toBe("UNKNOWN");
    expect(phoneLineKind("")).toBe("UNKNOWN");
    expect(phoneLineKind(null)).toBe("UNKNOWN");
  });
});

describe("isDialable", () => {
  it("rejects anything that cannot be a subscriber line", () => {
    expect(isDialable("+966501234567")).toBe(true);
    expect(isDialable("123456")).toBe(false);            // too short
    expect(isDialable("1234567890123456")).toBe(false);  // too long
    expect(isDialable("")).toBe(false);
  });
});

describe("rankWhatsAppCandidates", () => {
  const contact = (over) => ({ kind: "PHONE", confidenceLevel: "DETECTED", isSuppressed: false, ...over });

  it("orders link → mobile → unknown → landline", () => {
    const ranked = rankWhatsAppCandidates([
      contact({ value: "+49 30 78001738" }),                                    // landline
      contact({ value: "+1 415 555 0123" }),                                    // unknown
      contact({ value: "+49 171 2345678" }),                                    // mobile
      contact({ kind: "SOCIAL", roleHint: "WHATSAPP", value: "https://wa.me/4915112345678" }),
    ]);
    expect(ranked.map((r) => r.source + ":" + r.kind)).toEqual([
      "WHATSAPP_LINK:MOBILE", "PHONE:MOBILE", "PHONE:UNKNOWN", "PHONE:LANDLINE",
    ]);
  });

  it("never drops a number — a landline is still offered last", () => {
    const ranked = rankWhatsAppCandidates([contact({ value: "+49 30 78001738" })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].kind).toBe("LANDLINE");
  });

  it("breaks a tie within a tier on confidence", () => {
    const ranked = rankWhatsAppCandidates([
      contact({ value: "+966 50 111 1111", confidenceLevel: "AI_GENERATED" }),
      contact({ value: "+966 50 222 2222", confidenceLevel: "VERIFIED" }),
    ]);
    expect(ranked[0].number).toBe("966502222222");
  });

  it("collapses the same line reported in two formats", () => {
    // The website says one thing, Google Places says the same thing with spaces.
    const ranked = rankWhatsAppCandidates([
      contact({ value: "+493078001738" }),
      contact({ value: "+49 30 78001738", roleHint: "GOOGLE_PLACES" }),
    ]);
    expect(ranked).toHaveLength(1);
  });

  it("skips suppressed and unusable rows", () => {
    const ranked = rankWhatsAppCandidates([
      contact({ value: "+966501234567", isSuppressed: true }),
      contact({ value: "12345" }),
      contact({ kind: "EMAIL", value: "a@b.com" }),
    ]);
    expect(ranked).toEqual([]);
  });

  it("shows the number behind a wa.me link, never the URL", () => {
    const [first] = rankWhatsAppCandidates([
      contact({ kind: "SOCIAL", roleHint: "WHATSAPP", value: "https://api.whatsapp.com/send?phone=966500000000" }),
    ]);
    expect(first.display).toBe("+966500000000");
  });
});

describe("pickWhatsAppNumber / pickDisplayPhone", () => {
  it("agree on the same number, so the card and the sender never disagree", () => {
    const contacts = [
      { kind: "PHONE", value: "+966 11 222 2222", confidenceLevel: "VERIFIED", isSuppressed: false },
      { kind: "PHONE", value: "+966 50 123 4567", confidenceLevel: "DETECTED", isSuppressed: false },
    ];
    expect(pickDisplayPhone(contacts).number).toBe(pickWhatsAppNumber(contacts).number);
  });

  it("pickDisplayPhone ignores a wa.me link — it is not a phone column", () => {
    const contacts = [
      { kind: "SOCIAL", roleHint: "WHATSAPP", value: "https://wa.me/966500000000", isSuppressed: false },
      { kind: "PHONE", value: "+966 11 222 2222", confidenceLevel: "VERIFIED", isSuppressed: false },
    ];
    expect(pickDisplayPhone(contacts).number).toBe("966112222222");
    expect(pickWhatsAppNumber(contacts).source).toBe("WHATSAPP_LINK");
  });

  it("returns null when there is nothing to try", () => {
    expect(pickWhatsAppNumber([])).toBeNull();
    expect(pickDisplayPhone([])).toBeNull();
  });
});
