import { describe, it, expect, vi, beforeEach } from "vitest";
import { postalAddressRequiredFor } from "../../lib/outreach/sendPolicy.js";
import { renderSignatureText, renderSignatureHtml, renderSignatureWhatsApp } from "../../lib/outreach/signature.js";

describe("postalAddressRequiredFor", () => {
  it("names the law for the markets that demand an address in the message", () => {
    expect(postalAddressRequiredFor("US").law).toMatch(/CAN-SPAM/);
    expect(postalAddressRequiredFor("us").law).toMatch(/CAN-SPAM/);
    expect(postalAddressRequiredFor("CA").law).toMatch(/CASL/);
  });

  it("asks nothing of the markets that have no such rule", () => {
    // GB and IE are opt-out markets with no statutory address element, and
    // requiring one there would close a lane that is lawfully open.
    for (const cc of ["GB", "IE", "FR", "BE", "AE", "SA", null, undefined, ""]) {
      expect(postalAddressRequiredFor(cc)).toBeNull();
    }
  });
});

describe("the address in the rendered sign-off", () => {
  const sig = {
    name: "Test", fullName: "Abdul Majid", title: "CTO", company: "Deventia Tech",
    website: "deventiatech.com", email: "a@deventiahq.com", phone: "+966 50 000 0000",
    postalAddress: "Office 12, Building 4\nKing Fahd Road\nRiyadh 12345, Saudi Arabia",
    tagline: "Custom software, shipped.", accentColor: "#d97757",
  };

  it("flattens a pasted multi-line address onto one line", () => {
    // The text block is one field per line; a three-line address pasted into
    // the form would otherwise break that shape in the recipient's client.
    expect(renderSignatureText(sig)).toContain(
      "Office 12, Building 4, King Fahd Road, Riyadh 12345, Saudi Arabia",
    );
    expect(renderSignatureHtml(sig)).toContain("King Fahd Road, Riyadh 12345");
  });

  it("prints the address above the tagline, and omits it when unset", () => {
    const lines = renderSignatureText(sig).split("\n");
    expect(lines.indexOf("Custom software, shipped.")).toBe(lines.length - 1);
    expect(renderSignatureText({ ...sig, postalAddress: null })).not.toContain("King Fahd");
  });

  it("keeps it out of WhatsApp, which is two lines by design", () => {
    expect(renderSignatureWhatsApp(sig)).not.toContain("King Fahd");
  });
});

// The gate itself talks to the database, so the client is stubbed: what is
// under test is the decision, not Prisma.
vi.mock("../../prismaClient.js", () => ({
  default: {
    suppressionEntry: { findFirst: vi.fn().mockResolvedValue(null) },
    contact: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

describe("sendIsBlocked, on the postal-address requirement", () => {
  let sendIsBlocked;
  beforeEach(async () => {
    ({ sendIsBlocked } = await import("../../lib/outreach/service.js"));
  });

  const lead = (countryCode) => ({ status: "NEW", companyId: "c1", company: { countryCode } });

  it("refuses a US send when the sign-off carries no address", async () => {
    const blocked = await sendIsBlocked({
      lead: lead("US"), recipientEmail: "hi@acme.com",
      signature: { name: "Zubair", postalAddress: null },
    });
    expect(blocked).toMatch(/CAN-SPAM/);
    // The message has to say where to fix it, or it reads as an unexplained
    // refusal in the campaign log.
    expect(blocked).toMatch(/Zubair/);
  });

  it("refuses when an address field exists but holds only whitespace", async () => {
    expect(await sendIsBlocked({
      lead: lead("CA"), recipientEmail: "hi@acme.ca", signature: { name: "Z", postalAddress: "   " },
    })).toMatch(/CASL/);
  });

  it("allows the US send once an address is there", async () => {
    expect(await sendIsBlocked({
      lead: lead("US"), recipientEmail: "hi@acme.com",
      signature: { name: "Z", postalAddress: "1 Main St, Austin, TX 78701" },
    })).toBeNull();
  });

  it("refuses when no sign-off was resolved at all", async () => {
    // An unsigned send into the US is the case that must not slip through on a
    // default argument, so the omission is treated as the absence it is.
    expect(await sendIsBlocked({ lead: lead("US"), recipientEmail: "hi@acme.com" })).toMatch(/CAN-SPAM/);
  });

  it("leaves the UK and Ireland alone, signed or not", async () => {
    for (const cc of ["GB", "IE"]) {
      expect(await sendIsBlocked({ lead: lead(cc), recipientEmail: "hi@acme.co.uk" })).toBeNull();
    }
  });
});
