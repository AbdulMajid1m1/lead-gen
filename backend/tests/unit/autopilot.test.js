import { describe, it, expect } from "vitest";
import {
  LANES, laneFor, laneCampaignName, allocateBudget, emailAdmissible, whatsappAdmissible,
} from "../../lib/outreach/autopilot.js";

/** A lead shaped just enough for the admissibility helpers. */
const leadIn = (countryCode, { local = "hello", roleHint = null } = {}) => ({
  company: {
    countryCode,
    contacts: [{
      kind: "EMAIL", value: `${local}@example.com`, isSuppressed: false,
      roleHint, confidenceLevel: "VERIFIED",
    }],
  },
});

describe("lane routing", () => {
  it("routes Gulf countries to the Gulf lane", () => {
    for (const cc of ["AE", "SA", "QA", "KW", "BH", "OM"]) {
      expect(laneFor(cc).key).toBe("GULF");
    }
  });

  it("routes the Americas to the US lane", () => {
    expect(laneFor("US").key).toBe("US");
    expect(laneFor("CA").key).toBe("US");
  });

  it("falls back to UK & Europe for unmatched and unknown countries", () => {
    expect(laneFor("GB").key).toBe("UK_EU");
    expect(laneFor("DE").key).toBe("UK_EU");
    expect(laneFor("ZZ").key).toBe("UK_EU");
    // A lead whose country was never resolved still has to land somewhere.
    expect(laneFor(null).key).toBe("UK_EU");
    expect(laneFor(undefined).key).toBe("UK_EU");
  });

  it("gives every lane a distinct, stable campaign name", () => {
    const names = LANES.map(laneCampaignName);
    expect(new Set(names).size).toBe(LANES.length);
    // The name is how a lane finds its campaign again — it must not drift.
    expect(laneCampaignName(LANES[0])).toBe("Autopilot · Gulf");
  });

  it("staggers lanes across the day rather than stacking them", () => {
    const offsets = LANES.map((l) => l.tzOffsetMinutes);
    expect(new Set(offsets).size).toBe(LANES.length);
  });
});

describe("budget allocation", () => {
  it("never hands out more than the day's cap", () => {
    const split = allocateBudget({ total: 40, pendingByLane: { A: 100, B: 50, C: 10 } });
    const sum = Object.values(split).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(40);
  });

  it("splits roughly in proportion to the work each lane has", () => {
    const split = allocateBudget({ total: 40, pendingByLane: { big: 300, small: 100 } });
    expect(split.big).toBeGreaterThan(split.small);
  });

  it("gives a small lane a floor rather than starving it", () => {
    const split = allocateBudget({ total: 40, pendingByLane: { huge: 1000, tiny: 1 } });
    expect(split.tiny).toBeGreaterThanOrEqual(5);
  });

  it("spends the whole budget, not less", () => {
    for (const total of [5, 7, 13, 40, 100]) {
      const split = allocateBudget({ total, pendingByLane: { a: 61, b: 58, c: 32 } });
      const sum = Object.values(split).reduce((x, y) => x + y, 0);
      expect(sum).toBe(total);
    }
  });

  it("shrinks the floor rather than overshooting a tiny warm-up budget", () => {
    // Day one of a warm-up: five a day across three regions. A fixed floor of
    // five would hand out fifteen.
    const split = allocateBudget({ total: 5, pendingByLane: { a: 61, b: 58, c: 32 } });
    const sum = Object.values(split).reduce((x, y) => x + y, 0);
    expect(sum).toBe(5);
    expect(Math.max(...Object.values(split))).toBeLessThanOrEqual(5);
  });

  it("survives a budget smaller than the number of lanes", () => {
    const split = allocateBudget({ total: 2, pendingByLane: { a: 61, b: 58, c: 32 } });
    const sum = Object.values(split).reduce((x, y) => x + y, 0);
    expect(sum).toBe(2);
    // The busiest lanes get the scarce budget.
    expect(split.a).toBeGreaterThanOrEqual(split.c);
  });

  it("ignores lanes with nothing pending", () => {
    const split = allocateBudget({ total: 40, pendingByLane: { a: 10, b: 0 } });
    expect(split.b).toBeUndefined();
    expect(split.a).toBeLessThanOrEqual(40);
  });

  it("returns nothing when there is no budget or no work", () => {
    expect(allocateBudget({ total: 0, pendingByLane: { a: 10 } })).toEqual({});
    expect(allocateBudget({ total: 40, pendingByLane: {} })).toEqual({});
  });

  it("stays within cap even when the floors alone would exceed it", () => {
    // Eight lanes at a floor of 5 would want 40; the cap is 10.
    const pending = Object.fromEntries("abcdefgh".split("").map((k) => [k, 10]));
    const split = allocateBudget({ total: 10, pendingByLane: pending });
    const sum = Object.values(split).reduce((a, b) => a + b, 0);
    expect(sum).toBe(10);
  });
});

describe("email admissibility", () => {
  it("never sends where cold email is unlawful, whatever the policy", () => {
    for (const policy of ["SEND", "ROLE_ONLY", "HOLD"]) {
      expect(emailAdmissible(leadIn("DE"), policy)).toBe(false);
      expect(emailAdmissible(leadIn("NL"), policy)).toBe(false);
    }
  });

  it("always sends in the opt-out markets", () => {
    for (const policy of ["SEND", "ROLE_ONLY", "HOLD"]) {
      expect(emailAdmissible(leadIn("GB"), policy)).toBe(true);
      expect(emailAdmissible(leadIn("US"), policy)).toBe(true);
    }
  });

  it("ROLE_ONLY admits a Gulf role mailbox but not a named one", () => {
    expect(emailAdmissible(leadIn("SA", { local: "info" }), "ROLE_ONLY")).toBe(true);
    expect(emailAdmissible(leadIn("SA", { local: "ahmed" }), "ROLE_ONLY")).toBe(false);
    expect(emailAdmissible(leadIn("AE", { local: "contact" }), "ROLE_ONLY")).toBe(true);
  });

  it("HOLD refuses restricted markets even for a role mailbox", () => {
    expect(emailAdmissible(leadIn("SA", { local: "info" }), "HOLD")).toBe(false);
    expect(emailAdmissible(leadIn("AE", { local: "info" }), "HOLD")).toBe(false);
  });

  it("SEND admits a named address in a restricted market", () => {
    expect(emailAdmissible(leadIn("SA", { local: "ahmed" }), "SEND")).toBe(true);
  });

  it("treats an unknown country as restricted, not as allowed", () => {
    expect(emailAdmissible(leadIn(null, { local: "ahmed" }), "ROLE_ONLY")).toBe(false);
    expect(emailAdmissible(leadIn(null, { local: "ahmed" }), "HOLD")).toBe(false);
  });

  it("refuses a lead with no email address at all", () => {
    expect(emailAdmissible({ company: { countryCode: "GB", contacts: [] } }, "SEND")).toBe(false);
  });
});

describe("WhatsApp admissibility", () => {
  it("allows Germany, where email is blocked but a message is not", () => {
    expect(whatsappAdmissible(leadIn("DE"), "ROLE_ONLY")).toBe(true);
    // This is the case that matters: DE leads are unreachable by email, so
    // WhatsApp is the only channel they have.
    expect(emailAdmissible(leadIn("DE"), "ROLE_ONLY")).toBe(false);
  });

  it("HOLD keeps WhatsApp to the opt-out markets", () => {
    expect(whatsappAdmissible(leadIn("GB"), "HOLD")).toBe(true);
    expect(whatsappAdmissible(leadIn("SA"), "HOLD")).toBe(false);
  });
});
