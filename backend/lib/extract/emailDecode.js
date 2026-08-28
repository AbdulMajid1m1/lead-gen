/**
 * Recovering email addresses that a page deliberately hides.
 *
 * Most small-business sites do not publish `info@acme.de` as plain text — they
 * publish something a naive scraper cannot read, because scrapers are how spam
 * finds them. A harvesting experiment run against every common technique found
 * that HTML entities block ~95% of scrapers, "at"/"dot" munging ~97%, and that
 * SVG text, CSS reversal, JavaScript assembly and images block essentially all
 * of them.
 *
 * This module handles the ones that are recoverable from static HTML. It does
 * not execute JavaScript, so click-gated and XHR-fetched addresses stay out of
 * reach by design.
 *
 * Everything here is decoding what the site itself chose to put on a public
 * page. Nothing constructs an address that was not published.
 */

/** Zero-width and soft-hyphen characters injected mid-address to break regexes. */
const INVISIBLE_RE = /[​-‍⁠﻿­]/g;

/** Fullwidth and small-form at-signs that normalise to "@" under NFKC. */
const AT_HOMOGLYPHS = /[＠﹫]/g;

/**
 * Cloudflare's Email Address Obfuscation, which is enabled by default when a
 * site signs up. Roughly a fifth of the web sits behind Cloudflare, so this is
 * the single highest-yield decoder here.
 *
 * The scheme is a single-byte XOR: the first hex byte is the key, and every
 * byte after it is XORed with that key.
 *
 * Cloudflare deliberately leaves `<script>`, `<noscript>` and `<textarea>`
 * alone, which is why the JSON-blob scan in this same pipeline so often finds
 * a plaintext address on a page whose visible footer is encoded.
 */
export const decodeCloudflareEmail = (hex) => {
  const clean = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{6,}$/.test(clean) || clean.length % 2 !== 0) return null;

  const key = parseInt(clean.slice(0, 2), 16);
  const bytes = [];
  for (let i = 2; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16) ^ key);
  }
  try {
    // The payload is UTF-8, not Latin-1 — an address inside an internationalised
    // domain decodes to mojibake if this is read byte-by-byte.
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
};

/**
 * Word-substitution separators, per market.
 *
 * A German site writes "info(ät)acme punkt de" and a French one
 * "contact arobase acme point fr". Handling only the English "at"/"dot" pair
 * silently loses the European long tail, which is exactly where the
 * legally-mandated addresses live.
 */
const AT_WORDS = [
  "at", "atsign",
  "ät", "aet", "klammeraffe", "kringel", "affenschwanz",   // de
  "arobase", "arobas", "chez",                              // fr
  "arroba",                                                 // es / pt
  "chiocciola", "chiocciolina",                             // it
  "apenstaartje",                                           // nl
];

const DOT_WORDS = [
  "dot", "period", "point",
  "punkt", "pkt",       // de
  "pt",                 // fr
  "punto",              // es / it
  "ponto",              // pt
  "punt",               // nl
];

/** Markers a site adds so a human deletes them but a scraper does not. */
const REMOVE_MARKERS = /(?:-|\.|_)?(?:REMOVE(?:THIS|ME)?|ENTFERNEN|KEIN[- ]?SPAM|NOSPAM|NO[- ]SPAM|SPAMFREE)(?:-|\.|_)?/gi;

const alternation = (words) => words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/**
 * A separator word must stand alone. `\b` is the obvious tool and the wrong
 * one: it is defined on ASCII word characters, so it never fires beside "ät"
 * or "chiocciola"'s accented cousins. These lookarounds say the same thing in
 * a way that is blind to the alphabet — the character either side may be
 * whitespace, a bracket or punctuation, but never a letter or a digit.
 */
const FENCE_OPEN = "(?<![A-Za-z0-9])";
const FENCE_CLOSE = "(?![A-Za-z0-9])";

/**
 * One address written with word separators. Both the at *and* the dot must be
 * disguised — requiring only the "at" is what once turned the prose
 * "Learn more at stripe.com" into the contact "an@stripe.com".
 *
 * Every separator is fenced so it cannot be flanked by an ASCII letter or
 * digit, which is what stops the match running *through* an ordinary word.
 * (Plain `\b` cannot do this job: "ät" begins with a non-word character, so
 * `\bät\b` never matches and the German forms are lost.) Without the fence
 * the "at" inside
 * "information" is a separator like any other, so "…more information point
 * it…" resolved to the contact `inform@ion.it` — and because half of
 * PLAUSIBLE_TLD is also ordinary English ("it", "in", "me", "be", "live",
 * "today", "run", "clinic", "digital"), the TLD check below could not catch it.
 * A real obfuscation always leaves a boundary: "info (at) acme punkt de" and
 * "buero ät muster-bau punkt de" both still decode.
 */
const WORD_OBFUSCATED_RE = new RegExp(
  [
    "\\b([A-Za-z0-9._%+-]{1,64})",
    `\\s*[\\[({<]?\\s*${FENCE_OPEN}(?:${alternation(AT_WORDS)})${FENCE_CLOSE}\\s*[\\])}>]?\\s*`,
    "([A-Za-z0-9-]{1,63})",
    `(?:\\s*[\\[({<]?\\s*(?:${FENCE_OPEN}(?:${alternation(DOT_WORDS)})${FENCE_CLOSE}|\\.)\\s*[\\])}>]?\\s*([A-Za-z0-9-]{1,63}))?`,
    `\\s*[\\[({<]?\\s*${FENCE_OPEN}(?:${alternation(DOT_WORDS)})${FENCE_CLOSE}\\s*[\\])}>]?\\s*`,
    "([A-Za-z]{2,24})\\b",
  ].join(""),
  "gi",
);

/**
 * TLDs a word-separated address is allowed to end in.
 *
 * The separator words are the whole risk here: "dot" is rare in prose, but
 * "point", "punkt" and "pt" are not, and without this "We are open at 9 point
 * sharp" resolves to the contact "open@9.sharp". Requiring a real TLD keeps
 * "buero (ät) muster-bau punkt de" working and discards the rest.
 */
const PLAUSIBLE_TLD = new Set([
  "com", "net", "org", "info", "biz", "io", "co", "me", "app", "dev", "ai", "eu",
  "de", "at", "ch", "uk", "ie", "fr", "es", "it", "nl", "be", "pt", "pl", "cz", "se",
  "no", "dk", "fi", "gr", "hu", "ro", "bg", "hr", "si", "sk", "lt", "lv", "ee", "lu",
  "sa", "ae", "qa", "kw", "bh", "om", "jo", "lb", "eg", "ma", "tr", "il", "iq",
  "us", "ca", "mx", "br", "ar", "cl", "au", "nz", "za", "ng", "ke",
  "in", "pk", "sg", "my", "id", "th", "vn", "ph", "jp", "kr", "cn", "hk", "tw",
  "berlin", "immo", "shop", "online", "site", "store", "agency", "studio", "digital",
  "tech", "solutions", "services", "group", "company", "gmbh", "email", "systems",
]);

/** Rewrite word-separated addresses in a block of visible text. */
export const decodeWordSeparators = (text) =>
  String(text || "").replace(WORD_OBFUSCATED_RE, (match, local, d1, d2, tld) => {
    if (!PLAUSIBLE_TLD.has(String(tld).toLowerCase())) return match;
    return `${local}@${[d1, d2].filter(Boolean).join(".")}.${tld}`;
  });

/**
 * Text normalisation applied before any address matching.
 *
 * Order matters: fold compatibility forms first so a fullwidth at-sign becomes
 * a real one, then remove the invisible characters that were inserted to split
 * an address the eye still reads as whole.
 */
export const normaliseForMatching = (text) => {
  if (!text) return "";
  return String(text)
    .normalize("NFKC")
    .replace(AT_HOMOGLYPHS, "@")
    .replace(INVISIBLE_RE, "")
    .replace(REMOVE_MARKERS, "");
};

const EMAIL_SHAPE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}$/;
const EMAIL_ANYWHERE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/;

/**
 * Shaped like an address *and* ending somewhere real.
 *
 * The TLD check is what makes the decoders below reachable at all. A ROT-encoded
 * address is still address-shaped — "info@acme.de" rotates to "vasb@npzr.qr" —
 * so without it the encoded form is accepted at face value and stored as a
 * contact that can only ever hard-bounce. Checking the TLD rejects the encoded
 * form, which lets the decoders run and recover the real one.
 */
const looksLikeEmail = (value) => {
  if (!value) return false;
  const hit = EMAIL_ANYWHERE.exec(value);
  if (!hit) return false;
  const tld = hit[0].split(".").pop().toLowerCase();
  return PLAUSIBLE_TLD.has(tld);
};

/**
 * Cheap reversible encodings that homegrown "protect my email" snippets use.
 *
 * Each is tried only on strings that are already suspicious — a `data-` value,
 * a long hex run, a base64-looking literal. Trying them on arbitrary page text
 * would manufacture addresses out of noise.
 */
const CANDIDATE_DECODERS = [
  /** Written backwards, usually paired with CSS `direction: rtl`. */
  { name: "REVERSED", fn: (v) => [...v].reverse().join("") },

  /** Base64, the default in several CMS anti-spam plugins. */
  {
    name: "BASE64",
    fn: (v) => {
      const clean = v.trim();
      if (!/^[A-Za-z0-9+/]{12,}={0,2}$/.test(clean)) return null;
      try { return Buffer.from(clean, "base64").toString("utf8"); } catch { return null; }
    },
  },

  /**
   * ROT-N, as emitted by TYPO3's `linkTo_UnCryptMailto`. The shift is not
   * declared anywhere in the markup, so it has to be found by trying.
   *
   * Brute-forcing all 25 is ambiguous: several shifts of the same string can
   * each land on a real-looking TLD, and taking the first one manufactures an
   * address that can only hard-bounce. So this accepts a result only when the
   * answer is not a guess — either ROT-13 works (overwhelmingly the case in the
   * wild, and TYPO3's actual output), or exactly one shift in the whole range
   * produces a plausible address.
   */
  {
    name: "ROT",
    fn: (v) => {
      const rotate = (shift) => v.replace(/[a-z]/gi, (ch) => {
        const base = ch <= "Z" ? 65 : 97;
        return String.fromCharCode(((ch.charCodeAt(0) - base + shift) % 26) + base);
      });

      const rot13 = rotate(13);
      if (looksLikeEmail(rot13)) return rot13;

      const hits = [];
      for (let shift = 1; shift < 26; shift += 1) {
        if (shift === 13) continue;
        const out = rotate(shift);
        if (looksLikeEmail(out)) hits.push(out);
        if (hits.length > 1) return null; // ambiguous — refuse to guess
      }
      return hits.length === 1 ? hits[0] : null;
    },
  },

  /**
   * Single-byte XOR over a hex run — the generic form of Cloudflare's scheme,
   * which several homegrown snippets copy. All 256 keys are cheap to try.
   */
  {
    name: "XOR_HEX",
    fn: (v) => {
      const clean = v.trim();
      if (!/^[0-9a-fA-F]{20,}$/.test(clean) || clean.length % 2 !== 0) return null;
      const bytes = [];
      for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
      for (let key = 0; key < 256; key += 1) {
        const out = String.fromCharCode(...bytes.map((b) => b ^ key));
        if (looksLikeEmail(out)) return out;
      }
      return null;
    },
  },
];

/**
 * Try every cheap decoding on one suspicious literal and return the first that
 * yields a well-formed address.
 *
 * @param {string} value
 * @returns {{email: string, method: string}|null}
 */
export const decodeCandidate = (value) => {
  const raw = normaliseForMatching(value);
  if (!raw || raw.length > 2048) return null;

  // Already readable, or readable once the word separators are resolved. The
  // TLD has to be real, or an encoded address gets taken at face value.
  const direct = decodeWordSeparators(raw);
  if (looksLikeEmail(direct)) return { email: EMAIL_ANYWHERE.exec(direct)[0], method: "PLAIN" };

  for (const { name, fn } of CANDIDATE_DECODERS) {
    let out;
    try { out = fn(raw); } catch { out = null; }
    if (!out) continue;
    const decoded = normaliseForMatching(out);
    if (looksLikeEmail(decoded)) return { email: EMAIL_ANYWHERE.exec(decoded)[0], method: name };
  }
  return null;
};

/**
 * Every address reachable from a `mailto:` URI.
 *
 * Three things a naive `href.replace("mailto:", "")` gets wrong, all per
 * RFC 6068: the address is optional (`mailto:?subject=Hi` yields nothing and
 * must not produce a garbage contact), several recipients may be
 * comma-separated, and further addresses hide in the `to`, `cc` and `bcc`
 * query fields.
 */
export const emailsFromMailto = (href) => {
  const raw = String(href || "").trim();
  if (!/^mailto:/i.test(raw)) return [];

  const withoutScheme = raw.slice(raw.indexOf(":") + 1);
  const [addressPart, queryPart = ""] = [
    withoutScheme.split("?")[0],
    withoutScheme.split("?").slice(1).join("?"),
  ];

  const out = [];
  const push = (chunk) => {
    for (const piece of String(chunk).split(",")) {
      let value = piece.trim();
      if (!value) continue;
      try { value = decodeURIComponent(value); } catch { /* keep the raw form */ }
      value = normaliseForMatching(value).trim().toLowerCase();
      if (EMAIL_SHAPE.test(value)) out.push(value);
    }
  };

  push(addressPart);
  for (const field of ["to", "cc", "bcc"]) {
    const match = new RegExp(`(?:^|&)${field}=([^&]*)`, "i").exec(queryPart);
    if (match) push(match[1]);
  }
  return [...new Set(out)];
};

/**
 * Walk any parsed JSON and yield every value under a key that names an email.
 *
 * Deliberately a recursive key search rather than a list of known paths: the
 * shapes that carry an address (`contactPoint`, `founder`, `employee`,
 * `hiringOrganization`, `@graph`, `publisher`, `department`) are open-ended,
 * and one rule survives all of them. The same walk handles the framework blobs
 * (`__NEXT_DATA__`, `__NUXT__`, Wix and Squarespace contexts), which is where
 * an address most often survives in the clear on a Cloudflare site.
 */
export const emailsFromJson = (node, depth = 0, seen = new Set()) => {
  const out = [];
  if (node === null || node === undefined || depth > 12) return out;

  if (typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const item of node) out.push(...emailsFromJson(item, depth + 1, seen));
    return out;
  }
  if (typeof node !== "object") return out;
  if (seen.has(node)) return out; // cycles do occur in hand-rolled state blobs
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    const keyIsEmail = /^(?:e[-_]?mail|contact_?e?mail|support_?e?mail|reply_?to|mailto|email_?address)$/i.test(key);
    if (keyIsEmail) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (typeof candidate === "string") {
          // Schema.org permits `{"@value": "..."}` wrappers and `mailto:` prefixes.
          const cleaned = normaliseForMatching(candidate).replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
          for (const piece of cleaned.split(/[;,]/)) {
            const value2 = piece.trim();
            if (EMAIL_SHAPE.test(value2)) out.push(value2);
          }
        } else if (candidate && typeof candidate === "object" && typeof candidate["@value"] === "string") {
          const cleaned = normaliseForMatching(candidate["@value"]).replace(/^mailto:/i, "").trim().toLowerCase();
          if (EMAIL_SHAPE.test(cleaned)) out.push(cleaned);
        }
      }
    }
    out.push(...emailsFromJson(value, depth + 1, seen));
  }
  return [...new Set(out)];
};
