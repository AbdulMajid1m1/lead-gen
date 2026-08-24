import { describe, it, expect } from "vitest";
import { senderNumber, toJid } from "../../lib/outreach/whatsapp.js";

/**
 * Resolving who a WhatsApp message actually came from.
 *
 * WhatsApp's LID migration changes `remoteJid` from a phone number to an opaque
 * account id, and the failure it caused was silent: the reply arrived, matched
 * no thread, and was dropped without a log. These cases exist so that cannot
 * happen again unnoticed.
 */

const sockWith = (mapping) => ({
  signalRepository: {
    lidMapping: { getPNForLID: async (lid) => mapping[lid] ?? null },
  },
});

const msg = (remoteJid, extra = {}) => ({ key: { remoteJid, fromMe: false }, ...extra });

describe("senderNumber", () => {
  it("reads the number straight off a classic phone-number JID", async () => {
    expect(await senderNumber(sockWith({}), msg("923189809338@s.whatsapp.net"))).toBe("923189809338");
  });

  it("strips the device suffix a multi-device JID carries", async () => {
    expect(await senderNumber(sockWith({}), msg("923189809338:12@s.whatsapp.net"))).toBe("923189809338");
  });

  it("resolves a LID back to the phone number through the socket's mapping store", async () => {
    const sock = sockWith({ "244735927128289@lid": "923189809338@s.whatsapp.net" });
    expect(await senderNumber(sock, msg("244735927128289@lid"))).toBe("923189809338");
  });

  it("never mistakes the LID digits for a phone number", async () => {
    // The original bug: 244735927128289 was matched against threads as if it
    // were a number, so every migrated contact's reply went unmatched.
    const resolved = await senderNumber(sockWith({}), msg("244735927128289@lid"));
    expect(resolved).not.toBe("244735927128289");
    expect(resolved).toBeNull();
  });

  it("prefers participantPn when a group message carries it", async () => {
    const sock = sockWith({ "244735927128289@lid": "999999999999@s.whatsapp.net" });
    const m = msg("244735927128289@lid", { participantPn: "923189809338@s.whatsapp.net" });
    expect(await senderNumber(sock, m)).toBe("923189809338");
  });

  it("returns null rather than throwing when the socket has no mapping store", async () => {
    expect(await senderNumber({}, msg("244735927128289@lid"))).toBeNull();
    expect(await senderNumber(undefined, msg("244735927128289@lid"))).toBeNull();
  });

  it("survives a mapping store that throws", async () => {
    const sock = { signalRepository: { lidMapping: { getPNForLID: async () => { throw new Error("closed"); } } } };
    expect(await senderNumber(sock, msg("244735927128289@lid"))).toBeNull();
  });

  it("returns null for a message with no address at all", async () => {
    expect(await senderNumber(sockWith({}), { key: {} })).toBeNull();
  });
});

describe("toJid", () => {
  it("normalises the stored E.164 form used on threads", () => {
    expect(toJid("+923189809338")).toBe("923189809338@s.whatsapp.net");
    expect(toJid("00923189809338")).toBe("923189809338@s.whatsapp.net");
  });
});
