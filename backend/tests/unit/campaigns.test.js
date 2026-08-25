import { describe, it, expect } from "vitest";
import { pickEmailContact, pickWhatsAppNumber } from "../../lib/outreach/campaigns.js";
import { whatsappInitialTemplate } from "../../lib/research/templates.js";

/**
 * The recipient-picking rules for bulk campaigns. A bulk send multiplies any
 * bad choice by hundreds, so which address gets picked — and which leads get
 * skipped — must be boringly predictable.
 */
describe("pickEmailContact", () => {
  const contact = (over) => ({ kind: "EMAIL", value: "x@a.com", roleHint: "ROLE", confidenceLevel: "DETECTED", isSuppressed: false, ...over });

  it("prefers a verified role address over anything else", () => {
    const picked = pickEmailContact([
      contact({ value: "personal@a.com", roleHint: "PERSONAL", confidenceLevel: "VERIFIED" }),
      contact({ value: "info@a.com", roleHint: "ROLE", confidenceLevel: "VERIFIED" }),
      contact({ value: "sales@a.com", roleHint: "ROLE", confidenceLevel: "DETECTED" }),
    ]);
    expect(picked.value).toBe("info@a.com");
  });

  it("never picks a non-outreach or suppressed address", () => {
    expect(pickEmailContact([contact({ roleHint: "NON_OUTREACH" })])).toBeNull();
    expect(pickEmailContact([contact({ isSuppressed: true })])).toBeNull();
    expect(pickEmailContact([{ kind: "PHONE", value: "123", isSuppressed: false }])).toBeNull();
  });
});

describe("pickWhatsAppNumber", () => {
  it("prefers an explicit WhatsApp link over a plain phone", () => {
    const picked = pickWhatsAppNumber([
      { kind: "PHONE", value: "+966111111111", confidenceLevel: "VERIFIED", isSuppressed: false },
      { kind: "SOCIAL", roleHint: "WHATSAPP", value: "https://wa.me/966500000000", isSuppressed: false },
    ]);
    expect(picked).toEqual({ number: "966500000000", source: "WHATSAPP_LINK" });
  });

  it("falls back to the best phone number", () => {
    const picked = pickWhatsAppNumber([
      { kind: "PHONE", value: "0111111111", confidenceLevel: "DETECTED", isSuppressed: false },
      { kind: "PHONE", value: "+966222222222", confidenceLevel: "VERIFIED", isSuppressed: false },
    ]);
    expect(picked).toEqual({ number: "+966222222222", source: "PHONE" });
  });

  it("returns null when there is nothing usable", () => {
    expect(pickWhatsAppNumber([])).toBeNull();
    expect(pickWhatsAppNumber([{ kind: "PHONE", value: "+96611", isSuppressed: true }])).toBeNull();
  });
});

describe("whatsappInitialTemplate", () => {
  it("stays short, names the company, and asks permission", () => {
    const { body } = whatsappInitialTemplate({
      company: { name: "Herfy" },
      facts: [{ id: 2, text: "The site has no online ordering.", confidenceLevel: "INFERRED" }],
      serviceLabel: "website development",
    });
    expect(body).toContain("Herfy");
    expect(body).toContain("website development");
    expect(body.length).toBeLessThan(400); // a chat message, not an email
    expect(body).toMatch(/\?$/);           // closes with a question, not a pitch
    expect(body).not.toMatch(/https?:\/\//); // no links in a first WhatsApp touch
  });

  it("still reads correctly with no facts at all", () => {
    const { body } = whatsappInitialTemplate({ company: { name: "Acme" }, facts: [], serviceLabel: "HR software" });
    expect(body).toContain("Acme");
    expect(body).not.toContain("undefined");
  });
});
