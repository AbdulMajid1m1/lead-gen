import { describe, it, expect } from "vitest";
import { threadHeaders } from "../../lib/outreach/mailer.js";

/**
 * These two headers are the whole of email threading: get them wrong and a
 * reply opens a second conversation in the recipient's client, which reads as a
 * stranger rather than the person they were already talking to.
 */
describe("threadHeaders", () => {
  it("emits nothing for a first message", () => {
    expect(threadHeaders({})).toEqual({});
    expect(threadHeaders({ inReplyTo: null, references: ["<a@x>"] })).toEqual({});
  });

  it("does not repeat the id that is both newest and in-reply-to", () => {
    // The bug this replaced: sendReply passes the whole conversation as
    // references, whose last entry is also the inReplyTo.
    const { references } = threadHeaders({
      inReplyTo: "<b@x>",
      references: ["<a@x>", "<b@x>"],
    });
    expect(references).toEqual(["<a@x>", "<b@x>"]);
  });

  it("keeps the in-reply-to id last, where a client expects it", () => {
    const { references } = threadHeaders({
      inReplyTo: "<newest@x>",
      references: ["<first@x>", "<second@x>"],
    });
    expect(references.at(-1)).toBe("<newest@x>");
    expect(references).toEqual(["<first@x>", "<second@x>", "<newest@x>"]);
  });

  it("carries the in-reply-to through unchanged", () => {
    expect(threadHeaders({ inReplyTo: "<b@x>", references: [] }))
      .toEqual({ inReplyTo: "<b@x>", references: ["<b@x>"] });
  });

  it("drops the gaps left by messages we never recorded an id for", () => {
    const { references } = threadHeaders({
      inReplyTo: "<c@x>",
      references: ["<a@x>", null, undefined, "<b@x>"],
    });
    expect(references).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("collapses a repeated id anywhere in the chain, not just at the end", () => {
    const { references } = threadHeaders({
      inReplyTo: "<c@x>",
      references: ["<a@x>", "<b@x>", "<a@x>"],
    });
    expect(references).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("grows by exactly one id per exchange", () => {
    // Two manual replies in a row: each threads under the previous one, and the
    // chain must not double up as it goes.
    const first = threadHeaders({ inReplyTo: "<them@x>", references: ["<us@x>", "<them@x>"] });
    expect(first.references).toHaveLength(2);

    const second = threadHeaders({
      inReplyTo: "<us-2@x>",
      references: [...first.references, "<us-2@x>"],
    });
    expect(second.references).toEqual(["<us@x>", "<them@x>", "<us-2@x>"]);
  });
});
