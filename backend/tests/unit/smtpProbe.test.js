import { describe, it, expect } from "vitest";
import { __testables } from "../../lib/verify/smtpProbe.js";

const { interpretRcptReply, combineVerdicts, takeReply } = __testables;

/**
 * SMTP mailbox probing — the interpretation layer.
 *
 * The wire protocol is not exercised here (no sockets in unit tests); what is
 * pinned is the judgement: which server answers may condemn an address, and
 * which must not. The stakes are asymmetric — a wrongly suppressed real lead
 * costs more than a bounce — so every ambiguous case must land INCONCLUSIVE.
 */

describe("interpretRcptReply — reading one RCPT answer", () => {
  it("accepts a plain 250", () => {
    expect(interpretRcptReply(250, "250 2.1.5 OK")).toBe("ACCEPT");
  });

  it("reads a mailbox-level 550 as a rejection of the mailbox", () => {
    expect(interpretRcptReply(550, "550 5.1.1 The email account that you tried to reach does not exist")).toBe("REJECT_MAILBOX");
    expect(interpretRcptReply(550, "550 No such user here")).toBe("REJECT_MAILBOX");
    expect(interpretRcptReply(551, "551 user not local")).toBe("REJECT_MAILBOX");
  });

  it("reads a policy 5xx as being about us, never about the mailbox", () => {
    // A cold probe IP with no reverse DNS gets these from every strict server.
    // Treating them as "mailbox does not exist" would suppress entire domains.
    expect(interpretRcptReply(550, "550 5.7.1 Service unavailable, client host blocked using Spamhaus")).toBe("REJECT_POLICY");
    expect(interpretRcptReply(550, "550 Access denied - no rDNS for your IP")).toBe("REJECT_POLICY");
    expect(interpretRcptReply(554, "554 transaction failed")).toBe("REJECT_POLICY");
  });

  it("reads any 4xx as a temporary state (greylisting)", () => {
    expect(interpretRcptReply(451, "451 4.7.1 Greylisted, try again later")).toBe("TEMPFAIL");
    expect(interpretRcptReply(450, "450 mailbox busy")).toBe("TEMPFAIL");
  });
});

describe("combineVerdicts — target answer × random-mailbox answer", () => {
  it("a mailbox rejection is definitive regardless of the random probe", () => {
    expect(combineVerdicts("REJECT_MAILBOX", "ACCEPT")).toBe("UNDELIVERABLE");
    expect(combineVerdicts("REJECT_MAILBOX", "REJECT_MAILBOX")).toBe("UNDELIVERABLE");
  });

  it("an accepted target whose domain also accepts a random mailbox proves nothing", () => {
    // Catch-all domains say yes to everything; the target's yes is worthless.
    expect(combineVerdicts("ACCEPT", "ACCEPT")).toBe("ACCEPT_ALL");
  });

  it("an accepted target on a domain that rejects the random mailbox is deliverable", () => {
    expect(combineVerdicts("ACCEPT", "REJECT_MAILBOX")).toBe("DELIVERABLE");
  });

  it("everything ambiguous stays inconclusive — the fail-open contract", () => {
    expect(combineVerdicts("TEMPFAIL", "ACCEPT")).toBe("INCONCLUSIVE");
    expect(combineVerdicts("REJECT_POLICY", "REJECT_MAILBOX")).toBe("INCONCLUSIVE");
  });
});

describe("takeReply — parsing the wire", () => {
  it("waits for the newline before treating a line as a reply", () => {
    // A TCP chunk can end mid-line: "250 O" must not be read as "250 OK".
    expect(takeReply("250 O")).toBeNull();
    expect(takeReply("250 OK\r\n")).toMatchObject({ code: 250 });
  });

  it("skips multi-line continuations and returns the final line", () => {
    const reply = takeReply("250-mx.example.com greets you\r\n250-SIZE 35882577\r\n250 STARTTLS\r\n");
    expect(reply.code).toBe(250);
    expect(reply.text).toContain("STARTTLS");
    expect(reply.rest).toBe("");
  });

  it("hands back the unconsumed remainder for the next reply", () => {
    const reply = takeReply("250 OK\r\n550 no such user\r\n");
    expect(reply.code).toBe(250);
    expect(takeReply(reply.rest)).toMatchObject({ code: 550 });
  });
});
