import pLimit from "p-limit";
import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { extractPageMeta } from "../extract/pageMeta.js";
import { parseStructured, isResearchAvailable } from "../llm/responses.js";
import { PRODUCT_RESEARCH_SYSTEM, buildProductResearchUser, PRODUCT_RESEARCH_SCHEMA } from "../research/prompts.js";
import { normalizeUrl, normalizeDomain } from "../../utils/normalize.js";
import { AI_FAST_MODEL, PROMOTER_MAX_PRODUCT_PAGES } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("promoter");

/**
 * Reads a SaaS product's own website and extracts what it sells.
 *
 * Everything downstream — the ICP, the searches, the emails — is built on this,
 * so the only acceptable source is the product's own pages. The model is given
 * the text we fetched and nothing else, and any URL it cites that we did not
 * actually fetch is discarded: a profile that quietly attributes a price to a
 * page nobody read is worse than a shorter one that is fully traceable.
 */

/**
 * The canonical origin a product is stored and de-duplicated by.
 *
 * The input is typed by a user, so this is also the first SSRF gate. Bare IPs
 * and hosts with no public suffix (localhost, internal names, container
 * hostnames) are rejected here rather than left for the crawler's guard to
 * catch, so an unreachable target never becomes a product row at all.
 */
export const normalizeProductUrl = (input) => {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Anything carrying an explicit non-http scheme is refused outright —
  // "file://", "javascript:" and "data:" are never a product's website.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!normalizeDomain(url.hostname)) return null;

  return `https://${url.hostname.toLowerCase().replace(/^www\./, "")}`;
};

/**
 * The conventional paths tried when a site's own navigation does not link the
 * page. Marketing sites hide pricing behind a JS-rendered menu often enough
 * that guessing four well-known paths is worth the four extra requests.
 */
export const PRODUCT_PAGE_PATHS = ["/pricing", "/features", "/customers", "/about"];

/**
 * What a page has to look like to be worth reading, strongest first. A
 * marketing site is mostly blog and legal pages; these six patterns are where
 * the product actually describes itself.
 */
const PAGE_HINTS = [
  { weight: 100, match: /pricing|\bplans?\b|packages/i },
  { weight: 80, match: /features|\bproduct\b|platform|capabilit/i },
  { weight: 70, match: /customers|clients|case[-_ ]?stud|testimonial|success[-_ ]stor/i },
  { weight: 55, match: /solutions|use[-_ ]?cases?|industries/i },
  { weight: 45, match: /integrations|marketplace|connectors/i },
  { weight: 30, match: /\babout\b|who[-_ ]we[-_ ]are|\bcompany\b/i },
];

/** Sections that never describe the product, however prominently they are linked. */
const NEVER_READ = /\/(?:blog|news|press|careers?|jobs|legal|privacy|terms|cookie|gdpr|login|signin|sign-in|signup|sign-up|register|account|cart|checkout|demo-request|status|sitemap)(?:\/|$)/i;

/** Non-HTML targets a link may point at. Fetching them wastes a page of budget. */
const NOT_A_PAGE = /\.(?:pdf|zip|jpe?g|png|gif|svg|webp|ico|mp4|webm|mp3|css|js|json|xml|rss|woff2?)$/i;

const MIN_PAGE_TEXT = 120;

/**
 * HTML to readable text.
 *
 * Deliberately dependency-free and lossy: the model needs the prose, and every
 * script, style block and inline SVG left in place is budget spent on tokens
 * that say nothing about the product.
 */
export const htmlToText = (html) => {
  if (!html) return "";
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|svg)\b[^>]*\/?>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|ul|ol|tr|td|th|table|h[1-6]|section|article|header|footer|nav|aside|blockquote|figure|form|label)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    // Entities are decoded only after the tags are gone, so an encoded "&lt;p&gt;"
    // in body copy cannot turn into markup the previous step would have stripped.
    .replace(/&nbsp;/gi, " ")
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * Keep only the citations we can prove.
 *
 * A model asked for a sourceUrl will produce a plausible one whether or not it
 * saw the page — "/pricing" is the obvious guess on any SaaS site. Anything not
 * in the set of pages actually fetched is blanked, so a claim can never point
 * at evidence that was never read.
 */
export const keepOnlyFetchedSources = (items, fetchedUrls = []) => {
  const canonical = new Map();
  for (const url of fetchedUrls) {
    const key = normalizeUrl(url);
    if (key) canonical.set(key, url);
  }
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const key = item.sourceUrl ? normalizeUrl(String(item.sourceUrl)) : null;
      return { ...item, sourceUrl: (key && canonical.get(key)) || null };
    });
};

const cleanString = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed || null;
};

/** Why a fetch failed, in a sentence a non-engineer can act on. */
const describeFailure = (url, result) => {
  const reason = result.blockReason || (result.status ? `HTTP_${result.status}` : "NO_RESPONSE");
  const detail = result.blockDetail ? ` — ${String(result.blockDetail).slice(0, 200)}` : "";
  return `${url} could not be read (${reason})${detail}. Nothing was extracted.`;
};

const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};

const sameOrigin = (url, host) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") === host;
  } catch {
    return false;
  }
};

/**
 * Rank the site's own links, then top up with the conventional paths.
 *
 * Ranking beats guessing because a site that calls its pricing page "/plans"
 * still links it from the header; guessing beats ranking when the header is
 * rendered by JavaScript we never executed. Doing both costs at most four
 * extra requests and is the difference between reading a product's prices and
 * inventing an ICP without them.
 */
const discoverProductPages = ({ html, origin, pageUrl }) => {
  const host = new URL(origin).hostname;
  let links = [];
  try {
    links = extractPageMeta(html, pageUrl).links || [];
  } catch (err) {
    logger.warn({ origin, msg: err.message }, "could not read the homepage's links — falling back to conventional paths");
  }

  const homeKey = normalizeUrl(pageUrl) || normalizeUrl(origin);
  const scored = new Map();
  for (const link of links) {
    const key = normalizeUrl(link.href);
    if (!key || key === homeKey || scored.has(key)) continue;
    if (!sameOrigin(key, host)) continue;

    const path = pathOf(key);
    if (!path || path === "/" || NEVER_READ.test(path) || NOT_A_PAGE.test(path)) continue;
    // A page four levels deep is a blog post or a doc page, not the pitch.
    if (path.split("/").filter(Boolean).length > 3) continue;

    const haystack = `${path} ${link.text || ""}`;
    const hint = PAGE_HINTS.find((h) => h.match.test(haystack));
    if (!hint) continue;
    scored.set(key, { url: key, weight: hint.weight, depth: path.split("/").filter(Boolean).length });
  }

  const found = [...scored.values()].sort((a, b) => b.weight - a.weight || a.depth - b.depth).map((c) => c.url);

  const guesses = PRODUCT_PAGE_PATHS
    .filter((path) => !found.some((url) => pathOf(url).toLowerCase().startsWith(path)))
    .map((path) => `${origin}${path}`);

  return [...found, ...guesses];
};

/**
 * Crawl the product's site and extract its profile.
 *
 * Persistence is deliberately not done here — service.js owns every write, so
 * this stays callable from a test or a re-run without touching a row.
 */
export const researchProduct = async ({ productId, tracker = null }) => {
  const product = await prisma.promotedProduct.findUnique({
    where: { id: productId },
    select: { id: true, url: true },
  });
  if (!product) {
    return { ok: false, reason: "This product is no longer in the database.", pagesRead: 0, pageUrls: [], extracted: null };
  }

  const origin = normalizeProductUrl(product.url);
  if (!origin) {
    return {
      ok: false,
      reason: `${product.url} is not a public web address, so there is nothing to read.`,
      pagesRead: 0,
      pageUrls: [],
      extracted: null,
    };
  }

  const home = await fetchPage(origin);
  if (!home.ok) {
    logger.warn({ productId, origin, reason: home.blockReason }, "product homepage unreachable");
    return { ok: false, reason: describeFailure(origin, home), pagesRead: 0, pageUrls: [], extracted: null };
  }

  const homeUrl = home.finalUrl || origin;
  const pages = [{ url: homeUrl, text: htmlToText(home.body) }];
  const seen = new Set([normalizeUrl(homeUrl)]);

  const budget = Math.max(1, PROMOTER_MAX_PRODUCT_PAGES) - 1;
  const candidates = discoverProductPages({ html: home.body, origin, pageUrl: homeUrl }).slice(0, budget);

  // fetchPage already serialises per host, so concurrency here only overlaps
  // the robots and DNS work; three is enough to hide that latency without
  // queueing a pile of requests behind one polite host slot.
  const limit = pLimit(3);
  const results = await Promise.all(
    candidates.map((url) =>
      limit(async () => {
        const res = await fetchPage(url);
        if (!res.ok) {
          logger.debug({ url, reason: res.blockReason }, "product sub-page skipped");
          return null;
        }
        return { url: res.finalUrl || url, text: htmlToText(res.body) };
      }),
    ),
  );

  for (const page of results) {
    if (!page) continue;
    const key = normalizeUrl(page.url);
    // A redirect can land two guesses on the same page; reading it twice would
    // let one restated claim look like two independent sources.
    if (!key || seen.has(key)) continue;
    if (page.text.length < MIN_PAGE_TEXT) continue;
    seen.add(key);
    pages.push(page);
  }

  const pageUrls = pages.map((p) => p.url);
  const pagesRead = pages.length;

  if (!isResearchAvailable()) {
    return {
      ok: true,
      reason: "AI is unavailable — the pages were read but no product profile could be extracted.",
      pagesRead,
      pageUrls,
      extracted: null,
    };
  }

  const result = await parseStructured({
    system: PRODUCT_RESEARCH_SYSTEM,
    user: buildProductResearchUser({ url: origin, pages }),
    schema: PRODUCT_RESEARCH_SCHEMA,
    schemaName: "product_research",
    model: AI_FAST_MODEL,
    timeoutMs: 60_000,
    tracker,
  });

  const data = result?.data;
  if (!data || (!data.name && !data.summary)) {
    logger.warn({ productId, pagesRead }, "no product profile returned — the pages stand on their own");
    return {
      ok: true,
      reason: "The pages were read but no product profile could be extracted from them.",
      pagesRead,
      pageUrls,
      extracted: null,
    };
  }

  const extracted = {
    name: cleanString(data.name, 160),
    summary: cleanString(data.summary, 2000),
    category: cleanString(data.category, 120),
    features: keepOnlyFetchedSources(data.features, pageUrls).filter((f) => f.value),
    pricing: keepOnlyFetchedSources(data.pricing, pageUrls).filter((p) => p.plan),
    differentiators: keepOnlyFetchedSources(data.differentiators, pageUrls).filter((d) => d.value),
    proofPoints: keepOnlyFetchedSources(data.proofPoints, pageUrls).filter((p) => p.value),
    competitors: keepOnlyFetchedSources(data.competitors, pageUrls).filter((c) => c.value),
    geographyCues: keepOnlyFetchedSources(data.geographyCues, pageUrls).filter((g) => g.value),
    targetSizeCues: keepOnlyFetchedSources(data.targetSizeCues, pageUrls).filter((t) => t.value),
    researchedUrls: pageUrls,
    model: result.model || null,
  };

  logger.info({ productId, pagesRead, features: extracted.features.length }, "product profile extracted");
  return { ok: true, reason: null, pagesRead, pageUrls, extracted };
};
