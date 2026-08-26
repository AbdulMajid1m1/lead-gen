import * as cheerio from "cheerio";

/**
 * Extracts publicly published business contact points from a page.
 *
 * Scope is deliberately narrow: only what the business itself chose to publish
 * on its own site. No guessing patterns like `firstname@domain`, no harvesting
 * of personal addresses, and role/personal classification is recorded so the
 * outreach layer can prefer role accounts (info@, sales@) over named people.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;

// Addresses that are never a business contact: asset filenames, tracking
// pixels, example/placeholder text, CMS/vendor noise — and domain brokers,
// whose parking pages advertise their own sales address on every domain they
// hold. Without that last group, a business whose name happens to match a
// parked domain acquires the broker's inbox as its "business email".
const EMAIL_BLOCKLIST_RE = /(?:^|@)(?:example|test|domain|yourdomain|email|sentry|wixpress|godaddy|squarespace|shopify|placeholder|localhost)\b|@(?:domainster|domainmarket|hugedomains|brandbucket|sedo|afternic|dan|undeveloped|namecheap|dynadot|sav|epik|escrow)\.|\.(?:png|jpe?g|gif|webp|svg|css|js|woff2?|ico)$|^(?:user|name|your|someone)@/i;

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

/**
 * @param {string} html
 * @param {{pageUrl:string}} ctx
 * @returns {{emails:Array, phones:Array, socials:Array}} each item carries the
 *   raw source snippet so it can be stored as evidence.
 */
export const extractContacts = (html, ctx = {}) => {
  const $ = cheerio.load(html || "");
  const pageUrl = ctx.pageUrl || null;

  // Strip script/style before text scanning — inline JSON blobs are full of
  // vendor emails and version strings that look like phone numbers.
  const $body = $("script, style, noscript").remove().end();
  const text = deobfuscate($body.text().replace(/\s+/g, " "));

  // ── emails ──
  const emails = new Map();
  const addEmail = (value, method) => {
    const email = String(value).trim().toLowerCase().replace(/^mailto:/, "").split("?")[0];
    if (!email || !/^[^@]+@[^@]+\.[a-z]{2,24}$/i.test(email)) return;
    if (EMAIL_BLOCKLIST_RE.test(email)) return;
    // A mailto: href is the site declaring an address, so it is trusted even
    // with an unusual TLD. Text scraped from prose must clear the TLD check.
    if (method !== "MAILTO_LINK" && !hasValidTld(email)) return;
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

  $("a[href^='mailto:' i]").each((_, el) => addEmail($(el).attr("href") || "", "MAILTO_LINK"));
  for (const m of text.matchAll(EMAIL_RE)) addEmail(m[0], "PAGE_TEXT");

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

  // ── socials ──
  const socials = new Map();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let abs;
    try {
      abs = pageUrl ? new URL(href, pageUrl).href : href;
    } catch {
      return;
    }
    if (SOCIAL_JUNK.test(abs)) return;
    for (const { network, re } of SOCIAL_PATTERNS) {
      const m = re.exec(abs);
      if (!m) continue;
      const handle = decodeURIComponent(m[2] || m[1] || "").replace(/\/$/, "");
      if (!handle || handle.length > 100) return;
      const key = `${network}:${handle.toLowerCase()}`;
      if (!socials.has(key)) {
        socials.set(key, { network, handle, url: abs.split("?")[0], sourceUrl: pageUrl });
      }
      return;
    }
  });

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
