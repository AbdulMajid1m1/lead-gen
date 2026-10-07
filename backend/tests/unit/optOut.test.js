import { describe, it, expect } from "vitest";
import { classifyOptOut, freshText } from "../../lib/outreach/optOut.js";

/**
 * Our footer promises that a "no" ends it. The first two cases are the real
 * replies from the dental lane that reached REPLIED and nothing more; the rest
 * pin the other direction — an interested person who happens to open with
 * "no" must never be suppressed.
 */

// Our own footer, as it comes back quoted under every reply.
const QUOTED_FOOTER = `On Thu, 1 Oct 2026, 15:00 Zubair Khan, <zubair.khan@deventiahq.com> wrote:
> Hello,
>
> Happy to send the short list over — a one-word reply is enough. And if the
> timing is wrong, "not now" is a completely fine answer.
>
> Not relevant? Reply "no" and I will not write again.
>`;

describe("classifyOptOut — the real replies", () => {
  it("files TAHA Dental's 'Unsubscribe' as UNSUBSCRIBE", () => {
    const body = `Unsubscribe\n\nOn Sat, 3 Oct 2026 at 14:30, Zubair Khan <zubair.khan@deventiahq.com> wrote:\n> Hello,\n> Not relevant? Reply "no" and I will not write again.\n>`;
    expect(classifyOptOut({ body })).toMatchObject({ isOptOut: true, kind: "UNSUBSCRIBE" });
  });

  it("files Syston Chiropractic's 'No thank you. I'm happy as I am..' as DECLINE", () => {
    const body = `No thank you. I'm happy as I am..\n${QUOTED_FOOTER}`;
    expect(classifyOptOut({ body })).toMatchObject({ isOptOut: true, kind: "DECLINE" });
  });
});

describe("classifyOptOut — other ways people say it", () => {
  it.each([
    ["Please remove me from your mailing list", "UNSUBSCRIBE"],
    ["Take us off your list please.", "UNSUBSCRIBE"],
    ["Stop emailing me.", "UNSUBSCRIBE"],
    ["Please don't contact us again", "UNSUBSCRIBE"],
    ["STOP", "UNSUBSCRIBE"],
    ["opt out", "UNSUBSCRIBE"],
    ["No", "DECLINE"],
    ["no.", "DECLINE"],
    ["Nope, thanks", "DECLINE"],
    ["No thanks, we have a web person.", "DECLINE"],
    ["Thanks but no thanks", "DECLINE"],
    ["We're not interested at this time.", "DECLINE"],
    ["Not interested", "DECLINE"],
    ["Not relevant", "DECLINE"],
    ["No, we're happy with our current provider", "DECLINE"],
  ])("%s → %s", (body, kind) => {
    expect(classifyOptOut({ body })).toMatchObject({ isOptOut: true, kind });
  });
});

describe("classifyOptOut — interested people are left alone", () => {
  it.each([
    "Yes please, send the video",
    "No problem, send it over",
    "No worries — what does it cost?",
    "Not now, maybe in January",
    "Sure. We don't have online booking, how long does it take?",
    "I don't email much, call me on 07700 900123",
    "Who is this?",
    "",
  ])("%j is not an opt-out", (fresh) => {
    expect(classifyOptOut({ body: `${fresh}\n${QUOTED_FOOTER}` }).isOptOut).toBe(false);
  });

  it("never reads our own quoted footer as their answer", () => {
    expect(classifyOptOut({ body: `Yes\n${QUOTED_FOOTER}` }).isOptOut).toBe(false);
    expect(classifyOptOut({ body: QUOTED_FOOTER }).isOptOut).toBe(false);
  });
});

describe("freshText", () => {
  it("cuts at a Gmail attribution line that wraps", () => {
    const body = "Sounds good\n\nOn Thu, 1 Oct 2026 at 15:00, Zubair Khan <\nzubair.khan@deventiahq.com> wrote:\n> Hi";
    expect(freshText(body)).toBe("Sounds good");
  });

  it("cuts at an Outlook header block", () => {
    const body = "Not interested.\n\nFrom: Zubair Khan <zubair.khan@deventiahq.com>\nSent: 01 October 2026 15:00\nTo: info@example.co.uk";
    expect(freshText(body)).toBe("Not interested.");
  });

  it("returns the whole message when nothing is quoted", () => {
    expect(freshText("  STOP  ")).toBe("STOP");
  });
});
