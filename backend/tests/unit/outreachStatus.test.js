import { describe, it, expect } from "vitest";
import { nextFollowUpDate, bucketFor } from "../../lib/outreach/service.js";

/**
 * The two pure decisions behind outreach status tracking: when the next chase
 * is due, and where a thread belongs in the day's work.
 *
 * Both are exercised directly because they are the difference between "we
 * emailed them and heard nothing" and "someone replied four days ago and no
 * one noticed" — the failure this layer exists to prevent.
 */

const DAY = 86_400_000;
const daysFromNow = (d) => Math.round((d.getTime() - Date.now()) / DAY);

describe("nextFollowUpDate", () => {
  const config = { followUpDays: [3, 7], maxFollowUps: 2 };

  it("schedules the first chase using the first gap", () => {
    expect(daysFromNow(nextFollowUpDate(config, 0))).toBe(3);
  });

  it("schedules the second chase using the second gap, measured from now", () => {
    expect(daysFromNow(nextFollowUpDate(config, 1))).toBe(7);
  });

  it("stops once the sequence is spent", () => {
    expect(nextFollowUpDate(config, 2)).toBeNull();
    expect(nextFollowUpDate(config, 5)).toBeNull();
  });

  it("stops when maxFollowUps is zero, whatever the gaps say", () => {
    expect(nextFollowUpDate({ followUpDays: [3, 7], maxFollowUps: 0 }, 0)).toBeNull();
  });

  it("falls back to [3, 7] when followUpDays is missing or malformed", () => {
    expect(daysFromNow(nextFollowUpDate({ maxFollowUps: 2 }, 0))).toBe(3);
    expect(daysFromNow(nextFollowUpDate({ followUpDays: "3,7", maxFollowUps: 2 }, 0))).toBe(3);
  });

  it("treats a non-numeric or zero gap as the end of the sequence rather than sending immediately", () => {
    expect(nextFollowUpDate({ followUpDays: [null, 7], maxFollowUps: 2 }, 0)).toBeNull();
    expect(nextFollowUpDate({ followUpDays: [0, 7], maxFollowUps: 2 }, 0)).toBeNull();
  });
});

describe("bucketFor", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const thread = (over = {}) => ({
    status: "AWAITING_REPLY",
    followUpsSent: 0,
    nextFollowUpAt: null,
    repliedAt: null,
    lead: { status: "CONTACTED" },
    ...over,
  });

  it("puts an unanswered reply in front of the user", () => {
    const t = thread({ status: "REPLIED", lead: { status: "REPLIED" } });
    expect(bucketFor(t, now)).toBe("replied");
  });

  it("clears a reply out of the queue once a human has judged the lead", () => {
    for (const status of ["INTERESTED", "NOT_INTERESTED", "CONVERTED"]) {
      expect(bucketFor(thread({ status: "REPLIED", lead: { status } }), now)).toBe("closed");
    }
  });

  it("marks a chase due when its time has passed", () => {
    expect(bucketFor(thread({ nextFollowUpAt: new Date(now.getTime() - DAY) }), now)).toBe("due");
  });

  it("counts a chase scheduled for this exact moment as due", () => {
    expect(bucketFor(thread({ nextFollowUpAt: new Date(now.getTime()) }), now)).toBe("due");
  });

  it("leaves a chase booked for later alone", () => {
    expect(bucketFor(thread({ nextFollowUpAt: new Date(now.getTime() + DAY) }), now)).toBe("waiting");
  });

  it("separates a spent sequence from one that has not started", () => {
    // Every chase sent, still nothing — needs a different angle, not another email.
    expect(bucketFor(thread({ followUpsSent: 2 }), now)).toBe("silent");
    // Sent once, no chase scheduled (automation off) — still just waiting.
    expect(bucketFor(thread({ followUpsSent: 0 }), now)).toBe("waiting");
  });

  it("treats bounced and closed threads as done", () => {
    expect(bucketFor(thread({ status: "BOUNCED" }), now)).toBe("closed");
    expect(bucketFor(thread({ status: "CLOSED" }), now)).toBe("closed");
  });
});
