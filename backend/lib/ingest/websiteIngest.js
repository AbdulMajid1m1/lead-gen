import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { auditWebsite } from "../analyze/websiteAudit.js";
import { extractContacts, pickPrimaryEmail } from "../extract/contacts.js";
import { extractOrganizationFromJsonLd } from "../extract/pageMeta.js";
import { ensureSource, recordSourceRecord, recordFact, recordContact } from "../provenance/recorder.js";
import { normalizeUrl, normalizeDomain } from "../../utils/normalize.js";
import { sha256 } from "../../utils/hash.js";
import { CRAWLER_MAX_PAGES_PER_HOST } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("websiteIngest");

/**
 * Which pages are worth fetching, and in what order.
 *
 * Crawling an entire site would be slow, rude and mostly useless — the business
 * facts we need live on a handful of predictable pages.
 */
const PAGE_PRIORITY = [
  { priority: 100, label: "home", test: (p) => p === "/" || p === "" },
  { priority: 90, label: "contact", test: (p) => /^\/(?:contact|contact-us|kontakt|get-in-touch|reach-us)\/?$/i.test(p) },
  { priority: 80, label: "about", test: (p) => /^\/(?:about|about-us|company|who-we-are|our-story)\/?$/i.test(p) },
  { priority: 75, label: "careers", test: (p) => /^\/(?:careers?|jobs?|vacancies|work-with-us|join-us)\/?$/i.test(p) },
  { priority: 70, label: "pricing", test: (p) => /^\/(?:pricing|plans|packages)\/?$/i.test(p) },
  { priority: 65, label: "shop", test: (p) => /^\/(?:shop|store|menu|products?|order|book|booking|reservations?|appointments?)\/?$/i.test(p) },
];

const classifyPath = (pathname) => {
  for (const rule of PAGE_PRIORITY) {
    if (rule.test(pathname)) return rule;
  }
  return { priority: 20, label: "other", test: null };
};

/** Pick the highest-value internal links from a crawled page. */
const selectFollowUpUrls = (links, origin, alreadyQueued, limit) => {
  const scored = [];
  for (const link of links) {
    let url;
    try {
      url = new URL(link.href);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const normalized = normalizeUrl(url.href);
    if (!normalized || alreadyQueued.has(normalized)) continue;
    if (/\.(?:pdf|jpe?g|png|gif|svg|webp|zip|mp4|mp3|docx?|xlsx?)$/i.test(url.pathname)) continue;

    const rule = classifyPath(url.pathname.replace(/\/+$/, "") || "/");
    if (rule.label === "other") continue; // only follow known-valuable pages
    scored.push({ url: normalized, priority: rule.priority, label: rule.label });
  }
  scored.sort((a, b) => b.priority - a.priority);

  const seenLabels = new Set();
  const out = [];
  for (const s of scored) {
    if (seenLabels.has(s.label)) continue; // one page per purpose is enough
    seenLabels.add(s.label);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
};

/**
 * Crawl a company's website, store every fetch with its provenance, and derive
 * technologies, contacts, an audit and the facts the signal engine reads.
 */
export const ingestWebsite = async ({ companyId, url, maxPages = CRAWLER_MAX_PAGES_PER_HOST, discoveryRunId = null }) => {
  const startUrl = normalizeUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  if (!startUrl) return { ok: false, reason: "INVALID_URL" };

  const source = await ensureSource({
    kind: "WEBSITE_CRAWL",
    name: "Company website",
    attribution: "Fetched from the company's own public website, honouring robots.txt.",
  });

  const origin = new URL(startUrl).origin;
  const domain = normalizeDomain(startUrl);
  const queued = new Set([startUrl]);
  const queue = [{ url: startUrl, priority: 100, label: "home" }];
  const pages = [];
  const blocked = [];

  while (queue.length && pages.length < maxPages) {
    const next = queue.shift();
    const crawlRequest = await prisma.crawlRequest.upsert({
      where: { urlHash: sha256(next.url) },
      update: { status: "FETCHING", attempts: { increment: 1 }, discoveryRunId },
      create: {
        url: next.url,
        urlHash: sha256(next.url),
        host: new URL(next.url).host,
        priority: next.priority,
        companyId,
        discoveryRunId,
        status: "FETCHING",
        attempts: 1,
      },
    });

    const res = await fetchPage(next.url);

    // The raw HTML is stored as a SourceRecord so every fact extracted from it
    // has something immutable to point at.
    let sourceRecord = null;
    if (res.ok && res.body) {
      sourceRecord = await recordSourceRecord({
        sourceId: source.id,
        externalId: null,
        url: res.finalUrl,
        payload: { url: res.finalUrl, status: res.status, contentHash: res.contentHash, html: res.body.slice(0, 400_000) },
      });
    }

    const status = res.ok ? "SUCCESS"
      : res.robotsAllowed === false ? "ROBOTS_DENIED"
      : res.blockReason?.startsWith("SSRF") ? "SSRF_BLOCKED"
      : res.blockReason === "TIMEOUT" ? "TIMEOUT"
      : res.blockReason ? "BLOCKED"
      : "ERROR";

    await prisma.crawlRequest.update({
      where: { id: crawlRequest.id },
      data: {
        status,
        robotsDecision: res.robotsAllowed === true ? "ALLOWED" : res.robotsAllowed === false ? "DENIED" : "UNREACHABLE",
      },
    });

    await prisma.crawlResult.upsert({
      where: { crawlRequestId: crawlRequest.id },
      update: {
        httpStatus: res.status, ok: res.ok, blockReason: res.blockReason, blockDetail: res.blockDetail?.slice(0, 500),
        contentType: res.contentType?.slice(0, 100), bytes: res.bytes, totalMs: res.elapsedMs,
        contentHash: res.contentHash, finalUrl: res.finalUrl, redirectChain: res.redirects,
        jsRendered: res.jsRendered, sourceRecordId: sourceRecord?.id ?? null, fetchedAt: new Date(),
      },
      create: {
        crawlRequestId: crawlRequest.id,
        httpStatus: res.status, ok: res.ok, blockReason: res.blockReason, blockDetail: res.blockDetail?.slice(0, 500),
        contentType: res.contentType?.slice(0, 100), bytes: res.bytes, totalMs: res.elapsedMs,
        contentHash: res.contentHash, finalUrl: res.finalUrl, redirectChain: res.redirects,
        jsRendered: res.jsRendered, sourceRecordId: sourceRecord?.id ?? null,
      },
    });

    if (!res.ok) {
      blocked.push({ url: next.url, reason: res.blockReason, detail: res.blockDetail });
      // The very first page failing means there is nothing to audit.
      if (pages.length === 0 && queue.length === 0) break;
      continue;
    }

    const crawlResult = await prisma.crawlResult.findUnique({ where: { crawlRequestId: crawlRequest.id } });
    pages.push({ ...res, label: next.label, sourceRecordId: sourceRecord?.id, crawlResultId: crawlResult?.id });

    // Expand the frontier from the home page only — deeper pages rarely reveal
    // new page *types*, and every extra hop is another request on someone's site.
    if (next.label === "home") {
      const { extractPageMeta } = await import("../extract/pageMeta.js");
      const meta = extractPageMeta(res.body, res.finalUrl);
      for (const candidate of selectFollowUpUrls(meta.links, origin, queued, maxPages - 1)) {
        queued.add(candidate.url);
        queue.push(candidate);
      }
    }
  }

  if (pages.length === 0) {
    await recordFact({
      companyId,
      key: "website_unreachable",
      value: "true",
      confidenceLevel: "VERIFIED",
      extractorName: "websiteIngest",
      evidenceSnippet: blocked[0] ? `${blocked[0].reason}: ${blocked[0].detail || ""}`.slice(0, 500) : "No page could be fetched.",
    });
    return { ok: false, reason: blocked[0]?.reason || "NO_PAGES", blocked, pagesCrawled: 0 };
  }

  // ─── Analyse ────────────────────────────────────────────────────────────────
  const audit = auditWebsite({ pages });
  const homePage = pages[0];

  const companyDomain = domain
    ? await prisma.companyDomain.upsert({
        where: { domain },
        update: { httpsOk: (homePage.finalUrl || "").startsWith("https://") },
        create: { companyId, domain, discoveredVia: "WEBSITE_CRAWL", httpsOk: (homePage.finalUrl || "").startsWith("https://") },
      })
    : null;

  // Technologies
  for (const tech of audit.technologies) {
    await prisma.technologyDetection.upsert({
      where: { companyId_techSlug: { companyId, techSlug: slugify(tech.name) } },
      update: {
        techName: tech.name, category: tech.category, version: tech.version,
        confidence: tech.confidence, matchedOn: tech.matchedOn, evidence: tech.evidence?.slice(0, 1000),
        crawlResultId: homePage.crawlResultId, lastSeenAt: new Date(), domainId: companyDomain?.id ?? null,
      },
      create: {
        companyId, domainId: companyDomain?.id ?? null, techSlug: slugify(tech.name),
        techName: tech.name, category: tech.category, version: tech.version,
        confidence: tech.confidence, matchedOn: tech.matchedOn, evidence: tech.evidence?.slice(0, 1000),
        crawlResultId: homePage.crawlResultId,
      },
    });
  }

  // Audit
  if (companyDomain) {
    await prisma.websiteAudit.create({
      data: {
        companyId, domainId: companyDomain.id,
        overallScore: audit.overallScore, subscores: audit.subscores, findings: audit.findings,
        pagesAudited: pages.length,
      },
    });
  }

  // Contacts — searched across every crawled page, since the contact page is
  // usually not the home page.
  const allContacts = { emails: [], phones: [], socials: [] };
  for (const page of pages) {
    const found = extractContacts(page.body, { pageUrl: page.finalUrl });
    allContacts.emails.push(...found.emails);
    allContacts.phones.push(...found.phones);
    allContacts.socials.push(...found.socials);
  }
  const dedupe = (arr, key) => [...new Map(arr.map((x) => [x[key], x])).values()];
  allContacts.emails = dedupe(allContacts.emails, "value");
  allContacts.phones = dedupe(allContacts.phones, "value");
  allContacts.socials = dedupe(allContacts.socials, "url");

  const pageSourceRecordId = pages.find((p) => p.sourceRecordId)?.sourceRecordId ?? null;

  for (const email of allContacts.emails) {
    await recordContact({
      companyId, kind: "EMAIL", value: email.value, roleHint: email.kind,
      confidenceLevel: email.method === "MAILTO_LINK" ? "VERIFIED" : "DETECTED",
      sourceRecordId: pageSourceRecordId,
    });
  }
  for (const phone of allContacts.phones.slice(0, 5)) {
    await recordContact({
      companyId, kind: "PHONE", value: phone.value, roleHint: phone.method,
      confidenceLevel: phone.method === "TEL_LINK" ? "VERIFIED" : "DETECTED",
      sourceRecordId: pageSourceRecordId,
    });
  }
  for (const social of allContacts.socials.slice(0, 8)) {
    await recordContact({
      companyId, kind: "SOCIAL", value: social.url, roleHint: social.network,
      confidenceLevel: "VERIFIED", sourceRecordId: pageSourceRecordId,
    });
  }
  if (audit.meta?.hasContactForm) {
    const formPage = pages.find((p) => p.label === "contact") || homePage;
    await recordContact({
      companyId, kind: "CONTACT_FORM", value: formPage.finalUrl, roleHint: "FORM",
      confidenceLevel: "VERIFIED", sourceRecordId: pageSourceRecordId,
    });
  }

  // ─── Facts the signal engine reads ──────────────────────────────────────────
  const m = audit.meta;
  const facts = [
    ["website_title", m.title, "DETECTED", m.title],
    ["website_description", m.description, "DETECTED", m.description],
    ["viewport_meta", String(m.hasViewport), "VERIFIED", m.viewport || "absent"],
    ["copyright_year", m.copyrightYear ? String(m.copyrightYear) : null, "VERIFIED", m.copyrightYear ? `© ${m.copyrightYear}` : null],
    ["has_schema_org", String(m.hasSchemaOrg), "VERIFIED", m.hasJsonLd ? "JSON-LD present" : m.hasMicrodata ? "microdata present" : "none"],
    ["has_online_ordering", String(m.hasOnlineOrdering || m.hasCartLink), "DETECTED", m.hasOnlineOrdering ? "ordering/delivery link found" : m.hasCartLink ? "cart link found" : "no ordering path found"],
    ["has_cart_link", String(m.hasCartLink), "DETECTED", null],
    ["has_booking_link", String(m.hasBookingLink), "DETECTED", m.hasBookingLink ? "booking/reservation link found" : "no booking path found"],
    ["mentions_growth", String(m.mentionsGrowth), "DETECTED", m.mentionsGrowth ? "expansion wording found on site" : null],
    ["manual_ordering_hint", String(m.mentionsCallToOrder), "DETECTED", m.mentionsCallToOrder ? "“call to order/book” copy found" : null],
    ["website_audit_score", String(audit.overallScore), "VERIFIED", `Audit ${audit.overallScore}/100 across ${pages.length} pages`],
    ["pages_crawled", String(pages.length), "VERIFIED", pages.map((p) => p.label).join(", ")],
  ];
  for (const [key, value, confidence, evidence] of facts) {
    if (value === null || value === undefined) continue;
    await recordFact({
      companyId, key, value, confidenceLevel: confidence,
      extractorName: "websiteIngest", evidenceSnippet: evidence,
      sourceRecordId: pageSourceRecordId, crawlResultId: homePage.crawlResultId,
    });
  }

  if (pages.some((p) => p.label === "careers")) {
    await recordFact({
      companyId, key: "careers_page_active", value: "true", confidenceLevel: "VERIFIED",
      extractorName: "websiteIngest", evidenceSnippet: "A careers page exists on the company website.",
      sourceRecordId: pageSourceRecordId,
    });
  }

  // schema.org business identity is the cleanest structured data on the web.
  const org = extractOrganizationFromJsonLd(m.jsonLd);
  if (org) {
    await recordFact({
      companyId, key: "schema_org_business", value: org.name || null, valueJson: org,
      confidenceLevel: "VERIFIED", extractorName: "websiteIngest",
      evidenceSnippet: `schema.org ${org.schemaType} block published by the site itself.`,
      sourceRecordId: pageSourceRecordId,
    });
    if (org.email) await recordContact({ companyId, kind: "EMAIL", value: org.email, roleHint: "SCHEMA_ORG", confidenceLevel: "VERIFIED", sourceRecordId: pageSourceRecordId });
    if (org.telephone) await recordContact({ companyId, kind: "PHONE", value: org.telephone, roleHint: "SCHEMA_ORG", confidenceLevel: "VERIFIED", sourceRecordId: pageSourceRecordId });
  }

  await prisma.company.update({
    where: { id: companyId },
    data: {
      lastCrawledAt: new Date(),
      lastEnrichedAt: new Date(),
      // The site's own meta description is the best plain-language answer to
      // "what is this company" we can get without an AI — surface it.
      ...(m.description ? { description: m.description.slice(0, 1000) } : {}),
    },
  });

  logger.info(
    { companyId, pages: pages.length, blocked: blocked.length, auditScore: audit.overallScore, tech: audit.technologies.length },
    "website ingested",
  );

  return {
    ok: true,
    pagesCrawled: pages.length,
    blocked,
    auditScore: audit.overallScore,
    audit,
    contacts: allContacts,
    primaryEmail: pickPrimaryEmail(allContacts.emails, domain),
  };
};

const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
