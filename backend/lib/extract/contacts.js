import * as cheerio from "cheerio";
import { emailLooksMangled } from "../outreach/hygiene.js";
import {
  decodeCloudflareEmail, decodeWordSeparators, normaliseForMatching,
  decodeCandidate, emailsFromMailto, emailsFromJson,
} from "./emailDecode.js";
import { emailBelongsToPlatform } from "../verify/hostedPlatforms.js";

/**
 * Extracts publicly published business contact points from a page.
 *
 * Scope is deliberately narrow: only what the business itself chose to publish
 * on its own site. No guessing patterns like `firstname@domain`, no harvesting
 * of personal addresses, and role/personal classification is recorded so the
 * outreach layer can prefer role accounts (info@, sales@) over named people.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;

/**
 * Whether a scraped string is plausibly an address somebody actually publishes.
 *
 * The local part and the registrable label both have to be at least two
 * characters, and when either is that short the other must be a real word's
 * length. "d@a.legal" fails on both; "hr@ge.ae" passes (a two-letter company
 * on a country TLD is normal); "info@x.io" passes.
 */
export const looksLikePublishedAddress = (email) => {
  const [local, domain] = String(email || "").toLowerCase().split("@");
  if (!local || !domain) return false;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return false;
  const registrable = labels[labels.length - 2];
  if (local.length < 2 || registrable.length < 2) return false;
  // The send-time hygiene rule already knows the other shape of this failure
  // — a word split around an "at": "loc@ion.delivery", "civiliz@ion.in" —
  // and there is no reason to let an address into the table that the sender
  // would refuse to use anyway.
  return !emailLooksMangled(email);
};

// Addresses that are never a business contact: asset filenames, tracking
// pixels, example/placeholder text, CMS/vendor noise — and domain brokers,
// whose parking pages advertise their own sales address on every domain they
// hold. Without that last group, a business whose name happens to match a
// parked domain acquires the broker's inbox as its "business email".
// `(?![\w-])` rather than `\b` on the placeholder group: `\b` matches before a
// hyphen, so real businesses at test-labor.de and email-marketing.de were being
// thrown away as placeholder text.
// The vendor group matches anywhere in the host, not only as its first label:
// `605a7b…@sentry-next.wixpress.com` and `…@o462166.ingest.sentry.io` are
// error-tracking DSNs that Wix and Sentry embed in every page, and both were
// being stored as business contacts because "sentry" was not the label after
// the "@".
const EMAIL_BLOCKLIST_RE = /(?:^|@)(?:example|test|domain|yourdomain|email|placeholder|localhost)(?![\w-])|@(?:[\w-]+\.)*(?:sentry|wixpress|godaddy|squarespace|shopify|domainster|domainmarket|hugedomains|brandbucket|sedo|afternic|dan|undeveloped|namecheap|dynadot|sav|epik|escrow)\.|\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ico)$|^(?:user|name|your|someone)@/i;

/**
 * Methods where the page is *declaring* an address rather than mentioning one.
 * These skip the TLD allowlist; prose does not.
 */
const DECLARED_METHODS = new Set(["MAILTO_LINK", "CLOUDFLARE", "STRUCTURED_DATA", "DATA_ATTR"]);

const ROLE_PREFIXES = new Set([
  "info", "contact", "hello", "hi", "sales", "support", "enquiries", "enquiry",
  "inquiries", "inquiry", "admin", "office", "team", "help", "service",
  "customerservice", "bookings", "booking", "reservations", "orders", "mail",
  "marketing", "business", "partnerships", "press", "media", "careers", "jobs",
  "hr", "recruitment", "accounts", "billing", "finance", "general",
]);

const NON_OUTREACH_PREFIXES = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster",
  "abuse", "webmaster", "hostmaster", "mailer-daemon", "bounce", "privacy", "dpo",
]);

/**
 * De-obfuscate "name (at) domain (dot) com" into a real address.
 *
 * This must match the *whole* candidate address in one pattern. An earlier
 * version replaced any occurrence of the letters "at" with "@", which silently
 * turned ordinary prose into fake contacts — "platform.browse" became
 * "pl@form.browse" and was stored as a business email.
 */
const OBFUSCATED_EMAIL_RE = new RegExp(
  [
    "\\b([A-Za-z0-9._%+-]{1,64})",                          // local part
    "(\\s*(?:[[({<]\\s*)?(?:at|@)(?:\\s*[\\])}>])?\\s*)",   // at-separator, captured
    "([A-Za-z0-9-]{1,63})",                                 // domain label
    "(?:(\\s*(?:[[({<]\\s*)?(?:dot|\\.)(?:\\s*[\\])}>])?\\s*)([A-Za-z0-9-]{1,63}))?", // optional 2nd label
    "(\\s*(?:[[({<]\\s*)?(?:dot|\\.)(?:\\s*[\\])}>])?\\s*)",// final dot-separator, captured
    "([A-Za-z]{2,24})\\b",                                  // TLD
  ].join(""),
  "gi",
);

/**
 * A separator counts as deliberately obfuscated when it is bracketed, spelled
 * out as a word, or padded with spaces — anything a normal address never does.
 */
const isObfuscatedSeparator = (sep) => /[[({<]|\bdot\b|\s/.test(sep || "");

const deobfuscate = (text) =>
  text.replace(OBFUSCATED_EMAIL_RE, (match, local, atSep, d1, dotSep1, d2, dotSep2, tld) => {
    // The *dot* must also be obfuscated. Requiring only the "at" turned
    // ordinary prose — "Learn more at stripe.com" — into "an@stripe.com",
    // because a spaced "at" beside a perfectly normal domain looked like an
    // obfuscated address. Genuine obfuscation always disguises both parts.
    const dotDisguised = isObfuscatedSeparator(dotSep1) || isObfuscatedSeparator(dotSep2);
    const atDisguised = /[[({<]|\bat\b/i.test(atSep || "");
    if (!atDisguised || !dotDisguised) return match;
    return `${local}@${[d1, d2].filter(Boolean).join(".")}.${tld}`;
  });

/**
 * A plausible public TLD. Without this, any sentence containing a dot behind a
 * word ("...checkout.view") reads as an address to the email regex.
 */
const VALID_TLD = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "name", "pro", "co",
  "io", "ai", "app", "dev", "tech", "cloud", "online", "site", "store", "shop", "agency",
  "digital", "studio", "design", "media", "email", "group", "systems", "solutions",
  "services", "consulting", "company", "ventures", "capital", "finance", "clinic",
  "care", "health", "restaurant", "cafe", "bar", "pub", "fit", "gym", "salon", "law",
  "legal", "travel", "hotel", "auto", "eco", "green", "life", "world", "global", "network",
  // country codes in the markets this product targets
  "uk", "ae", "sa", "us", "ca", "au", "nz", "ie", "de", "fr", "es", "it", "nl", "be", "ch",
  "at", "se", "no", "dk", "fi", "pl", "pt", "gr", "cz", "ro", "hu", "tr", "ru", "ua",
  "in", "pk", "bd", "lk", "sg", "my", "id", "th", "vn", "ph", "jp", "kr", "cn", "hk", "tw",
  "za", "ng", "ke", "eg", "ma", "br", "mx", "ar", "cl", "co", "pe", "qa", "kw", "bh", "om",
  "eu", "asia", "me", "tv", "cc", "ly", "sh", "gg", "je", "im",
  // common modern gTLDs small businesses actually register
  "xyz", "art", "blog", "club", "space", "website", "host", "link", "live", "news",
  "today", "works", "zone", "expert", "guru", "team", "wiki", "page", "one", "run",
  "kitchen", "pizza", "coffee", "beer", "wine", "menu", "delivery", "market", "sale",
  "photography", "photos", "gallery", "events", "tours", "rentals", "properties",
  "realty", "estate", "builders", "contractors", "plumbing", "dental", "surgery",
  "school", "academy", "education", "training", "institute", "software", "computer",
]);

const hasValidTld = (email) => {
  const tld = email.split(".").pop()?.toLowerCase();
  return Boolean(tld) && VALID_TLD.has(tld);
};

const classifyEmail = (email) => {
  const local = email.split("@")[0].toLowerCase().replace(/[._-]/g, "");
  if (NON_OUTREACH_PREFIXES.has(local)) return "NON_OUTREACH";
  // An address on an ordering marketplace, a booking service or a help desk is
  // the platform's, not the business's — `info@menufy.com` on a restaurant's
  // Menufy page reaches Menufy's ticket queue. Kept, so the record shows what
  // the page published, but never offered to the sender.
  if (emailBelongsToPlatform(email)) return "NON_OUTREACH";
  if (ROLE_PREFIXES.has(local)) return "ROLE";
  return "PERSONAL";
};

// ─── Phones ───────────────────────────────────────────────────────────────────
// Deliberately conservative: an over-eager phone regex turns every price,
// date and product SKU into a "contact". We require either a tel: link, an
// explicit international prefix, or a separator-formatted run of digits.
const TEL_HREF_RE = /^tel:(.+)$/i;
const PHONE_TEXT_RE = /(?:\+|00)\d[\d\s().-]{7,20}\d|\(?\b0\d{1,4}\)?[\s.-]\d{2,4}[\s.-]\d{2,6}(?:[\s.-]\d{2,6})?\b/g;

const normalizePhone = (raw) => {
  const cleaned = String(raw).replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // A run of identical or sequential digits is placeholder copy, not a number.
  if (/^(\d)\1+$/.test(digits) || digits === "1234567890") return null;
  return cleaned.startsWith("+") ? cleaned : cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : digits;
};

// ─── Social profiles ──────────────────────────────────────────────────────────
const SOCIAL_PATTERNS = [
  { network: "LINKEDIN",  re: /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/([^/?#]+)/i },
  { network: "FACEBOOK",  re: /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/(?!sharer|share\.php|dialog|tr\?)([^/?#]+)/i },
  { network: "INSTAGRAM", re: /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)([^/?#]+)/i },
  { network: "X",         re: /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)([^/?#]+)/i },
  { network: "YOUTUBE",   re: /^https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)([^/?#]+)/i },
  { network: "TIKTOK",    re: /^https?:\/\/(?:www\.)?tiktok\.com\/@([^/?#]+)/i },
  { network: "GITHUB",    re: /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/?$/i },
  { network: "WHATSAPP",  re: /^https?:\/\/(?:api\.whatsapp\.com\/send|wa\.me)\/?\??(?:phone=)?(\d+)?/i },
  { network: "CRUNCHBASE",re: /^https?:\/\/(?:www\.)?crunchbase\.com\/organization\/([^/?#]+)/i },
];

const SOCIAL_JUNK = /\/(?:sharer|share|intent|plugins|tr|login|signup|policies|privacy)\b/i;

/** Match one absolute URL against the social patterns. Shared by the anchor
 *  scan and the JSON-LD `sameAs` walk so both speak the same vocabulary. */
const matchSocial = (abs) => {
  if (SOCIAL_JUNK.test(abs)) return null;
  for (const { network, re } of SOCIAL_PATTERNS) {
    const m = re.exec(abs);
    if (!m) continue;
    const handle = decodeURIComponent(m[2] || m[1] || "").replace(/\/$/, "");
    if (!handle || handle.length > 100) return null;
    return { network, handle, url: abs.split("?")[0] };
  }
  return null;
};

// ─── Structured-data walkers ─────────────────────────────────────────────────
// JSON-LD is where a large share of small-business sites state their phone —
// SEO plugins emit a LocalBusiness block with `telephone` even when the number
// is rendered only as an image or not at all. Same for `sameAs`: the schema
// field whose entire purpose is "these profiles are officially us".

const JSON_PHONE_KEY_RE = /^(?:telephone|phone|phone_?number|contact_?phone|tel)$/i;

/** A string that could plausibly be a written phone number, nothing else. */
const JSON_PHONE_SHAPE_RE = /^\+?[\d\s()./-]{7,25}$/;

const phonesFromJson = (node, depth = 0, seen = new Set()) => {
  const out = [];
  if (node === null || node === undefined || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const item of node) out.push(...phonesFromJson(item, depth + 1, seen));
    return out;
  }
  if (typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    if (JSON_PHONE_KEY_RE.test(key)) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        // Schema.org permits `tel:` prefixes and `{"@value": "..."}` wrappers.
        const raw = typeof candidate === "string" ? candidate
          : candidate && typeof candidate === "object" && typeof candidate["@value"] === "string" ? candidate["@value"]
          : null;
        const cleaned = raw ? raw.replace(/^tel:/i, "").trim() : "";
        if (cleaned && JSON_PHONE_SHAPE_RE.test(cleaned)) out.push(cleaned);
      }
    } else {
      out.push(...phonesFromJson(value, depth + 1, seen));
    }
  }
  return out;
};

const sameAsFromJson = (node, depth = 0, seen = new Set()) => {
  const out = [];
  if (node === null || node === undefined || depth > 12) return out;
  if (Array.isArray(node)) {
    for (const item of node) out.push(...sameAsFromJson(item, depth + 1, seen));
    return out;
  }
  if (typeof node !== "object") return out;
  if (seen.has(node)) return out;
  seen.add(node);

  for (const [key, value] of Object.entries(node)) {
    if (/^same_?as$/i.test(key)) {
      for (const url of Array.isArray(value) ? value : [value]) {
        if (typeof url === "string" && /^https?:\/\//i.test(url)) out.push(url.trim());
      }
    } else {
      out.push(...sameAsFromJson(value, depth + 1, seen));
    }
  }
  return out;
};

/**
 * @param {string} html
 * @param {{pageUrl:string}} ctx
 * @returns {{emails:Array, phones:Array, socials:Array}} each item carries the
 *   raw source snippet so it can be stored as evidence.
 */
export const extractContacts = (html, ctx = {}) => {
  const $ = cheerio.load(html || "");
  const pageUrl = ctx.pageUrl || null;

  // Nodes the page hides from a human are stripped before any text scan. Two
  // reasons, and the second matters more: a `display:none` block is where
  // scraper honeypots live, and a seeded trap address is a spam-trap hit that
  // costs the sending domain its reputation.
  $("[style*='display:none' i], [style*='display: none' i], [hidden], [aria-hidden='true']").remove();

  // Script/style/noscript are dropped from the *text* scan — inline JSON blobs
  // are full of vendor emails and version strings that read as phone numbers.
  // They are read separately, and deliberately, further down: Cloudflare does
  // not obfuscate script contents, so on a Cloudflare site the JSON blob is
  // frequently the only place the address survives in the clear.
  const $scripts = $("script").clone();
  const $body = $("script, style, noscript").remove().end();
  const text = deobfuscate(decodeWordSeparators(normaliseForMatching($body.text().replace(/\s+/g, " "))));

  // ── emails ──
  const emails = new Map();
  const addEmail = (value, method) => {
    const email = String(value).trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
    if (!email || !/^[^@]+@[^@]+\.[a-z]{2,24}$/i.test(email)) return;
    if (EMAIL_BLOCKLIST_RE.test(email)) return;
    // Text that merely has the shape of an address. Minified scripts and
    // concatenated prose produce fragments like "d@a.legal", "loc@ion.delivery"
    // and "m@ter.in": a one-letter mailbox at a one- or two-letter domain on a
    // TLD that is an ordinary English word. Nobody publishes an address like
    // that, and five of the first thirty companies on one promote run carried
    // one as a contact — where the sender would have picked it up and bounced.
    // A declared address (a mailto: link, a schema.org field) is the site's
    // own statement and is exempt, the same way it is exempt from the TLD list.
    if (!DECLARED_METHODS.has(method) && !looksLikePublishedAddress(email)) return;
    // The TLD allowlist exists to stop prose ("...checkout.view") reading as an
    // address. It must not apply to a *declared* address — a mailto: href, a
    // Cloudflare-encoded span, a schema.org `email` field or a data- attribute
    // is the site stating its own contact point, and stating it on `.berlin`,
    // `.immo` or `.construction` is not a reason to discard it. Only text
    // scraped out of running prose has to clear the list.
    if (!DECLARED_METHODS.has(method) && !hasValidTld(email)) return;
    if (!emails.has(email)) {
      emails.set(email, {
        value: email,
        kind: classifyEmail(email),
        method,           // MAILTO_LINK | PAGE_TEXT — MAILTO is stronger evidence
        sourceUrl: pageUrl,
        domain: email.split("@")[1],
      });
    }
  };

  // A mailto: may carry several recipients, and more in its to/cc/bcc fields —
  // and may carry none at all ("mailto:?subject=Hi"), which must not become a
  // contact. RFC 6068 rather than a naive prefix strip.
  $("a[href^='mailto:' i]").each((_, el) => {
    for (const address of emailsFromMailto($(el).attr("href") || "")) addEmail(address, "MAILTO_LINK");
  });
  for (const m of text.matchAll(EMAIL_RE)) addEmail(m[0], "PAGE_TEXT");

  // Cloudflare's Email Address Obfuscation, on by default for every site that
  // signs up. Both markup forms, plus the raw fragment, because the attribute
  // is sometimes written onto an element cheerio does not match cleanly.
  $("[data-cfemail]").each((_, el) => {
    const decoded = decodeCloudflareEmail($(el).attr("data-cfemail"));
    if (decoded) addEmail(decoded, "CLOUDFLARE");
  });
  for (const m of String(html || "").matchAll(/email-protection#([0-9a-fA-F]{6,})/g)) {
    const decoded = decodeCloudflareEmail(m[1]);
    if (decoded) addEmail(decoded, "CLOUDFLARE");
  }

  // Addresses parked in data- attributes, and the split user/domain pattern
  // several CMS anti-spam plugins use.
  $("[data-email], [data-mail], [data-user], [data-domain], [data-contact]").each((_, el) => {
    const attribs = el.attribs || {};
    const user = attribs["data-user"];
    const domain = attribs["data-domain"];
    if (user && domain) addEmail(`${user}@${domain}`, "DATA_ATTR");
    for (const [name, value] of Object.entries(attribs)) {
      if (!name.startsWith("data-") || !value) continue;
      const hit = decodeCandidate(value);
      if (hit) addEmail(hit.email, "DATA_ATTR");
    }
  });

  // SVG text and <address> blocks — invisible to a text scan that walks only
  // HTML elements, and never obfuscated because nobody expects them to be read.
  $("svg text, svg tspan, address").each((_, el) => {
    const hit = decodeCandidate($(el).text());
    if (hit) addEmail(hit.email, "PAGE_TEXT");
  });

  // Structured data and framework state. One recursive key walk covers
  // schema.org contactPoint/founder/employee, @graph, and the __NEXT_DATA__ /
  // __NUXT__ / Wix / Squarespace blobs alike — the shapes are open-ended and a
  // list of known paths would be out of date the week it was written.
  //
  // Phones and `sameAs` profiles ride the same walk: an SEO plugin's
  // LocalBusiness block frequently carries the only machine-readable phone on
  // the site, and `sameAs` is the schema field whose entire purpose is "these
  // social profiles are officially us". Collected here, recorded below once
  // the phone/social accumulators exist.
  const jsonPhones = [];
  const jsonSameAs = [];
  const walkParsedJson = (parsed) => {
    for (const address of emailsFromJson(parsed)) addEmail(address, "STRUCTURED_DATA");
    jsonPhones.push(...phonesFromJson(parsed));
    jsonSameAs.push(...sameAsFromJson(parsed));
  };
  $scripts.each((_, el) => {
    const raw = $(el).text();
    if (!raw || raw.length > 400_000) return;
    // Only JSON-looking payloads are worth a parse when no "@" is present —
    // a phone or sameAs never hides in plain executable code the way an
    // address does, and parsing every vendor bundle would be pure waste.
    const jsonish = /^\s*[[{]/.test(raw) || raw.includes('"telephone"') || raw.includes('"phone') || raw.includes('"sameAs"');
    if (!raw.includes("@") && !jsonish) return;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed) {
      walkParsedJson(parsed);
      return;
    }
    // Not pure JSON (an assignment like `window.__NUXT__ = {...}`): pull out the
    // first balanced object and try that, then fall back to a plain scan.
    const start = raw.indexOf("{");
    if (start >= 0) {
      const slice = raw.slice(start, raw.lastIndexOf("}") + 1);
      try {
        walkParsedJson(JSON.parse(slice));
        return;
      } catch { /* fall through */ }
    }
    if (!raw.includes("@")) return;
    for (const m of normaliseForMatching(raw).matchAll(EMAIL_RE)) addEmail(m[0], "STRUCTURED_DATA");
  });

  // ── phones ──
  const phones = new Map();
  const addPhone = (raw, method) => {
    const value = normalizePhone(raw);
    if (!value) return;
    if (!phones.has(value)) {
      phones.set(value, { value, raw: String(raw).trim().slice(0, 40), method, sourceUrl: pageUrl });
    }
  };

  $("a[href^='tel:' i]").each((_, el) => {
    const m = TEL_HREF_RE.exec($(el).attr("href") || "");
    if (m) addPhone(decodeURIComponent(m[1]), "TEL_LINK");
  });
  for (const m of text.matchAll(PHONE_TEXT_RE)) addPhone(m[0], "PAGE_TEXT");
  // A telephone stated in JSON-LD/state is the site declaring its own number —
  // often the only machine-readable copy when the visible one is an image.
  for (const raw of jsonPhones) addPhone(raw, "STRUCTURED_DATA");

  // ── socials ──
  const socials = new Map();
  const addSocial = (hit) => {
    if (!hit) return;
    const key = `${hit.network}:${hit.handle.toLowerCase()}`;
    if (!socials.has(key)) socials.set(key, { ...hit, sourceUrl: pageUrl });
  };
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let abs;
    try {
      abs = pageUrl ? new URL(href, pageUrl).href : href;
    } catch {
      return;
    }
    addSocial(matchSocial(abs));
  });
  // Profiles declared via schema.org `sameAs` — present on many sites that
  // render no social icons at all, because the SEO plugin emits them anyway.
  for (const url of jsonSameAs) addSocial(matchSocial(url));

  return {
    emails: [...emails.values()],
    phones: [...phones.values()],
    socials: [...socials.values()],
  };
};

/**
 * Pick the single best address to contact a business on.
 * Role accounts beat personal ones (no individual targeting, higher deliverability),
 * mailto links beat text scrapes, and same-domain beats third-party.
 */
export const pickPrimaryEmail = (emails, companyDomain) => {
  const usable = emails.filter((e) => e.kind !== "NON_OUTREACH");
  if (usable.length === 0) return null;
  const score = (e) => {
    let s = 0;
    if (companyDomain && e.domain?.endsWith(companyDomain.replace(/^www\./, ""))) s += 100;
    if (e.kind === "ROLE") s += 50;
    if (e.method === "MAILTO_LINK") s += 20;
    if (/^(?:info|contact|hello|sales)@/.test(e.value)) s += 10;
    return s;
  };
  return [...usable].sort((a, b) => score(b) - score(a))[0];
};
