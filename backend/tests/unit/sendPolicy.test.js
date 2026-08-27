import { describe, it, expect } from "vitest";
import { sendPolicyFor, isRoleAddress, isSendBlocked, POLICY } from "../../lib/outreach/sendPolicy.js";

/**
 * The legal gate.
 *
 * These are not style preferences — in the opt-in markets a single unsolicited
 * business email is actionable by the recipient with no regulator involved, and
 * the restriction reaches collection as well as sending. Getting these verdicts
 * wrong is the most expensive mistake the product can make, so they are pinned
 * per country and per channel.
 */

describe("email — the opt-in markets are closed", () => {
  it.each(["DE", "AT", "IT", "ES", "NL"])("%s blocks unsolicited business email", (code) => {
    const verdict = sendPolicyFor({ countryCode: code, channel: "EMAIL" });
    expect(verdict.policy).toBe(POLICY.BLOCKED);
    expect(isSendBlocked(verdict)).toBe(true);
    expect(verdict.law).toBeTruthy();   // the UI has to be able to say why
  });

  it("stays blocked for a role mailbox in those markets", () => {
    // The prohibition there comes from ePrivacy opt-in extended to legal
    // persons, so "it identifies no individual" is not a way out.
    expect(sendPolicyFor({ countryCode: "DE", channel: "EMAIL", roleAddress: true }).policy)
      .toBe(POLICY.BLOCKED);
    expect(sendPolicyFor({ countryCode: "NL", channel: "EMAIL", roleAddress: true }).policy)
      .toBe(POLICY.BLOCKED);
  });
});

describe("email — the opt-out markets are open", () => {
  it.each(["GB", "FR", "IE", "BE", "US"])("%s allows it", (code) => {
    expect(sendPolicyFor({ countryCode: code, channel: "EMAIL" }).policy).toBe(POLICY.ALLOWED);
  });
});

describe("email — the Gulf turns on who the address belongs to", () => {
  it("treats a named address as restricted", () => {
    // PDPL binds the processing of a natural person's data.
    expect(sendPolicyFor({ countryCode: "SA", channel: "EMAIL" }).policy).toBe(POLICY.RESTRICTED);
  });

  it("clears a role mailbox, which identifies no individual", () => {
    const verdict = sendPolicyFor({ countryCode: "SA", channel: "EMAIL", roleAddress: true });
    expect(verdict.policy).toBe(POLICY.ALLOWED);
    expect(verdict.note).toMatch(/role mailbox/i);
  });
});

describe("channel — a closed email market is not a closed market", () => {
  it("leaves the German phone route open where email is shut", () => {
    // UWG § 7(2) draws the distinction deliberately: Nr. 2 demands express
    // consent for email, Nr. 1 allows presumed consent for a B2B call. Blanket-
    // blocking the country would throw that away.
    expect(sendPolicyFor({ countryCode: "DE", channel: "EMAIL" }).policy).toBe(POLICY.BLOCKED);
    expect(sendPolicyFor({ countryCode: "DE", channel: "WHATSAPP" }).policy).toBe(POLICY.RESTRICTED);
    expect(sendPolicyFor({ countryCode: "DE", channel: "PHONE" }).policy).toBe(POLICY.RESTRICTED);
  });

  it("keeps Austria shut on every channel", () => {
    expect(sendPolicyFor({ countryCode: "AT", channel: "WHATSAPP" }).policy).toBe(POLICY.BLOCKED);
  });
});

describe("unknown territory is cautious, never permissive", () => {
  it("refuses to clear a lead with no country recorded", () => {
    const verdict = sendPolicyFor({ countryCode: null, channel: "EMAIL" });
    expect(verdict.policy).toBe(POLICY.RESTRICTED);
    expect(verdict.country).toBeNull();
  });

  it("refuses to clear a market it has no rule for", () => {
    expect(sendPolicyFor({ countryCode: "ZZ", channel: "EMAIL" }).policy).toBe(POLICY.RESTRICTED);
  });

  it("never invents an ALLOWED verdict from a missing rule", () => {
    for (const code of [undefined, "", "  ", "XX", "99"]) {
      expect(sendPolicyFor({ countryCode: code, channel: "EMAIL" }).policy).not.toBe(POLICY.ALLOWED);
    }
  });
});

describe("isRoleAddress", () => {
  it("trusts the classification the extractor already recorded", () => {
    expect(isRoleAddress({ roleHint: "ROLE", value: "anything@acme.de" })).toBe(true);
    expect(isRoleAddress({ roleHint: "PERSONAL", value: "info@acme.de" })).toBe(true); // local part still wins
    expect(isRoleAddress({ roleHint: "PERSONAL", value: "ahmed@acme.sa" })).toBe(false);
    expect(isRoleAddress(null)).toBe(false);
  });
});
