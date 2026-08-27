/**
 * Which number do we try on WhatsApp?
 *
 * Until this module existed the answer was decided in three separate places —
 * the bulk campaign builder, the lead card and the research grid — and they
 * disagreed. The campaign builder took the first VERIFIED phone, the lead card
 * took whatever phone came back first, and none of them could tell a mobile
 * from a switchboard. That is how a Berlin landline (+49 30 …) ended up being
 * WhatsApped: it was simply the first phone number on the record.
 *
 * The rule, in one place:
 *
 *   1. An explicit wa.me / api.whatsapp.com link — the business publishing the
 *      number it actually answers on WhatsApp. Nothing beats being told.
 *   2. A number that looks like a mobile line.
 *   3. A number whose country we cannot classify.
 *   4. A number we can positively tell is a landline.
 *
 * Nothing is ever discarded — a landline still gets used when it is all there
 * is. This orders the attempt; it does not shorten the list.
 */

import { callingCodeFor, detectCallingCode } from "../../utils/countries.js";

/**
 * Calling code → the national-number prefixes that mean "mobile".
 *
 * A country appears here only where the distinction is real and stable. The
 * NANP (+1) is deliberately absent: US and Canadian numbers carry no
 * mobile/landline signal whatsoever, and guessing would be worse than saying
 * we cannot tell. Anything unlisted lands in UNKNOWN, which is ranked *above*
 * a known landline — an unclassified number is a maybe, not a no.
 */
const MOBILE_PREFIXES = {
  20: ["10", "11", "12", "15"],                                                  // Egypt
  27: ["6", "7", "8"],                                                            // South Africa
  31: ["6"],                                                                      // Netherlands
  33: ["6", "7"],                                                                 // France
  34: ["6", "7"],                                                                 // Spain
  39: ["3"],                                                                      // Italy
  44: ["7"],                                                                      // United Kingdom
  48: ["45", "50", "51", "53", "57", "60", "66", "69", "72", "73", "78", "79", "88"], // Poland
  49: ["15", "16", "17"],                                                         // Germany
  60: ["1"],                                                                      // Malaysia
  62: ["8"],                                                                      // Indonesia
  65: ["8", "9"],                                                                 // Singapore
  66: ["6", "8", "9"],                                                            // Thailand
  90: ["5"],                                                                      // Türkiye
  91: ["6", "7", "8", "9"],                                                       // India
  92: ["3"],                                                                      // Pakistan
  212: ["6", "7"],                                                                // Morocco
  234: ["7", "8", "9"],                                                           // Nigeria
  254: ["1", "7"],                                                                // Kenya
  351: ["9"],                                                                     // Portugal
  961: ["3", "7"],                                                                // Lebanon
  962: ["7"],                                                                     // Jordan
  964: ["7"],                                                                     // Iraq
  965: ["5", "6", "9"],                                                           // Kuwait
  966: ["5"],                                                                     // Saudi Arabia
  968: ["7", "9"],                                                                // Oman
  971: ["5"],                                                                     // UAE
  973: ["3", "6"],                                                                // Bahrain
  974: ["3", "5", "6", "7"],                                                      // Qatar
};

/** WhatsApp needs bare digits; every source formats them differently. */
export const phoneDigits = (value) => String(value ?? "").replace(/\D/g, "");

/** A number is only worth trying if it could be a real subscriber line. */
export const isDialable = (value) => {
  const digits = phoneDigits(value);
  return digits.length >= 7 && digits.length <= 15;
};

/**
 * MOBILE | LANDLINE | UNKNOWN.
 *
 * Classified from the country code where we have a rule for it. The trunk
 * prefix is stripped first, because sources write the same German number as
 * `+49 171 …` and `+49 (0)171 …` and both must read as mobile.
 */
export const phoneLineKind = (value, countryCode = null) => {
  const digits = phoneDigits(value);
  if (digits.length < 7) return "UNKNOWN";

  const classify = (cc, national) => {
    const prefixes = MOBILE_PREFIXES[cc];
    if (!prefixes) return null;
    const trimmed = national.replace(/^0+/, "");
    if (!trimmed) return null;
    return prefixes.some((p) => trimmed.startsWith(p)) ? "MOBILE" : "LANDLINE";
  };

  // Longest calling code first: 966 must win over 96 and 9.
  for (const len of [3, 2, 1]) {
    const verdict = classify(digits.slice(0, len), digits.slice(len));
    if (verdict) return verdict;
  }

  // No recognisable calling code. If the number was written nationally — a
  // leading trunk 0, or simply too short to carry one — read it against the
  // company's own country before giving up.
  const home = callingCodeFor(countryCode);
  if (home) {
    const verdict = classify(home, digits);
    if (verdict) return verdict;
  }
  return "UNKNOWN";
};

/** Lower sorts first. */
const KIND_RANK = { MOBILE: 1, UNKNOWN: 2, LANDLINE: 3 };
const CONFIDENCE_RANK = { VERIFIED: 0, DETECTED: 1, INFERRED: 2, AI_GENERATED: 3 };

/**
 * Every number worth trying for this company, best first.
 *
 * Each entry carries `number` (canonical digits, what actually gets dialled),
 * `display` (the value as recorded, so logs and error messages stay readable),
 * and `why` — a short phrase the UI can show so "we tried this one" is never a
 * mystery.
 *
 * @param {Array<{kind:string, roleHint?:string, value:string, confidenceLevel?:string, isSuppressed?:boolean}>} contacts
 * @param {string|null} countryCode ISO alpha-2 of the company, used to classify
 *   numbers written without an international prefix.
 */
export const rankWhatsAppCandidates = (contacts = [], countryCode = null) => {
  const seen = new Set();
  const out = [];

  const add = (contact, { source, tier, kind, why }) => {
    if (contact.isSuppressed) return;
    if (!isDialable(contact.value)) return;
    // The same line reaches us from the website and from a directory in two
    // different formats; dedupe on what will actually be dialled.
    const number = phoneDigits(contact.value);
    if (seen.has(number)) return;
    seen.add(number);
    out.push({
      number,
      // A wa.me URL is not something to print back at a user in an error or a
      // campaign log; show the number it encodes.
      display: source === "WHATSAPP_LINK" ? `+${number}` : String(contact.value).trim(),
      source,
      kind,
      why,
      confidenceLevel: contact.confidenceLevel || "DETECTED",
      tier,
      confidenceRank: CONFIDENCE_RANK[contact.confidenceLevel] ?? 1,
    });
  };

  for (const c of contacts) {
    if (c.kind === "SOCIAL" && c.roleHint === "WHATSAPP") {
      add(c, { source: "WHATSAPP_LINK", tier: 0, kind: "MOBILE", why: "Published as a WhatsApp link" });
    }
  }
  for (const c of contacts) {
    if (c.kind !== "PHONE") continue;
    const kind = phoneLineKind(c.value, countryCode);
    add(c, {
      source: "PHONE",
      tier: KIND_RANK[kind],
      kind,
      why: kind === "MOBILE" ? "Mobile number"
        : kind === "LANDLINE" ? "Landline — unlikely to be on WhatsApp"
        : "Number type unknown",
    });
  }

  return out
    .sort((a, b) => a.tier - b.tier || a.confidenceRank - b.confidenceRank)
    .map(({ tier, confidenceRank, ...keep }) => keep);
};

/**
 * The single best number, or null when there is nothing to try.
 *
 * Kept as its own export because most callers only ever want the first one, and
 * `rank(...)[0] || null` at every call site is how the three copies of this
 * decision drifted apart in the first place.
 */
export const pickWhatsAppNumber = (contacts = [], countryCode = null) =>
  rankWhatsAppCandidates(contacts, countryCode)[0] || null;

/**
 * The best number to *display* on a lead card, ranked by the same rules.
 * Callers that just want "the phone number" should use this rather than
 * reaching for the first PHONE row.
 */
export const pickDisplayPhone = (contacts = [], countryCode = null) => {
  const phones = contacts.filter((c) => c.kind === "PHONE" && !c.isSuppressed);
  return rankWhatsAppCandidates(phones, countryCode)[0] || null;
};

/**
 * The one stored form of a phone number.
 *
 * The same line reaches us as `+49 30 78001738` (Google Places),
 * `+493078001738` (our crawler), `+49 (0)30 780 017 38` (JSON-LD),
 * `+49 30 78001738` (OpenStreetMap) and `030 78001738` (Places' national
 * fallback). `Contact` is unique on the raw string, so before this existed each
 * spelling became its own row — five "contacts" for one telephone, each
 * separately MX-checked, separately counted, and separately offered to the
 * sender.
 *
 * Produces E.164 (`+493078001738`) whenever the country can be established,
 * from the number itself or from the company it belongs to. Falls back to bare
 * digits rather than guessing, and returns the input untouched if it is not a
 * usable number at all — normalisation must never destroy data it cannot parse.
 */
export const canonicalPhone = (value, countryCode = null) => {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;

  const hasPlus = raw.trimStart().startsWith("+") || raw.trimStart().startsWith("00");
  const digits = phoneDigits(raw);
  if (digits.length < 7 || digits.length > 15) return raw;

  // Written internationally: trust the number's own prefix, and drop a trunk
  // zero written after it ("+49 (0)30 …" is the same line as "+49 30 …").
  if (hasPlus) {
    const cc = detectCallingCode(digits);
    if (!cc) return `+${digits}`;
    const national = digits.slice(cc.length).replace(/^0+/, "");
    return national ? `+${cc}${national}` : `+${digits}`;
  }

  // Written nationally: only the company's own country can supply the prefix.
  const home = callingCodeFor(countryCode);
  if (home) {
    const national = digits.replace(/^0+/, "");
    // Guard against a number that already carries its own country code but was
    // written without a plus — prefixing again would corrupt it.
    if (!digits.startsWith(home)) return `+${home}${national}`;
    return `+${digits}`;
  }
  return digits;
};

/** The one stored form of an email address. */
export const canonicalEmail = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  return raw.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
};
