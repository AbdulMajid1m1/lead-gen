import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { auditWebsite } from "../analyze/websiteAudit.js";
import { extractContacts, pickPrimaryEmail } from "../extract/contacts.js";
import { extractOrganizationFromJsonLd } from "../extract/pageMeta.js";
import { verifyDomainIdentity } from "../verify/domainIdentity.js";
import { extractPeople, pickPrimaryPerson } from "../extract/people.js";
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
  { priority: 100, label: "home",    max: 1, test: (p) => p === "/" },
  { priority: 95,  label: "contact", max: 2, test: (p) => /^\/(?:contact|contactus|contact-us|contact-me|kontakt|contacto|contatti|get-in-touch|reach-us|reach-out|connect|enquir(?:y|ies)|inquir(?:y|ies)|request-a-quote|get-a-quote|book-a-call|talk-to-us|write-to-us|اتصل-بنا|تواصل-معنا)$/i.test(p) },
  { priority: 85,  label: "about",   max: 1, test: (p) => /^\/(?:about|about-us|aboutus|company|who-we-are|our-story|ueber-uns|uber-uns|sobre-nosotros|من-نحن|عن-الشركة)$/i.test(p) },
  // A legal or imprint page is the single most reliable email source on the
  // web: German law mandates one, and GDPR/CCPA privacy notices must name a
  // contact address. Many small sites publish an email here and nowhere else.
  { priority: 82,  label: "legal",   max: 1, test: (p) => /^\/(?:impressum|imprint|legal|legal-notice|privacy|privacy-policy|datenschutz|terms|terms-of-service|terms-and-conditions|aviso-legal)$/i.test(p) },
  // Team and leadership pages are where a business names the people who run it,
  // which is what turns "info@" outreach into a message addressed to someone.
  { priority: 80,  label: "team",    max: 1, test: (p) => /^\/(?:team|our-team|meet-the-team|staff|people|our-people|leadership|management|founders|doctors|our-doctors|physicians|lawyers|agents|experts|specialists|فريق-العمل)$/i.test(p) },
  { priority: 75,  label: "careers", max: 1, test: (p) => /^\/(?:careers?|jobs?|vacancies|work-with-us|join-us|join-our-team)$/i.test(p) },
  { priority: 70,  label: "pricing", max: 1, test: (p) => /^\/(?:pricing|plans|packages|rates|tariffs)$/i.test(p) },
  { priority: 68,  label: "locations", max: 1, test: (p) => /^\/(?:locations?|branches|our-branches|stores?|find-us|visit-us|clinics?)$/i.test(p) },
  { priority: 65,  label: "shop",    max: 1, test: (p) => /^\/(?:shop|store|menu|products?|services?|order|book|booking|reservations?|appointments?)$/i.test(p) },
];

/** Locale segments a path may be nested under: /en/contact, /ar-sa/contact-us. */
const LOCALE_SEGMENT_RE = /^\/(?:[a-z]{2}(?:[-_][a-z]{2})?)(?=\/)/i;

/** CMS container segments that add nothing: Shopify's /pages/, WordPress /site/. */
const CONTAINER_SEGMENT_RE = /^\/(?:pages?|site|web|www|home|index|main|content|pg)(?=\/)/i;

/**
 * Reduce a URL path to the form the priority tests expect.
 *
 * Without this the contact-page matcher only ever fired on a bare `/contact`,
 * which is why so many leads had no email. Real sites publish the same page at
 * `/en/contact-us`, `/pages/contact` (every Shopify store), `/contact.html` and
 * `/ar/اتصل-بنا` — all of which were being skipped as "other" and never fetched.
 * Bilingual sites are the norm in the Gulf markets this product targets, so the
 * locale prefix alone accounted for a large share of the missing addresses.
 */
export const canonicalPath = (pathname) => {
  let p = decodeURIComponent(pathname || "/").toLowerCase();
  p = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";

  // A bare locale root ("/en", "/ar-sa") is the localised home page.
  if (/^\/[a-z]{2}(?:[-_][a-z]{2})?$/i.test(p)) return "/";

  // Peel at most two wrapper segments so /en/pages/contact resolves, while a
  // genuinely deep path keeps enough shape to stay classified as "other".
  for (let i = 0; i < 2; i += 1) {
    const stripped = p.replace(LOCALE_SEGMENT_RE, "").replace(CONTAINER_SEGMENT_RE, "");
    if (stripped === p) break;
    p = stripped || "/";
  }

  p = p.replace(/\.(?:html?|php|aspx?|jsp|cfm)$/i, "");
  // Treat separator styles as equivalent: contact_us, contact-us, contactus.
  p = p.replace(/_/g, "-");
  return p || "/";
};

const classifyPath = (pathname) => {
  const canonical = canonicalPath(pathname);
  for (const rule of PAGE_PRIORITY) {
    if (rule.test(canonical)) return rule;
  }
  return { priority: 20, label: "other", max: 0, test: null };
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

  // Most purposes need one page, but contact details are routinely split across
  // two (a "/contact" hub linking a "/get-a-quote" form), so the cap is
  // per-label rather than a flat one-each rule.
  const takenPerLabel = new Map();
  const out = [];
  for (const s of scored) {
    const cap = PAGE_PRIORITY.find((r) => r.label === s.label)?.max ?? 1;
    const taken = takenPerLabel.get(s.label) || 0;
    if (taken >= cap) continue;
    takenPerLabel.set(s.label, taken + 1);
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

  const homePage = pages[0];

  // ─── Identity gate ──────────────────────────────────────────────────────────
  // Does this site actually belong to this company? Every other source hands us
  // a domain on trust: OpenStreetMap's `website` tag can be years out of date,
  // an AI claim is a suggestion, and a guessed `<name>.com` is a coin flip.
  // The page is already fetched at this point, so the check costs no extra
  // request — and it is the only place that covers all four sources at once.
  //
  // This exists because a Riyadh restaurant was being emailed at a domain that
  // had expired with the business and been re-registered by a gambling network.
  // The site returned HTTP 200, so every liveness check passed.
  const identityCompany = await prisma.company.findUnique({
    where: { id: companyId },
    include: { contacts: { where: { kind: "PHONE" } }, locations: { take: 1 }, aliases: true },
  });

  let identity = null;
  if (identityCompany) {
    // A city only describes the company when it came from a map record; a job
    // posting's city would reject a perfectly good head-office website.
    const cityTrusted = Boolean(identityCompany.osmCategory || identityCompany.locations.length > 0);
    identity = await verifyDomainIdentity(homePage.finalUrl || startUrl, {
      name: identityCompany.name,
      city: cityTrusted ? identityCompany.city : null,
      countryCode: cityTrusted ? identityCompany.countryCode : null,
      phones: identityCompany.contacts.map((c) => c.value),
      aliases: identityCompany.aliases.map((a) => a.alias),
    }, { html: homePage.body, finalUrl: homePage.finalUrl });
  }

  // A hostile page is disqualifying on its own terms — its contact details
  // belong to whoever took the domain over, so nothing on it may be recorded.
  const HOSTILE = new Set(["PARKED", "HOLDING_PAGE", "SHARED_PLATFORM"]);
  const isHostile = identity && (HOSTILE.has(identity.disqualifier) || String(identity.disqualifier || "").startsWith("TAKEOVER_"));

  if (isHostile) {
    if (domain) {
      await prisma.companyDomain.updateMany({
        where: { companyId, domain },
        data: {
          identityStatus: "REJECTED", identityScore: identity.score,
          identityReason: identity.reason.slice(0, 500), identityCheckedAt: new Date(),
        },
      });
    }
    await recordFact({
      companyId,
      key: "domain_identity_rejected",
      value: identity.domain || domain,
      confidenceLevel: "VERIFIED",
      extractorName: "websiteIngest",
      evidenceSnippet: `${identity.reason} ${identity.evidence || ""}`.trim().slice(0, 500),
    });
    logger.warn({ companyId, domain: identity.domain, disqualifier: identity.disqualifier }, "website rejected — not this company's site");
    // Stop before extracting anything. Contacts, technologies and the audit
    // would all describe the wrong website.
    return { ok: false, reason: "DOMAIN_NOT_OWNED", identity, pagesCrawled: pages.length, blocked };
  }

  // ─── Analyse ────────────────────────────────────────────────────────────────
  const audit = auditWebsite({ pages });

  const identityFields = identity
    ? {
        identityStatus: identity.verdict === "OWNED" ? "CONFIRMED" : "WEAK",
        identityScore: identity.score,
        identityReason: identity.reason.slice(0, 500),
        identityCheckedAt: new Date(),
      }
    : {};

  const companyDomain = domain
    ? await prisma.companyDomain.upsert({
        where: { domain },
        update: { httpsOk: (homePage.finalUrl || "").startsWith("https://"), ...identityFields },
        create: { companyId, domain, discoveredVia: "WEBSITE_CRAWL", httpsOk: (homePage.finalUrl || "").startsWith("https://"), ...identityFields },
      })
    : null;

  // A site that never says whose it is stays usable but is marked, so the
  // outreach layer and the provenance UI can both see the doubt rather than
  // treating a weak match as fact.
  if (identity && identity.verdict !== "OWNED") {
    await recordFact({
      companyId,
      key: "domain_identity_weak",
      value: identity.domain || domain,
      confidenceLevel: "DETECTED",
      extractorName: "websiteIngest",
      evidenceSnippet: identity.reason.slice(0, 500),
    });
  }

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

  // ─── People ─────────────────────────────────────────────────────────────────
  // Who to actually address. A message to a named owner outperforms one to
  // info@ by a wide margin, and the name is usually published on the same pages
  // we already fetched — the team page most of all, which is why it is now part
  // of the crawl frontier.
  const people = [];
  for (const page of pages) {
    people.push(...extractPeople(page.body, { pageUrl: page.finalUrl, emails: allContacts.emails }));
  }
  const uniquePeople = [...new Map(people.map((p) => [p.fullName.toLowerCase(), p])).values()];

  for (const person of uniquePeople.slice(0, 25)) {
    await prisma.companyPerson.upsert({
      where: { companyId_fullName: { companyId, fullName: person.fullName } },
      update: {
        // Only fill gaps: a later page with a thinner listing must not erase a
        // title or profile URL an earlier, richer page already gave us.
        ...(person.title ? { title: person.title.slice(0, 200), seniority: person.seniority } : {}),
        ...(person.email ? { email: person.email.slice(0, 320) } : {}),
        ...(person.linkedinUrl ? { linkedinUrl: person.linkedinUrl.slice(0, 500) } : {}),
      },
      create: {
        companyId,
        fullName: person.fullName.slice(0, 200),
        title: person.title?.slice(0, 200) ?? null,
        seniority: person.seniority,
        email: person.email?.slice(0, 320) ?? null,
        linkedinUrl: person.linkedinUrl?.slice(0, 500) ?? null,
        observedOnUrl: person.observedOnUrl?.slice(0, 1000) ?? null,
        // DETECTED, not VERIFIED: we observed the name on the company's site,
        // but that the person still works there is an inference.
        confidenceLevel: person.method === "SCHEMA_ORG" ? "VERIFIED" : "DETECTED",
        sourceRecordId: pageSourceRecordId,
      },
    });
  }

  const primaryPerson = pickPrimaryPerson(uniquePeople);
  if (primaryPerson) {
    await recordFact({
      companyId,
      key: "primary_contact_person",
      value: primaryPerson.fullName,
      confidenceLevel: "DETECTED",
      extractorName: "websiteIngest",
      sourceRecordId: pageSourceRecordId,
      evidenceSnippet: `${primaryPerson.fullName}${primaryPerson.title ? `, ${primaryPerson.title}` : ""} — published on ${primaryPerson.observedOnUrl}. Best available outreach target of ${uniquePeople.length} named ${uniquePeople.length === 1 ? "person" : "people"}.`.slice(0, 500),
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
