import { detectTechnologies, summarizeStack } from "./techDetect.js";
import { extractPageMeta } from "../extract/pageMeta.js";

/**
 * Static website quality audit.
 *
 * Deliberately headless-browser-free. Every finding below is derivable from the
 * HTML plus response headers, which keeps the crawl cheap, keeps us off the
 * "runs untrusted JS" risk surface, and — more importantly — keeps every claim
 * quotable: each finding carries the evidence that produced it, so the UI can
 * show *why* a site scored 34 rather than asserting it.
 *
 * Six subscores, each 0–100, averaged with the weights below into an overall.
 */

const WEIGHTS = { security: 0.2, mobile: 0.22, performance: 0.15, seo: 0.15, freshness: 0.16, content: 0.12 };

const SEVERITY = { CRITICAL: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

/**
 * @param {{pages: Array<{url,finalUrl,status,headers,body,elapsedMs,bytes,jsRendered}>}} input
 *   `pages[0]` must be the home page.
 * @returns {{overallScore, subscores, findings, meta, stack, technologies}}
 */
export const auditWebsite = ({ pages = [] } = {}) => {
  const home = pages[0];
  if (!home || !home.body) {
    return {
      overallScore: 0,
      subscores: { security: 0, mobile: 0, performance: 0, seo: 0, freshness: 0, content: 0 },
      findings: [{ code: "NO_HOMEPAGE", severity: SEVERITY.CRITICAL, detail: "The home page could not be fetched.", evidence: home?.blockReason || "no response" }],
      meta: null,
      stack: null,
      technologies: [],
      pagesAudited: 0,
    };
  }

  const findings = [];
  const add = (code, severity, detail, evidence) => findings.push({ code, severity, detail, evidence });

  const meta = extractPageMeta(home.body, home.finalUrl || home.url);
  const { technologies, outdated } = detectTechnologies({
    html: pages.map((p) => p.body || "").join("\n"),
    headers: home.headers || {},
    url: home.finalUrl || home.url,
  });
  const stack = summarizeStack({ technologies });

  const finalUrl = home.finalUrl || home.url || "";
  const isHttps = finalUrl.startsWith("https://");
  const headers = home.headers || {};
  const currentYear = new Date().getFullYear();

  // ─── Security ───────────────────────────────────────────────────────────────
  let security = 100;
  if (!isHttps) {
    security -= 55;
    add("NO_HTTPS", SEVERITY.CRITICAL, "The site is served over plain HTTP, so visitor data is unencrypted and browsers flag it as “Not secure”.", `final URL ${finalUrl}`);
  }
  if (isHttps && /http:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}[^"'\s]*\.(?:js|css|jpg|jpeg|png|gif|svg|webp)/i.test(home.body)) {
    security -= 12;
    add("MIXED_CONTENT", SEVERITY.MEDIUM, "The page loads some assets over HTTP on an HTTPS page, which browsers block or warn about.", "http:// asset reference found in markup");
  }
  if (!headers["strict-transport-security"] && isHttps) {
    security -= 6;
    add("NO_HSTS", SEVERITY.LOW, "No Strict-Transport-Security header.", "response headers");
  }
  if (!headers["content-security-policy"]) {
    security -= 6;
    add("NO_CSP", SEVERITY.LOW, "No Content-Security-Policy header.", "response headers");
  }
  for (const eol of outdated) {
    security -= 12;
    add("OUTDATED_LIBRARY", SEVERITY.HIGH, eol.note, eol.evidence || `${eol.name} ${eol.version || ""}`.trim());
  }
  const poweredBy = headers["x-powered-by"];
  if (poweredBy && /php\/[5-7]\./i.test(String(poweredBy))) {
    security -= 10;
    add("EOL_RUNTIME", SEVERITY.HIGH, "The server advertises an end-of-life PHP version that no longer receives security patches.", `x-powered-by: ${poweredBy}`);
  }

  // ─── Mobile ─────────────────────────────────────────────────────────────────
  let mobile = 100;
  if (!meta.hasViewport) {
    mobile -= 60;
    add("NO_VIEWPORT", SEVERITY.CRITICAL, "No mobile viewport tag, so the site renders as a zoomed-out desktop page on phones.", "<meta name=\"viewport\"> absent from the home page");
  } else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i.test(meta.viewport)) {
    mobile -= 12;
    add("VIEWPORT_BLOCKS_ZOOM", SEVERITY.MEDIUM, "The viewport tag disables pinch-zoom, which fails accessibility guidance.", `viewport: ${meta.viewport}`);
  }
  if (/<table[^>]*(?:width\s*=\s*["']?\d{3,}|role=["']presentation)/i.test(home.body)) {
    mobile -= 15;
    add("TABLE_LAYOUT", SEVERITY.HIGH, "The page uses fixed-width table layout, a pre-responsive technique that breaks on mobile.", "fixed-width <table> found");
  }
  if (/<(?:frameset|frame|marquee|center|font)\b/i.test(home.body)) {
    mobile -= 15;
    add("DEPRECATED_HTML", SEVERITY.HIGH, "The page uses HTML elements deprecated for over a decade.", "frameset/marquee/center/font element found");
  }
  if (/<object[^>]+(?:flash|shockwave)|\.swf\b/i.test(home.body)) {
    mobile -= 20;
    add("FLASH_CONTENT", SEVERITY.CRITICAL, "The page references Flash content, which no browser has supported since 2021.", ".swf / Flash object reference");
  }

  // ─── Performance ────────────────────────────────────────────────────────────
  let performance = 100;
  const ttfb = home.elapsedMs ?? 0;
  if (ttfb > 3000) {
    performance -= 35;
    add("VERY_SLOW_RESPONSE", SEVERITY.HIGH, `The home page took ${(ttfb / 1000).toFixed(1)}s to respond.`, `measured ${ttfb}ms`);
  } else if (ttfb > 1500) {
    performance -= 18;
    add("SLOW_RESPONSE", SEVERITY.MEDIUM, `The home page took ${(ttfb / 1000).toFixed(1)}s to respond.`, `measured ${ttfb}ms`);
  }
  const bytes = home.bytes ?? home.body.length;
  if (bytes > 2_000_000) {
    performance -= 25;
    add("HUGE_HTML", SEVERITY.HIGH, `The HTML document alone is ${(bytes / 1024 / 1024).toFixed(1)}MB.`, `${bytes} bytes`);
  } else if (bytes > 800_000) {
    performance -= 10;
    add("LARGE_HTML", SEVERITY.LOW, `The HTML document is ${Math.round(bytes / 1024)}KB.`, `${bytes} bytes`);
  }
  const scriptCount = (home.body.match(/<script\b/gi) || []).length;
  if (scriptCount > 45) {
    performance -= 12;
    add("SCRIPT_BLOAT", SEVERITY.MEDIUM, `The page loads ${scriptCount} script tags.`, `${scriptCount} <script> elements`);
  }
  if (!headers["cache-control"] && !headers.etag && !headers["last-modified"]) {
    performance -= 8;
    add("NO_CACHING_HEADERS", SEVERITY.LOW, "No caching headers, so repeat visitors re-download everything.", "no cache-control / etag / last-modified");
  }

  // ─── SEO ────────────────────────────────────────────────────────────────────
  let seo = 100;
  if (!meta.title) {
    seo -= 30;
    add("NO_TITLE", SEVERITY.HIGH, "The home page has no <title>.", "<title> absent");
  } else if (meta.title.length < 10 || meta.title.length > 70) {
    seo -= 8;
    add("TITLE_LENGTH", SEVERITY.LOW, `The page title is ${meta.title.length} characters, outside the 10–70 range search results display well.`, meta.title.slice(0, 100));
  }
  if (!meta.description) {
    seo -= 18;
    add("NO_META_DESCRIPTION", SEVERITY.MEDIUM, "No meta description, so search engines invent the snippet.", "meta[name=description] absent");
  }
  if (!meta.hasSchemaOrg) {
    seo -= 18;
    add("NO_SCHEMA_ORG", SEVERITY.MEDIUM, "No schema.org structured data, so the business does not qualify for rich results or map panels.", "no JSON-LD or microdata found");
  }
  if ((home.body.match(/<h1\b/gi) || []).length === 0) {
    seo -= 10;
    add("NO_H1", SEVERITY.LOW, "The page has no <h1> heading.", "no <h1> element");
  }
  if (meta.imageCount > 0 && meta.imagesWithoutAlt / meta.imageCount > 0.5) {
    seo -= 8;
    add("MISSING_ALT_TEXT", SEVERITY.LOW, `${meta.imagesWithoutAlt} of ${meta.imageCount} images have no alt text.`, "img elements without alt");
  }
  if (!meta.lang) {
    seo -= 5;
    add("NO_LANG", SEVERITY.LOW, "The <html> element declares no language.", "html[lang] absent");
  }

  // ─── Freshness ──────────────────────────────────────────────────────────────
  let freshness = 100;
  if (meta.copyrightYear) {
    const behind = currentYear - meta.copyrightYear;
    if (behind >= 4) {
      freshness -= 55;
      add("STALE_COPYRIGHT", SEVERITY.HIGH, `The footer still says ${meta.copyrightYear} — ${behind} years out of date, suggesting the site has been untouched for years.`, `copyright ${meta.copyrightYear}`);
    } else if (behind >= 2) {
      freshness -= 30;
      add("STALE_COPYRIGHT", SEVERITY.MEDIUM, `The footer copyright reads ${meta.copyrightYear}, ${behind} years behind.`, `copyright ${meta.copyrightYear}`);
    }
  } else {
    freshness -= 5;
    add("NO_COPYRIGHT_YEAR", SEVERITY.LOW, "No copyright year found, so site currency cannot be confirmed from the page.", "no © year in page text");
  }
  if (stack.cms === "WordPress") {
    const wp = technologies.find((t) => t.name === "WordPress");
    if (wp?.version && Number.parseFloat(wp.version) < 5.9) {
      freshness -= 25;
      add("OUTDATED_CMS", SEVERITY.HIGH, `WordPress ${wp.version} is several major versions behind and is a common breach vector.`, wp.evidence);
    }
  }
  if (!stack.hasAnalytics) {
    freshness -= 12;
    add("NO_ANALYTICS", SEVERITY.MEDIUM, "No analytics tag found, so the business has no visibility into its own web traffic.", "no GA4 / GTM / analytics script detected");
  }

  // ─── Content & capability ───────────────────────────────────────────────────
  let content = 100;
  if (meta.textLength < 400) {
    content -= 30;
    add("THIN_CONTENT", SEVERITY.MEDIUM, `The home page contains only ${meta.textLength} characters of text.`, `${meta.textLength} chars after markup removal`);
  }
  if (home.jsRendered) {
    content -= 10;
    add("CLIENT_RENDERED", SEVERITY.LOW, "The page ships an empty shell and renders client-side, which limits what search engines and previews can read.", "empty root element with no server-rendered text");
  }
  if (!meta.hasContactForm && !/mailto:/i.test(home.body)) {
    content -= 15;
    add("NO_CONTACT_PATH", SEVERITY.MEDIUM, "No contact form or email link was found on the crawled pages.", "no form with an email/message field, no mailto: link");
  }
  if (meta.hasMenuPdf) {
    content -= 10;
    add("PDF_ONLY_MENU", SEVERITY.MEDIUM, "The menu is published as a PDF rather than as web pages — unreadable on phones and invisible to search.", "PDF link near menu text");
  }
  if (meta.mentionsCallToOrder) {
    content -= 8;
    add("MANUAL_ORDERING", SEVERITY.MEDIUM, "The site asks customers to phone in orders or bookings instead of offering them online.", "“call to order / call for reservations” copy found");
  }

  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  const subscores = {
    security: clamp(security),
    mobile: clamp(mobile),
    performance: clamp(performance),
    seo: clamp(seo),
    freshness: clamp(freshness),
    content: clamp(content),
  };

  const overallScore = clamp(
    Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + subscores[key] * weight, 0),
  );

  const severityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return { overallScore, subscores, findings, meta, stack, technologies, outdated, pagesAudited: pages.length };
};
