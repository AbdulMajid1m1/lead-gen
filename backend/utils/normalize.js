import { parse } from "tldts";

/** Legal-form suffixes stripped before comparing company names. */
const SUFFIXES = [
  "inc", "incorporated", "llc", "l l c", "ltd", "limited", "plc", "corp", "corporation",
  "co", "company", "gmbh", "ag", "bv", "nv", "sa", "sas", "sarl", "srl", "spa", "ab",
  "as", "oy", "aps", "pty", "pte", "llp", "lp", "kg", "ug", "sl", "sro", "doo",
  "holdings", "group", "the",
];

/**
 * Canonical form used for fuzzy company identity: lowercase, accents folded,
 * punctuation dropped, legal suffixes removed.
 *   "Café Müller GmbH & Co. KG" → "cafe muller"
 */
export const normalizeCompanyName = (name) => {
  if (!name) return "";
  let s = String(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    // Keep every Unicode letter and digit, not just ASCII. Restricting this to
    // [a-z0-9] erased Arabic, Cyrillic, Greek and CJK names entirely, leaving an
    // empty string — which then threw and aborted the whole ingest step for
    // cities like Riyadh where most business names are not in Latin script.
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Drop legal-form tokens wherever they appear, not just at the end: German
  // and Dutch names routinely carry them mid-string ("Müller GmbH & Co. KG"),
  // and leaving one in means the same company fails to match itself across
  // sources that write the name differently.
  const suffixSet = new Set(SUFFIXES);
  const kept = s.split(" ").filter((word) => word && !suffixSet.has(word));

  // Trim a conjunction left dangling by the removal ("muller and" → "muller").
  while (kept.length && (kept[kept.length - 1] === "and" || kept[kept.length - 1] === "of")) kept.pop();
  while (kept.length && (kept[0] === "and" || kept[0] === "of")) kept.shift();

  const normalized = kept.join(" ").trim();
  // A company genuinely named only of suffix words ("The Co") must not
  // normalise to an empty string, which would collide with every other one.
  return normalized || s.replace(/\s+/g, " ").trim();
};

/**
 * Registrable domain, lowercased, no scheme/www/port.
 *   "https://WWW.Shop.Acme.co.uk/path" → "acme.co.uk"
 * Returns null for IPs and anything without a public suffix.
 */
export const normalizeDomain = (input) => {
  if (!input) return null;
  const raw = String(input).trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }
  const parsed = parse(hostname);
  if (!parsed.domain || parsed.isIp) return null;
  return parsed.domain.toLowerCase();
};

/** Full hostname (keeps subdomains) — needed for per-host crawl policy. */
export const normalizeHostname = (input) => {
  if (!input) return null;
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
};

/**
 * URL canonicalization for crawl dedupe: drop the fragment, strip tracking
 * params, lowercase the host, remove a trailing slash, sort query params.
 */
const TRACKING_PARAMS = /^(?:utm_|fbclid|gclid|msclkid|mc_[ce]id|_ga|ref|referrer|source|igshid|yclid)/i;

export const normalizeUrl = (input, base) => {
  let url;
  try {
    url = new URL(input, base);
  } catch {
    return null;
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);
  // Normalise the trailing slash on the *path*, not the whole href — with a
  // query string attached the href never ends in "/", so checking it there
  // silently let "/page/?a=1" and "/page?a=1" become two separate crawls.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
};

/**
 * Phone digits only, for identity matching. Deliberately loses formatting —
 * the display value is kept separately on the Contact row.
 */
export const normalizePhone = (input) => {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  // Compare on the last 9 digits: the same business is often listed with and
  // without its country code across sources.
  return digits;
};

export const phoneMatchKey = (input) => {
  const d = normalizePhone(input);
  return d ? d.slice(-9) : null;
};

/** Job titles: lowercase, punctuation and seniority noise removed. */
export const normalizeJobTitle = (title) =>
  String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .replace(/\b(?:m\/f\/d|f\/m\/d|h\/f|w\/m\/d|remote|hybrid|onsite|full[- ]time|part[- ]time|contract|intern(?:ship)?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** ATS slug candidates derived from a company name, best guess first. */
export const atsSlugCandidates = (name) => {
  const norm = normalizeCompanyName(name);
  if (!norm) return [];
  const words = norm.split(" ").filter(Boolean);
  const candidates = new Set([
    words.join(""),
    words.join("-"),
    words[0],
    words.slice(0, 2).join(""),
    words.slice(0, 2).join("-"),
  ]);
  return [...candidates].filter((c) => c && c.length >= 2 && c.length <= 60);
};
