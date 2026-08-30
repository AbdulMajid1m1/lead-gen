import { describe, it, expect } from "vitest";
import {
  pickEmailContact, pickWhatsAppNumber,
  localHour, isWithinSendWindow, autoGapSeconds, startOfLocalToday,
  localWeekday, sendDaysOf, isSendDay, isFutureStart, ALL_DAYS,
} from "../../lib/outreach/campaigns.js";
import { recommendDailyLimit, warmupStage, MIN_DAILY_LIMIT } from "../../lib/outreach/planner.js";
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
    // `number` is what gets dialled; the wa.me URL is never shown back to a user.
    expect(picked).toMatchObject({ number: "966500000000", display: "+966500000000", source: "WHATSAPP_LINK" });
  });

  it("falls back to a phone, preferring the mobile over the switchboard", () => {
    const picked = pickWhatsAppNumber([
      { kind: "PHONE", value: "+966 11 222 2222", confidenceLevel: "VERIFIED", isSuppressed: false },
      { kind: "PHONE", value: "+966 50 123 4567", confidenceLevel: "DETECTED", isSuppressed: false },
    ]);
    // The merely-DETECTED mobile beats the VERIFIED landline: on this channel,
    // reachability outranks provenance. A verified landline is verified to be
    // a landline.
    expect(picked).toMatchObject({ number: "966501234567", kind: "MOBILE", source: "PHONE" });
  });

  it("still returns a landline when it is the only number there is", () => {
    const picked = pickWhatsAppNumber([
      { kind: "PHONE", value: "+49 30 78001738", confidenceLevel: "VERIFIED", isSuppressed: false },
    ]);
    expect(picked).toMatchObject({ number: "493078001738", kind: "LANDLINE" });
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

/**
 * AUTO-mode scheduling math. The window is expressed in the *user's* local
 * clock via a timezone offset, and getting that wrong means sending at 3am —
 * exactly the behaviour the mode exists to prevent.
 */
describe("auto-mode scheduling", () => {
  // 10:30 UTC on a fixed date.
  const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 25, h, m));
  const auto = (over) => ({ mode: "AUTO", windowStart: 9, windowEnd: 18, tzOffsetMinutes: 0, dailyLimit: 40, ...over });

  it("localHour shifts by the timezone offset, wrapping across midnight", () => {
    expect(localHour(0, at(10, 30))).toBeCloseTo(10.5);
    expect(localHour(300, at(10, 30))).toBeCloseTo(15.5);   // UTC+5 (Karachi)
    expect(localHour(-420, at(2, 0))).toBeCloseTo(19);      // UTC-7 wraps to previous evening
    expect(localHour(300, at(22, 0))).toBeCloseTo(3);       // wraps past midnight forward
  });

  it("window check honours the local clock, not the server clock", () => {
    // 06:00 UTC is 11:00 in Karachi — inside a 9–18 window.
    expect(isWithinSendWindow(auto({ tzOffsetMinutes: 300 }), at(6))).toBe(true);
    // 16:00 UTC is 21:00 in Karachi — after hours.
    expect(isWithinSendWindow(auto({ tzOffsetMinutes: 300 }), at(16))).toBe(false);
    // Start is inclusive, end exclusive.
    expect(isWithinSendWindow(auto(), at(9))).toBe(true);
    expect(isWithinSendWindow(auto(), at(18))).toBe(false);
  });

  it("DIRECT campaigns ignore the window entirely", () => {
    expect(isWithinSendWindow({ mode: "DIRECT" }, at(3))).toBe(true);
  });

  it("autoGapSeconds spreads the daily quota across the window with bounded jitter", () => {
    // 9h window / 40 per day = 810s base; jitter keeps it within 75%-125%.
    const c = auto();
    expect(autoGapSeconds(c, 0)).toBe(Math.round(810 * 0.75));
    expect(autoGapSeconds(c, 1)).toBe(Math.round(810 * 1.25));
    // Never faster than a minute, whatever the inputs.
    expect(autoGapSeconds(auto({ dailyLimit: 150, windowStart: 9, windowEnd: 10 }), 0)).toBeGreaterThanOrEqual(60);
  });

  it("startOfLocalToday is the local midnight expressed as a UTC instant", () => {
    // 01:00 UTC on the 25th is 06:00 on the 25th in Karachi, whose local
    // midnight was 19:00 UTC on the 24th.
    expect(startOfLocalToday(300, at(1)).toISOString()).toBe("2026-08-24T19:00:00.000Z");
    // Same instant in UTC-7 is still the 24th locally.
    expect(startOfLocalToday(-420, at(1)).toISOString()).toBe("2026-08-24T07:00:00.000Z");
  });
});

describe("send-day rules", () => {
  // 2026-08-25 is a Tuesday. 22:00 UTC that day is already Wednesday in Karachi.
  const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 25, h, m));
  const auto = (over) => ({ mode: "AUTO", windowStart: 9, windowEnd: 18, tzOffsetMinutes: 0, dailyLimit: 40, ...over });

  it("localWeekday follows the campaign's clock across midnight", () => {
    expect(localWeekday(0, at(10))).toBe(2);       // Tuesday
    expect(localWeekday(300, at(22))).toBe(3);     // Wednesday in UTC+5
    expect(localWeekday(-420, at(3))).toBe(1);     // still Monday evening in UTC-7
  });

  it("sendDaysOf treats null, empty and junk as every day, and de-duplicates", () => {
    expect(sendDaysOf({ sendDays: null })).toEqual(ALL_DAYS);
    expect(sendDaysOf({ sendDays: [] })).toEqual(ALL_DAYS);
    expect(sendDaysOf({ sendDays: ["x", 9, -1] })).toEqual(ALL_DAYS);
    expect(sendDaysOf({ sendDays: [5, 1, 1, 3] })).toEqual([1, 3, 5]);
  });

  it("isSendDay keeps weekends quiet for a Mon–Fri campaign, in local time", () => {
    const weekdays = auto({ sendDays: [1, 2, 3, 4, 5] });
    expect(isSendDay(weekdays, at(10))).toBe(true);                            // Tuesday
    expect(isSendDay(weekdays, new Date(Date.UTC(2026, 7, 29, 10)))).toBe(false); // Saturday
    // Friday 21:00 UTC is Saturday morning in Sydney (UTC+10).
    expect(isSendDay(auto({ sendDays: [1, 2, 3, 4, 5], tzOffsetMinutes: 600 }), new Date(Date.UTC(2026, 7, 28, 21)))).toBe(false);
    // A Gulf week sends on Sunday and rests on Friday.
    const gulf = auto({ sendDays: [0, 1, 2, 3, 4] });
    expect(isSendDay(gulf, new Date(Date.UTC(2026, 7, 30, 10)))).toBe(true);   // Sunday
    expect(isSendDay(gulf, new Date(Date.UTC(2026, 7, 28, 10)))).toBe(false);  // Friday
  });

  it("DIRECT campaigns ignore the calendar, and old AUTO rows without sendDays send every day", () => {
    expect(isSendDay({ mode: "DIRECT", sendDays: [1] }, new Date(Date.UTC(2026, 7, 29, 10)))).toBe(true);
    expect(isSendDay(auto(), new Date(Date.UTC(2026, 7, 29, 10)))).toBe(true);
  });

  it("isWithinSendWindow now needs both the day and the hour", () => {
    const weekdays = auto({ sendDays: [1, 2, 3, 4, 5] });
    expect(isWithinSendWindow(weekdays, at(10))).toBe(true);
    expect(isWithinSendWindow(weekdays, at(20))).toBe(false);                             // right day, wrong hour
    expect(isWithinSendWindow(weekdays, new Date(Date.UTC(2026, 7, 29, 10)))).toBe(false); // right hour, Saturday
  });

  it("isFutureStart only counts a start clearly after now", () => {
    const now = at(10);
    expect(isFutureStart(null, now)).toBe(false);
    expect(isFutureStart(new Date("nope"), now)).toBe(false);
    expect(isFutureStart(at(9), now)).toBe(false);          // past
    expect(isFutureStart(at(10, 0), now)).toBe(false);      // "now"
    expect(isFutureStart(new Date(now.getTime() + 30_000), now)).toBe(false); // inside the grace minute
    expect(isFutureStart(at(10, 2), now)).toBe(true);
  });
});

describe("sender budget", () => {
  it("recommends the standard volume on a healthy, idle mailbox", () => {
    expect(recommendDailyLimit({ hardCap: 150, committed: 0 })).toEqual({ recommended: 40, headroom: 150, fullyBooked: false });
  });

  it("never recommends more than the warm-up cap", () => {
    expect(recommendDailyLimit({ hardCap: 10, committed: 0 })).toMatchObject({ recommended: 10, headroom: 10 });
  });

  it("leaves room for the campaigns already running on the sender", () => {
    expect(recommendDailyLimit({ hardCap: 150, committed: 120 })).toMatchObject({ recommended: 30, headroom: 30, fullyBooked: false });
    // Over-committed: the floor is still a usable number, but the caller is told.
    expect(recommendDailyLimit({ hardCap: 150, committed: 150 })).toEqual({ recommended: MIN_DAILY_LIMIT, headroom: 0, fullyBooked: true });
  });

  it("falls back to the standard when the cap is not a number", () => {
    expect(recommendDailyLimit({ hardCap: Infinity })).toMatchObject({ recommended: 40 });
  });

  it("warmupStage reports the day and the cap while ramping, null afterwards", () => {
    const now = new Date(Date.UTC(2026, 7, 25));
    const started = (daysAgo) => ({ warmupStartedAt: new Date(now.getTime() - daysAgo * 86_400_000) });
    expect(warmupStage(started(0), now)).toEqual({ day: 1, cap: 5, daysLeft: 20 });
    expect(warmupStage(started(7), now)).toEqual({ day: 8, cap: 20, daysLeft: 13 });
    expect(warmupStage(started(30), now)).toBeNull();
    expect(warmupStage({ warmupStartedAt: null }, now)).toBeNull();
  });
});
