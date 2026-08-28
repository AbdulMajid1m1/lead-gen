import { describe, it, expect } from "vitest";
import {
  classifyBounce, shouldPauseForBounces, warmupDailyCap,
  BOUNCE_PAUSE_THRESHOLD, MIN_SAMPLE_BEFORE_PAUSE, NO_WARMUP_LIMIT,
} from "../../lib/outreach/deliverability.js";

/**
 * Post-send deliverability.
 *
 * Two mistakes are possible here and they are not symmetrical. Calling a real
 * reply a bounce, or a soft bounce hard, suppresses a live prospect for good
 * and nobody ever finds out. Missing a bounce only costs one more send. Every
 * case below is pinned in that direction: strong evidence to condemn an
 * address, none needed to leave it alone.
 */

const gmailReport = {
  from: "mailer-daemon@googlemail.com",
  subject: "Delivery Status Notification (Failure)",
  headers: [
    "Content-Type: multipart/report; report-type=delivery-status;",
    '\tboundary="000000000000a1b2c3"',
    "Return-Path: <>",
    "In-Reply-To: <initial-abc123@leadsignal.local>",
  ].join("\n"),
  body: [
    "** Address not found **",
    "",
    "Your message wasn't delivered to hello@nowhere-ltd.co.uk because the address couldn't be found.",
    "",
    "Reporting-MTA: dns; googlemail.com",
    "Final-Recipient: rfc822; hello@nowhere-ltd.co.uk",
    "Action: failed",
    "Status: 5.1.1",
    "Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.",
  ].join("\n"),
};

const outlookReport = {
  from: "postmaster@contoso.com",
  subject: "Undeliverable: Quick question about your fleet software",
  headers: [
    "Content-Type: multipart/report; report-type=delivery-status; boundary=\"_000_ab_\"",
    "In-Reply-To: <initial-def456@leadsignal.local>",
  ].join("\n"),
  body: [
    "Your message to jane.doe@contoso.com couldn't be delivered.",
    "jane.doe wasn't found at contoso.com.",
    "",
    "Final-Recipient: rfc822; jane.doe@contoso.com",
    "Action: failed",
    "Status: 5.1.10",
    "Diagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup",
  ].join("\n"),
};

const postfixReport = {
  from: "MAILER-DAEMON@mail.hosting.example",
  // Postfix's own wording matches none of the provider subject lines — this one
  // is caught by the sender and the null return path instead.
  subject: "Undelivered Mail Returned to Sender",
  headers: "Content-Type: multipart/report; report-type=delivery-status\nReturn-Path: <>",
  body: [
    "This is the mail system at host mail.hosting.example.",
    "",
    "<sales@dead-domain.example>: host mx.dead-domain.example said: 550 5.1.1",
    "    <sales@dead-domain.example>: Recipient address rejected: User unknown in",
    "    virtual mailbox table (in reply to RCPT TO command)",
    "",
    "Final-Recipient: rfc822; sales@dead-domain.example",
    "Action: failed",
    "Status: 5.1.1",
  ].join("\n"),
};

describe("classifyBounce — recognising a report", () => {
  it("reads a Gmail non-delivery report", () => {
    const result = classifyBounce(gmailReport);
    expect(result.isBounce).toBe(true);
    expect(result.type).toBe("HARD");
    expect(result.code).toBe("5.1.1");
    expect(result.recipient).toBe("hello@nowhere-ltd.co.uk");
    expect(result.reason).toMatch(/does not exist/i);
  });

  it("reads an Outlook report", () => {
    const result = classifyBounce(outlookReport);
    expect(result).toMatchObject({ isBounce: true, type: "HARD", code: "5.1.10", recipient: "jane.doe@contoso.com" });
  });

  it("reads a Postfix report whose subject matches nothing", () => {
    // The From and the empty return path carry it. A rule that leaned only on
    // subject wording would file this one as a reply.
    const result = classifyBounce(postfixReport);
    expect(result).toMatchObject({ isBounce: true, type: "HARD", code: "5.1.1", recipient: "sales@dead-domain.example" });
  });

  it("recognises a report by its DSN fields when the envelope looks ordinary", () => {
    const result = classifyBounce({
      from: "bounces@relay.example",
      subject: "Message delivery report",
      headers: "Content-Type: text/plain",
      body: "Final-Recipient: rfc822; ops@gone.example\nAction: failed\nStatus: 5.1.1\n",
    });
    expect(result.isBounce).toBe(true);
  });
});

describe("classifyBounce — a real reply is never a bounce", () => {
  it("leaves a genuine reply alone", () => {
    const result = classifyBounce({
      from: "jane.doe@contoso.com",
      subject: "Re: Quick question about your fleet software",
      headers: "Content-Type: text/plain; charset=UTF-8\nIn-Reply-To: <initial-def456@leadsignal.local>",
      body: "Thanks for getting in touch — we're reviewing options this quarter. Can you send pricing?",
    });
    expect(result).toEqual({ isBounce: false, type: null, code: null, recipient: null, reason: null });
  });

  it("is not fooled by a version number that looks like a status code", () => {
    // "5.1.1" in prose must not condemn the address that wrote it.
    const result = classifyBounce({
      from: "dev@client.example",
      subject: "Re: integration",
      headers: "Content-Type: text/plain",
      body: "We're still on 5.1.1 of the old SDK, the upgrade does not exist on our roadmap yet.",
    });
    expect(result.isBounce).toBe(false);
  });

  it("is not fooled by a reply quoting a bounce subject", () => {
    const result = classifyBounce({
      from: "ops@client.example",
      subject: "Re: Undeliverable: Quick question",
      headers: "Content-Type: text/plain",
      body: "That address was wrong, use ops@client.example instead.",
    });
    expect(result.isBounce).toBe(false);
  });
});

describe("classifyBounce — hard versus soft", () => {
  it("treats a 4.x.x report as soft", () => {
    const result = classifyBounce({
      from: "mailer-daemon@mail.hosting.example",
      subject: "Delivery Status Notification (Delay)",
      headers: "Return-Path: <>",
      body: "Final-Recipient: rfc822; ops@busy.example\nAction: delayed\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 4.2.2 Mailbox full",
    });
    expect(result).toMatchObject({ isBounce: true, type: "SOFT", code: "4.2.2" });
  });

  it("treats a full mailbox as soft even when the server calls it 5.2.2", () => {
    // Nothing is wrong with the address; suppressing it would lose a live
    // prospect for being on holiday with a full inbox.
    const result = classifyBounce({
      from: "postmaster@corp.example",
      subject: "Undeliverable: following up",
      headers: "Content-Type: multipart/report; report-type=delivery-status",
      body: "Final-Recipient: rfc822; director@corp.example\nAction: failed\nStatus: 5.2.2\nDiagnostic-Code: smtp; 552 5.2.2 The recipient's mailbox is full and over quota.",
    });
    expect(result.type).toBe("SOFT");
  });

  it("condemns an address on unambiguous wording when no code was given", () => {
    const result = classifyBounce({
      from: "MAILER-DAEMON@mail.hosting.example",
      subject: "Failure notice",
      headers: "Return-Path: <>",
      body: "Sorry, we were unable to deliver your message to <bob@gone.example>.\nNo such user here.",
    });
    expect(result).toMatchObject({ isBounce: true, type: "HARD" });
  });

  it("defaults to soft when the report says nothing conclusive", () => {
    const result = classifyBounce({
      from: "mailer-daemon@mail.hosting.example",
      subject: "Returned mail",
      headers: "Return-Path: <>",
      body: "Your message could not be delivered at this time.",
    });
    expect(result).toMatchObject({ isBounce: true, type: "SOFT", code: null });
  });

  it("prefers soft when hard and soft wording appear together", () => {
    // A greylisting notice that quotes an earlier "user unknown" line must not
    // be read as proof the mailbox is gone.
    const result = classifyBounce({
      from: "mailer-daemon@mail.hosting.example",
      subject: "Delivery Status Notification (Failure)",
      headers: "Return-Path: <>",
      body: "Greylisted, try again later. Earlier attempt reported: user unknown.",
    });
    expect(result.type).toBe("SOFT");
  });
});

describe("warmupDailyCap", () => {
  const at = (day) => new Date(Date.UTC(2026, 0, 1) + (day - 1) * 86_400_000);
  const account = { warmupStartedAt: new Date(Date.UTC(2026, 0, 1)) };

  it("opens at five a day", () => {
    expect(warmupDailyCap(account, { now: at(1) })).toBe(5);
    expect(warmupDailyCap(account, { now: at(2) })).toBe(5);
  });

  it("climbs through the ramp", () => {
    expect(warmupDailyCap(account, { now: at(3) })).toBe(10);
    expect(warmupDailyCap(account, { now: at(7) })).toBe(20);
    expect(warmupDailyCap(account, { now: at(12) })).toBe(35);
    expect(warmupDailyCap(account, { now: at(18) })).toBe(50);
  });

  it("never goes backwards", () => {
    const caps = Array.from({ length: 20 }, (_, i) => warmupDailyCap(account, { now: at(i + 1) }));
    for (let i = 1; i < caps.length; i += 1) expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]);
  });

  it("lifts the limit entirely at three weeks", () => {
    expect(warmupDailyCap(account, { now: at(21) })).toBe(NO_WARMUP_LIMIT);
    expect(warmupDailyCap(account, { now: at(90) })).toBe(NO_WARMUP_LIMIT);
  });

  it("does not apply to a mailbox that is not warming up", () => {
    // The caller does Math.min(cap, this), so a mailbox with no warm-up must
    // come back with something that cannot lower the normal cap.
    expect(warmupDailyCap({ warmupStartedAt: null })).toBe(NO_WARMUP_LIMIT);
    expect(warmupDailyCap({})).toBe(NO_WARMUP_LIMIT);
    expect(warmupDailyCap(null)).toBe(NO_WARMUP_LIMIT);
    expect(Math.min(150, warmupDailyCap({ warmupStartedAt: null }))).toBe(150);
  });

  it("treats a start date in the future as day one rather than as no limit", () => {
    expect(warmupDailyCap({ warmupStartedAt: at(30) }, { now: at(1) })).toBe(5);
  });
});

describe("shouldPauseForBounces", () => {
  it("pauses at the threshold", () => {
    expect(shouldPauseForBounces({ rate: BOUNCE_PAUSE_THRESHOLD, sample: 200 })).toBe(true);
    expect(shouldPauseForBounces({ rate: 0.08, sample: 100 })).toBe(true);
  });

  it("leaves a campaign below the threshold running", () => {
    expect(shouldPauseForBounces({ rate: 0.029, sample: 200 })).toBe(false);
    expect(shouldPauseForBounces({ rate: 0, sample: 500 })).toBe(false);
  });

  it("refuses to act on a sample too small to mean anything", () => {
    // One bounce in five reads as 20% and is nothing but a typo.
    expect(shouldPauseForBounces({ rate: 0.2, sample: 5 })).toBe(false);
    expect(shouldPauseForBounces({ rate: 1, sample: MIN_SAMPLE_BEFORE_PAUSE - 1 })).toBe(false);
    expect(shouldPauseForBounces({ rate: 0.2, sample: MIN_SAMPLE_BEFORE_PAUSE })).toBe(true);
  });

  it("never pauses on a rate it cannot read", () => {
    expect(shouldPauseForBounces({ rate: NaN, sample: 100 })).toBe(false);
    expect(shouldPauseForBounces({})).toBe(false);
    expect(shouldPauseForBounces()).toBe(false);
  });
});
