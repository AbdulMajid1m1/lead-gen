import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The guard against a second first-contact.
 *
 * Stubbed down to the two things the decision reads — the lead and its email
 * threads — plus a mailer that refuses, so execution stops just past the gate
 * and the assertion is about which check spoke, not about SMTP.
 */
const thread = { findFirst: vi.fn() };
const lead = { findUnique: vi.fn() };

vi.mock("../../prismaClient.js", () => ({
  default: {
    lead,
    outreachThread: thread,
    suppressionEntry: { findFirst: vi.fn().mockResolvedValue(null) },
    contact: { findFirst: vi.fn().mockResolvedValue(null) },
    signature: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("../../lib/outreach/mailer.js", () => ({
  sendMail: vi.fn().mockResolvedValue({ ok: false, error: "SMTP refused" }),
  verifySmtp: vi.fn(),
}));

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

describe("sendInitialEmail — the duplicate first-contact guard", () => {
  let sendInitialEmail;
  const account = { id: "a1", email: "z@deventiahq.com", maxFollowUps: 3 };

  beforeEach(async () => {
    vi.clearAllMocks();
    lead.findUnique.mockResolvedValue({ id: "l1", status: "NEW", companyId: "c1", company: { countryCode: "GB" } });
    ({ sendInitialEmail } = await import("../../lib/outreach/service.js"));
  });

  it("refuses when the lead was emailed days ago by another campaign", async () => {
    thread.findFirst.mockResolvedValue({ lastOutboundAt: daysAgo(4), recipientEmail: "info@practice.co.uk" });
    const res = await sendInitialEmail({ account, leadId: "l1", to: "info@practice.co.uk", subject: "s", body: "b" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("4 days ago");
    expect(res.error).toContain("info@practice.co.uk");
    // The drain routes anything without "failed" in it to SKIPPED, which is
    // what this is — a decision, not a breakage to retry.
    expect(res.error).not.toMatch(/failed/i);
  });

  it("says 'today' rather than '0 days ago'", async () => {
    thread.findFirst.mockResolvedValue({ lastOutboundAt: new Date(), recipientEmail: "hi@acme.co.uk" });
    const res = await sendInitialEmail({ account, leadId: "l1", to: "hi@acme.co.uk", subject: "s", body: "b" });
    expect(res.error).toContain("today");
  });

  it("lets the send through when nothing recent exists", async () => {
    // A thread older than the window is not returned by the query at all, so
    // the absence here is the same thing the database would report.
    thread.findFirst.mockResolvedValue(null);
    const res = await sendInitialEmail({ account, leadId: "l1", to: "hi@acme.co.uk", subject: "s", body: "b" });
    expect(res.ok).toBe(false);
    // Reached the mailer: the guard did not stand in the way.
    expect(res.error).toMatch(/SMTP refused/);
  });

  it("only looks at email threads, and only inside the window", async () => {
    thread.findFirst.mockResolvedValue(null);
    await sendInitialEmail({ account, leadId: "l1", to: "hi@acme.co.uk", subject: "s", body: "b" });
    const where = thread.findFirst.mock.calls[0][0].where;
    expect(where.channel).toBe("EMAIL");
    expect(where.leadId).toBe("l1");
    const cutoff = where.lastOutboundAt.gte.getTime();
    expect(Math.round((Date.now() - cutoff) / 86400000)).toBe(30);
  });
});
