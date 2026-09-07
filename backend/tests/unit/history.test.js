import { describe, it, expect } from "vitest";
import { toHistoryRow } from "../../lib/outreach/service.js";

/**
 * The history row is what answers "who sent this". Everything below is about
 * that one question, because the rest of the row is a straight copy.
 */
const base = {
  id: "m1", threadId: "t1", direction: "OUTBOUND", kind: "INITIAL",
  subject: "your online presence", body: "Hello…", sentAt: new Date("2026-09-06T09:00:00Z"),
  receivedAt: null, createdAt: new Date("2026-09-06T09:00:01Z"), fromAddress: null,
  bounceType: null, bounceCode: null, sentById: null, sentByName: null, sentBy: null,
  thread: {
    id: "t1", channel: "EMAIL", recipientEmail: "info@acme.co.uk", subject: "your online presence",
    status: "AWAITING_REPLY", followUpsSent: 0, nextFollowUpAt: null, repliedAt: null, lastOutboundAt: null,
    account: { id: "a1", email: "zubair@deventiahq.com", displayName: "Zubair" },
    waAccount: null,
    lead: {
      id: "l1", score: 72, status: "CONTACTED", primaryOpportunity: "WEBSITE_DEV",
      company: { name: "Acme Ltd", city: "London", countryCode: "GB" },
      discoveryRun: null,
    },
  },
};

describe("toHistoryRow attribution", () => {
  it("names the person when a console account sent it", () => {
    const row = toHistoryRow({ ...base, sentById: "u1", sentByName: "Aisha", sentBy: { id: "u1", name: "Aisha", email: "a@x.com" } });
    expect(row.sentBy).toEqual({ type: "PERSON", name: "Aisha", id: "u1" });
  });

  it("names the automation when no account is behind it", () => {
    const row = toHistoryRow({ ...base, sentByName: "Autopilot · Gulf" });
    expect(row.sentBy).toEqual({ type: "AUTOMATION", name: "Autopilot · Gulf", id: null });
  });

  it("still says automated for a message sent before the automation named itself", () => {
    expect(toHistoryRow(base).sentBy).toEqual({ type: "AUTOMATION", name: "Automated", id: null });
  });

  it("never claims a sender for an inbound message", () => {
    const row = toHistoryRow({ ...base, direction: "INBOUND", kind: "REPLY", sentAt: null, receivedAt: new Date("2026-09-06T10:00:00Z"), fromAddress: "owner@acme.co.uk" });
    expect(row.sentBy).toBeNull();
    expect(row.at.toISOString()).toBe("2026-09-06T10:00:00.000Z");
  });
});

describe("toHistoryRow shape", () => {
  it("carries the sender, the lead and the product the lead was sourced for", () => {
    const row = toHistoryRow({
      ...base,
      thread: {
        ...base.thread,
        lead: { ...base.thread.lead, discoveryRun: { promotedProduct: { id: "p1", name: "TracefyHR" } } },
      },
    });
    expect(row.sender).toEqual({ kind: "EMAIL", label: "zubair@deventiahq.com" });
    expect(row.lead).toMatchObject({ id: "l1", company: "Acme Ltd", product: "TracefyHR" });
    expect(row.channel).toBe("EMAIL");
  });

  it("reads a WhatsApp row off the device instead of the mailbox", () => {
    const row = toHistoryRow({
      ...base,
      thread: {
        ...base.thread, channel: "WHATSAPP", recipientEmail: "447863374791",
        account: null, waAccount: { id: "d1", label: "Huzaifa UK No", phoneNumber: "447863374791" },
      },
    });
    expect(row.channel).toBe("WHATSAPP");
    expect(row.sender).toEqual({ kind: "WHATSAPP", label: "Huzaifa UK No", phoneNumber: "447863374791" });
  });

  it("surfaces a bounce code and nothing when there is none", () => {
    expect(toHistoryRow({ ...base, kind: "BOUNCE", bounceType: "hard", bounceCode: "5.1.1" }).bounce)
      .toEqual({ type: "hard", code: "5.1.1" });
    expect(toHistoryRow(base).bounce).toBeNull();
  });

  it("survives a message whose thread or lead has been deleted", () => {
    const row = toHistoryRow({ ...base, thread: null });
    expect(row.channel).toBe("EMAIL");
    expect(row.lead).toBeNull();
    expect(row.sender).toBeNull();
    expect(row.recipient).toBeNull();
  });
});
