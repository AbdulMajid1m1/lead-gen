import * as cheerio from "cheerio";
import { fetchPage } from "../crawler/fetchPage.js";
import { extractContacts } from "../extract/contacts.js";
import { normalizeCompanyName, normalizeDomain } from "../../utils/normalize.js";
import { phoneMatchKey } from "../../utils/normalize.js";
import { isHostedPlatformDomain } from "./hostedPlatforms.js";
import { log } from "../../utils/logger.js";

const logger = log("verify:domainIdentity");

/**
 * The single authority on "does this domain still belong to this company?".
 *
 * Every source that can attach a website to a lead — the OSM `website` tag, an
 * AI claim, a Google Places record, a guessed `<name>.com` — routes through
 * here before the domain is written. Previously each source carried its own
 * (or no) validation, which is how a Riyadh restaurant ended up pointing at a
 * Vietnamese gambling site: the domain had expired and been re-registered by an
 * SEO network, and nothing in the pipeline ever re-checked that the page still
 * belonged to the business.
 *
 * The rule enforced here: a domain is accepted only when the page *identifies
 * itself* as the company, and shows none of the takeover markers below.
 */

// ─── Disqualifiers ────────────────────────────────────────────────────────────
// These are checked before any positive evidence, because a takeover page will
// happily echo whatever name it is given.

/** Domain brokers, parking services and for-sale pages. */
const PARKED_MARKERS = /\b(?:domainster|sedo|afternic|dan\.com|hugedomains|buydomains|namecheap parking|godaddy(?:\.com)? (?:parking|auctions)|this domain (?:is|may be) for sale|buy this domain|the domain .{0,40} is for sale|parked (?:free )?(?:domain|courtesy)|inquire about this domain)\b/i;

/**
 * Expired-domain takeovers.
 *
 * The dominant failure mode in practice, and the one that produced the Topkapi
 * bug. A small business lets its domain lapse; an SEO network buys it for the
 * residual backlinks and turns it into a gambling, pharma or counterfeit portal.
 * The page returns HTTP 200 and looks perfectly healthy to a liveness check —
 * only the content reveals it. Multilingual because these networks are
 * overwhelmingly Vietnamese, Indonesian, Chinese and Korean.
 */
const TAKEOVER_MARKERS = [
  { label: "gambling", re: /\b(?:tài xỉu|nhà cái|casino|baccarat|situs (?:judi|slot)|judi bola|slot gacor|togel|bandar|sbobet|poker online|đánh bài|cá cược|카지노|바카라|먹튀|娱乐城|博彩|真人娱乐|betting site|jackpot|free spins)\b/i },
  { label: "pharma",   re: /\b(?:buy (?:viagra|cialis|tramadol|xanax)|generic viagra|online pharmacy without prescription|no prescription needed)\b/i },
  { label: "adult",    re: /\b(?:porn(?:hub|site)?|xxx video|sex cam|escort service)\b/i },
  { label: "counterfeit", re: /\b(?:replica (?:watches|handbags|rolex)|cheap jerseys|fake designer)\b/i },
  { label: "essay-mill", re: /\b(?:write my essay|essay writing service|do my homework for me)\b/i },
];

/** Web-server and hosting placeholders — live, but not a business site. */
const HOLDING_MARKERS = /(?:welcome to nginx|apache2? (?:ubuntu |debian )?default page|index of \/|it works!|future home of something|this site is under construction|coming soon|default web site page|plesk|cpanel|site not (?:configured|published)|account suspended)/i;

/**
 * Free hosts and platform subdomains — a match there identifies the platform.
 * The list itself lives in lib/verify/hostedPlatforms.js, shared with the
 * map ingest and the contact extractor, so the three cannot disagree about
 * whether `menufy.com` is somebody's website.
 */
const SHARED_HOSTS = /^(?:jobs|boards|apply|careers|my|app)\./i;
const PLATFORM_DOMAINS = { has: (domain) => isHostedPlatformDomain(domain) };

// ─── Positive identity evidence ───────────────────────────────────────────────
// Weighted so that no single weak signal can carry a domain on its own. A
// matching phone number is treated as decisive because a takeover page has no
// reason to carry the real business's number.

const WEIGHTS = {
  PHONE_MATCH: 100,
  JSONLD_NAME: 60,
  TITLE: 50,
  OG_SITE_NAME: 50,
  COPYRIGHT: 40,
  CITY_ON_PAGE: 25,
  DOMAIN_STEM: 25,
  CC_TLD: 20,
  EMAIL_ON_DOMAIN: 15,
};

/** Minimum score for acceptance — reachable only with a real identity signal. */
const ACCEPT_THRESHOLD = 60;

const COUNTRY_TLD = {
  SA: ".sa", AE: ".ae", QA: ".qa", KW: ".kw", BH: ".bh", OM: ".om", EG: ".eg",
  GB: ".uk", DE: ".de", FR: ".fr", NL: ".nl", ES: ".es", IT: ".it", PT: ".pt",
  PK: ".pk", IN: ".in", TR: ".tr", MA: ".ma", JO: ".jo", LB: ".lb",
};

const COUNTRY_NAMES = {
  SA: "saudi|riyadh|jeddah|dammam|khobar|mecca|medina|السعودية|الرياض",
  AE: "emirates|dubai|abu dhabi|sharjah|الإمارات|دبي",
  QA: "qatar|doha|قطر", KW: "kuwait|الكويت", BH: "bahrain|manama|البحرين",
  OM: "oman|muscat|عمان", EG: "egypt|cairo|مصر|القاهرة",
  GB: "united kingdom|england|scotland|wales|london",
  DE: "germany|deutschland", FR: "france", NL: "netherlands", ES: "spain|españa",
  IT: "italy|italia", PT: "portugal", PK: "pakistan", IN: "india", TR: "türkiye|turkey",
};

/** Strip tags once; every text check below reuses the result. */
const toText = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/**
 * Do two company names refer to the same business?
 *
 * Compares on normalised forms and requires a meaningful overlap rather than a
 * substring hit, so "Topkapi" does not match "Topkapi Palace Museum Istanbul"
 * purely because one contains the other's first word.
 */
const namesMatch = (candidate, target) => {
  const a = normalizeCompanyName(candidate);
  const b = normalizeCompanyName(target);
  if (!a || !b) return false;
  if (a === b) return true;

  const aWords = new Set(a.split(" ").filter((w) => w.length >= 3));
  const bWords = new Set(b.split(" ").filter((w) => w.length >= 3));
  if (aWords.size === 0 || bWords.size === 0) return false;

  const overlap = [...bWords].filter((w) => aWords.has(w)).length;
  // Every significant word of the shorter name must appear in the longer one.
  return overlap >= Math.min(aWords.size, bWords.size);
};

/**
 * Read every place a site states its own identity.
 * Deliberately excludes body copy: a page mentioning a company is not the same
 * as a page *being* that company.
 */
const readSelfDeclaredNames = (html) => {
  const $ = cheerio.load(html || "");
  const out = [];

  const title = $("title").first().text().trim();
  if (title) out.push({ where: "title", value: title.slice(0, 200), weight: WEIGHTS.TITLE });

  const ogSite = $('meta[property="og:site_name"]').attr("content")?.trim();
  if (ogSite) out.push({ where: "og:site_name", value: ogSite.slice(0, 200), weight: WEIGHTS.OG_SITE_NAME });

  const appName = $('meta[name="application-name"]').attr("content")?.trim();
  if (appName) out.push({ where: "application-name", value: appName.slice(0, 200), weight: WEIGHTS.OG_SITE_NAME });

  // Schema.org Organization/LocalBusiness is the most explicit statement a site
  // can make about who it is, so it outranks the title.
  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(parsed) ? parsed : [parsed, ...(parsed["@graph"] || [])];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = String(node["@type"] || "");
      if (!/Organization|LocalBusiness|Restaurant|Store|Corporation|NGO/i.test(type)) continue;
      if (typeof node.name === "string" && node.name.trim()) {
        out.push({ where: "schema.org Organization name", value: node.name.trim().slice(0, 200), weight: WEIGHTS.JSONLD_NAME });
      }
    }
  });

  const copyright = /(?:©|&copy;|copyright)[^<]{0,100}/i.exec(html)?.[0];
  if (copyright) {
    out.push({ where: "copyright notice", value: copyright.replace(/\s+/g, " ").trim().slice(0, 200), weight: WEIGHTS.COPYRIGHT });
  }

  return out;
};

/**
 * Verify that a domain currently belongs to a company.
 *
 * Pure with respect to the database — it fetches and judges, nothing more, so
 * it is safe to call from any ingest path and trivially unit-testable.
 *
 * @param {string} domainOrUrl
 * @param {object} company
 * @param {string}   company.name
 * @param {string?}  company.city         only pass when it describes the company itself
 * @param {string?}  company.countryCode
 * @param {string[]} company.phones       known numbers — the strongest evidence available
 * @param {string[]} company.aliases      alternative spellings to accept
 * @param {object}  opts
 * @param {string?} opts.html             skip the fetch when the caller already has the page
 * @param {string?} opts.finalUrl
 * @returns {Promise<{verdict:'OWNED'|'REJECTED'|'UNREACHABLE', score:number, domain:string|null,
 *   reason:string, evidence:string|null, signals:string[], disqualifier:string|null}>}
 */
export const verifyDomainIdentity = async (domainOrUrl, company, opts = {}) => {
  const { name, city = null, countryCode = null, phones = [], aliases = [] } = company || {};
  const startDomain = normalizeDomain(domainOrUrl);

  if (!startDomain || !name) {
    return { verdict: "REJECTED", score: 0, domain: null, reason: "No usable domain or company name to check.", evidence: null, signals: [], disqualifier: "INVALID_INPUT" };
  }
  if (PLATFORM_DOMAINS.has(startDomain)) {
    return { verdict: "REJECTED", score: 0, domain: startDomain, reason: `${startDomain} hosts many businesses, so a match there identifies the platform rather than this company.`, evidence: null, signals: [], disqualifier: "SHARED_PLATFORM" };
  }

  // ── Fetch (unless the caller already holds the page) ──
  let html = opts.html ?? null;
  let finalUrl = opts.finalUrl ?? null;

  if (html == null) {
    const url = /^https?:\/\//i.test(domainOrUrl) ? domainOrUrl : `https://${startDomain}/`;
    const res = await fetchPage(url, { timeoutMs: 12_000, maxBytes: 1_500_000 });
    if (!res.ok || !res.body) {
      return {
        verdict: "UNREACHABLE", score: 0, domain: startDomain,
        reason: `The site could not be read (${res.blockReason || `HTTP ${res.status ?? "error"}`}), so ownership could not be confirmed.`,
        evidence: null, signals: [], disqualifier: null,
      };
    }
    html = res.body;
    finalUrl = res.finalUrl;
  }

  // A redirect to another registrable domain is the site telling us its real
  // address; judge that rather than the address we happened to try.
  const domain = normalizeDomain(finalUrl) || startDomain;
  if (PLATFORM_DOMAINS.has(domain)) {
    return { verdict: "REJECTED", score: 0, domain, reason: `Redirects to ${domain}, a shared platform that cannot identify this company.`, evidence: null, signals: [], disqualifier: "SHARED_PLATFORM" };
  }

  const text = toText(html);
  const haystack = `${text} ${html.slice(0, 4000)}`;

  // ── Disqualifiers first ──
  if (PARKED_MARKERS.test(haystack)) {
    return { verdict: "REJECTED", score: 0, domain, reason: `${domain} is a parked or for-sale domain, not the company's website.`, evidence: null, signals: [], disqualifier: "PARKED" };
  }

  for (const { label, re } of TAKEOVER_MARKERS) {
    const hit = re.exec(haystack);
    if (!hit) continue;
    return {
      verdict: "REJECTED", score: 0, domain,
      reason: `${domain} now serves ${label} content and is almost certainly an expired domain taken over after the business stopped using it.`,
      evidence: `Matched "${hit[0]}" on ${finalUrl || domain}.`,
      signals: [], disqualifier: `TAKEOVER_${label.toUpperCase().replace(/-/g, "_")}`,
    };
  }

  if (HOLDING_MARKERS.test(text.slice(0, 2000))) {
    return { verdict: "REJECTED", score: 0, domain, reason: `${domain} shows a hosting placeholder rather than a real website.`, evidence: null, signals: [], disqualifier: "HOLDING_PAGE" };
  }

  // ── Positive evidence ──
  let score = 0;
  const signals = [];
  let bestEvidence = null;

  const allNames = [name, ...aliases].filter(Boolean);

  for (const decl of readSelfDeclaredNames(html)) {
    if (!allNames.some((n) => namesMatch(decl.value, n))) continue;
    if (decl.weight > score) bestEvidence = `The site's ${decl.where} reads: "${decl.value}"`;
    score = Math.max(score, decl.weight);
    signals.push(`${decl.where} names the company`);
  }

  // A known phone number appearing on the page is the strongest evidence there
  // is — takeover and name-collision pages never carry it.
  const knownPhoneKeys = new Set(phones.map(phoneMatchKey).filter(Boolean));
  if (knownPhoneKeys.size > 0) {
    const observed = extractContacts(html, { pageUrl: finalUrl || `https://${domain}/` });
    const phoneHit = observed.phones.find((p) => knownPhoneKeys.has(phoneMatchKey(p.value)));
    if (phoneHit) {
      score += WEIGHTS.PHONE_MATCH;
      signals.push("the page carries the company's known phone number");
      bestEvidence = `The page publishes ${phoneHit.value}, the number already on record for this company.`;
    }
    // An email on the same registrable domain corroborates without proving.
    if (observed.emails.some((e) => normalizeDomain(e.domain) === domain)) {
      score += WEIGHTS.EMAIL_ON_DOMAIN;
      signals.push(`the page publishes an email on ${domain}`);
    }
  }

  if (city) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(text)) {
      score += WEIGHTS.CITY_ON_PAGE;
      signals.push(`the page mentions ${city}`);
    }
  }

  if (countryCode) {
    const tld = COUNTRY_TLD[countryCode];
    if (tld && domain.endsWith(tld)) {
      score += WEIGHTS.CC_TLD;
      signals.push(`the domain uses the ${tld} country suffix`);
    }
    const names = COUNTRY_NAMES[countryCode];
    if (names && new RegExp(`\\b(?:${names})\\b`, "i").test(text)) {
      score += WEIGHTS.CITY_ON_PAGE;
      signals.push("the page names the same country");
    }
  }

  // The domain reading like the company name is corroboration, never proof —
  // it is exactly what a name collision looks like too.
  const stem = normalizeCompanyName(name).replace(/\s+/g, "");
  const domainStem = domain.split(".")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (stem && domainStem && (domainStem.startsWith(stem) || stem.startsWith(domainStem)) && domainStem.length >= 4) {
    score += WEIGHTS.DOMAIN_STEM;
    signals.push("the domain is built from the company name");
  }

  if (score >= ACCEPT_THRESHOLD) {
    return {
      verdict: "OWNED", score, domain,
      reason: `Confirmed as the website for "${name}" because ${signals.join(", and ")}.`,
      evidence: bestEvidence, signals, disqualifier: null,
    };
  }

  return {
    verdict: "REJECTED", score, domain,
    reason: signals.length
      ? `${domain} shows only weak corroboration (${signals.join(", ")}) and never identifies itself as "${name}" — rejected as a probable name collision.`
      : `${domain} never identifies itself as "${name}".`,
    evidence: bestEvidence, signals, disqualifier: "NO_IDENTITY",
  };
};

export const __testables = { namesMatch, readSelfDeclaredNames, TAKEOVER_MARKERS, SHARED_HOSTS, ACCEPT_THRESHOLD };
