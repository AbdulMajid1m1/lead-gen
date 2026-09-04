import { describe, it, expect } from "vitest";
import {
  productCampaignName, productBudget, dailyCeiling, warmupDay,
} from "../../lib/outreach/promoterAutopilot.js";
import { DAILY_EMAIL_CAP } from "../../lib/outreach/campaigns.js";
import { productFollowUpTemplate } from "../../lib/research/templates.js";

const DAY_MS = 86_400_000;
const daysAgo = (n, now) => new Date(now.getTime() - n * DAY_MS);

describe("promoter autopilot budget", () => {
  const now = new Date("2026-09-04T09:00:00Z");

  it("names the campaign after the product and finds it by id, not name", () => {
    expect(productCampaignName({ name: "TracefyHR" })).toBe("Promoter · TracefyHR");
    expect(productCampaignName({})).toBe("Promoter · product");
  });

  it("holds a fresh mailbox to its warm-up step, whatever the operator asked for", () => {
    const fresh = { warmupStartedAt: daysAgo(0, now) }; // day 1
    expect(dailyCeiling(fresh, { now })).toBe(5);
    expect(productBudget({ settings: { dailyLimit: 40 }, ceiling: dailyCeiling(fresh, { now }) })).toBe(5);
    expect(warmupDay(fresh, { now })).toBe(1);
  });

  it("follows the ramp and then the configured cap", () => {
    expect(dailyCeiling({ warmupStartedAt: daysAgo(6, now) }, { now })).toBe(20); // day 7
    expect(dailyCeiling({ warmupStartedAt: daysAgo(12, now) }, { now })).toBe(35); // day 13
    const done = { warmupStartedAt: daysAgo(30, now) };
    expect(dailyCeiling(done, { now })).toBe(DAILY_EMAIL_CAP);
    expect(warmupDay(done, { now })).toBeNull();
  });

  it("lets the operator send less than the ceiling but never more, and never zero", () => {
    expect(productBudget({ settings: { dailyLimit: 10 }, ceiling: 40 })).toBe(10);
    expect(productBudget({ settings: { dailyLimit: null }, ceiling: 40 })).toBe(40);
    expect(productBudget({ settings: { dailyLimit: 100 }, ceiling: 40 })).toBe(40);
    expect(productBudget({ settings: {}, ceiling: 0 })).toBe(0);
  });

  it("reports nothing sendable without a mailbox", () => {
    expect(dailyCeiling(null)).toBe(0);
  });
});

describe("productFollowUpTemplate", () => {
  const product = {
    name: "TracefyHR",
    url: "https://tracefyhr.com",
    pricing: [{ plan: "Starter", price: "$20/month", capacity: "Up to 50 employees" }],
    proofPoints: [
      { value: "States most customers save over $20,000/year switching from BambooHR or Rippling" },
      { value: "30-day free trial, no credit card required, cancel anytime" },
      { value: "Founding 50 companies receive lifetime founder pricing" },
    ],
    icp: {
      painPoints: [
        { pain: "Payroll is run in spreadsheets and re-keyed every month", productAnswer: "Automated salary calculations with tax handling" },
        { pain: "Leave requests and approvals live in WhatsApp and email", productAnswer: "Employee self-service leave requests with manager approvals" },
      ],
    },
  };
  const company = { name: "Jigsaw Nursery", industry: "nursery", countryCode: "AE" };

  it("chase 1 names an outcome from the ICP, the flat price, and asks for one word", () => {
    const { body } = productFollowUpTemplate({ company, product, followUpNumber: 1 });
    expect(body).toMatch(/TracefyHR gives you/);
    expect(body).toMatch(/\$20 a month for up to 50 staff/);
    expect(body).toMatch(/"Yes" is enough/);
    expect(body).not.toMatch(/website|portfolio|software development/i);
    expect(body).not.toMatch(/https?:\/\//); // no link before the second chase
  });

  it("chase 2 carries proof, removes the risk, and is the first with a link", () => {
    const { body } = productFollowUpTemplate({ company, product, followUpNumber: 2 });
    expect(body).toMatch(/save over \$20,000\/year/);
    expect(body).toMatch(/no credit card/);
    expect(body).toMatch(/lifetime founder pricing/);
    expect(body).toMatch(/https:\/\/tracefyhr\.com/);
    expect(body).toMatch(/one-word "no"/);
  });

  it("chase 3 is the breakup and promises to stop", () => {
    const { body } = productFollowUpTemplate({ company, product, followUpNumber: 3 });
    expect(body).toMatch(/Last note from me/);
    expect(body).toMatch(/Jigsaw Nursery/);
  });

  it("survives a product with no profile at all", () => {
    const { body } = productFollowUpTemplate({ company, product: { name: "Acme" }, followUpNumber: 1 });
    expect(body).toMatch(/Acme/);
    expect(body).not.toMatch(/undefined|null/);
    expect(productFollowUpTemplate({ company, product: { name: "Acme" }, followUpNumber: 2 }).body).toMatch(/ten minutes inside it/);
  });
});

describe("productEmailAdmissible", () => {
  const lead = (countryCode, local, roleHint = null, icp = null) => ({
    company: {
      countryCode,
      contacts: [{ kind: "EMAIL", value: `${local}@example.ae`, isSuppressed: false, roleHint, confidenceLevel: "VERIFIED" }],
      people: [],
    },
    discoveryRun: { promotedProduct: { icp } },
  });

  it("writes to an HR mailbox in the UAE under ROLE_ONLY, but not to a named person", async () => {
    const { productEmailAdmissible } = await import("../../lib/outreach/promoterAutopilot.js");
    expect(productEmailAdmissible(lead("AE", "hr", "ROLE"), "ROLE_ONLY")).toBe(true);
    expect(productEmailAdmissible(lead("AE", "ahmed", "PERSONAL"), "ROLE_ONLY")).toBe(false);
    expect(productEmailAdmissible(lead("AE", "ahmed", "PERSONAL"), "SEND")).toBe(true);
    expect(productEmailAdmissible(lead("AE", "hr", "ROLE"), "HOLD")).toBe(false);
  });

  it("never writes into an opt-in market, and never without an address", async () => {
    const { productEmailAdmissible } = await import("../../lib/outreach/promoterAutopilot.js");
    expect(productEmailAdmissible(lead("DE", "hr", "ROLE"), "SEND")).toBe(false);
    expect(productEmailAdmissible({ company: { countryCode: "GB", contacts: [] } }, "SEND")).toBe(false);
    expect(productEmailAdmissible(lead("GB", "ahmed", "PERSONAL"), "HOLD")).toBe(true);
  });
});
