import { describe, it, expect } from "vitest";
import { buyerInboxes, inboxScore, rankInboxesForBuyer } from "../../lib/outreach/inboxFit.js";
import { pickEmailContact } from "../../lib/outreach/campaigns.js";

/**
 * Choosing the inbox the buyer actually reads.
 *
 * Every address below is real, taken from the first live TracefyHR run. The
 * campaign was about to pitch an HR platform to six schools' admissions desks
 * — the inbox that answers parents — while one of the same companies published
 * `hrm@eischools.ae` and it was never preferred.
 */

const HR_ICP = {
  buyerTitles: {
    decisionMakers: ["Founder", "Managing Director", "General Manager", "Operations Director"],
    champions: ["HR Manager", "HR & Admin Officer", "Payroll Officer", "Office Manager"],
  },
  suggestedSearchQueries: [{ label: "x", searchInstruction: "y", expectedSourceTypes: [] }],
};

const email = (value, over = {}) => ({
  kind: "EMAIL", value, isSuppressed: false, roleHint: "ROLE", confidenceLevel: "DETECTED", ...over,
});

describe("buyerInboxes — reading the buyer off the approved profile", () => {
  it("derives HR and payroll inboxes from HR buyer titles", () => {
    const inboxes = buyerInboxes(HR_ICP);
    expect(inboxes).toContain("hr");
    expect(inboxes).toContain("payroll");
  });

  it("derives owner inboxes from decision-maker titles", () => {
    expect(buyerInboxes(HR_ICP)).toContain("md");
  });

  it("returns nothing for a profile that names no buyer", () => {
    expect(buyerInboxes({})).toEqual([]);
  });
});

describe("inboxScore — is this the right desk", () => {
  const buyer = buyerInboxes(HR_ICP);

  it("scores an HR inbox above a generic one", () => {
    expect(inboxScore("hrm@eischools.ae", buyer)).toBeGreaterThan(inboxScore("info@eischools.ae", buyer));
  });

  it("scores an admissions inbox below a generic one", () => {
    expect(inboxScore("admissions@diadubai.com", buyer)).toBeLessThan(inboxScore("info@diadubai.com", buyer));
  });

  it("treats a reception desk as the wrong desk", () => {
    expect(inboxScore("reception@safacommunityschool.com", buyer)).toBeLessThan(0);
  });

  it("matches on whole segments, so 'chrome' is not an HR inbox", () => {
    expect(inboxScore("chrome@example.com", buyer)).toBe(0);
    expect(inboxScore("hr.dubai@example.com", buyer)).toBeGreaterThan(0);
  });
});

describe("pickEmailContact — the address a campaign will actually use", () => {
  it("prefers the HR inbox over admissions when selling to HR", () => {
    const contacts = [
      email("eisjadmission@eischools.ae", { confidenceLevel: "VERIFIED" }),
      email("hrm@eischools.ae"),
    ];
    expect(pickEmailContact(contacts, HR_ICP).value).toBe("hrm@eischools.ae");
  });

  it("keeps the old confidence ranking when no profile is supplied", () => {
    // An agency lead has no ICP, and must behave exactly as it did before.
    const contacts = [
      email("eisjadmission@eischools.ae", { confidenceLevel: "VERIFIED" }),
      email("hrm@eischools.ae"),
    ];
    expect(pickEmailContact(contacts).value).toBe("eisjadmission@eischools.ae");
  });

  it("falls back to a generic inbox when the company publishes no HR address", () => {
    const contacts = [email("admissions@dpsdubai.com"), email("info@dpsdubai.com")];
    expect(pickEmailContact(contacts, HR_ICP).value).toBe("info@dpsdubai.com");
  });

  it("still returns something when every address is the wrong desk", () => {
    // A lead with only an admissions address is still a lead; the ranking
    // demotes it, it does not delete it.
    const contacts = [email("admissions@dpsdubai.com"), email("reception@dpsdubai.com")];
    expect(pickEmailContact(contacts, HR_ICP)).not.toBeNull();
  });

  it("never returns a suppressed or non-outreach address", () => {
    const contacts = [
      email("hr@example.com", { isSuppressed: true }),
      email("payroll@example.com", { roleHint: "NON_OUTREACH" }),
      email("info@example.com"),
    ];
    expect(pickEmailContact(contacts, HR_ICP).value).toBe("info@example.com");
  });
});

describe("rankInboxesForBuyer", () => {
  it("orders best-fit first and keeps ties in their original order", () => {
    const ranked = rankInboxesForBuyer(
      [email("reception@x.com"), email("info@x.com"), email("contact@x.com"), email("hr@x.com")],
      HR_ICP,
    ).map((c) => c.value);
    expect(ranked[0]).toBe("hr@x.com");
    expect(ranked.at(-1)).toBe("reception@x.com");
    expect(ranked.slice(1, 3)).toEqual(["info@x.com", "contact@x.com"]);
  });
});
