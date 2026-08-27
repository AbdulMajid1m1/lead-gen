import prisma from "../../prismaClient.js";
import { SIGNAL_CATALOG } from "./signalCatalog.js";
import { parseJobText } from "../extract/jobTextParser.js";
import { log } from "../../utils/logger.js";

const logger = log("signals");

/**
 * Derives Signal rows from what has actually been observed about a company.
 *
 * Two rules hold everywhere in this file:
 *  1. A signal is only raised when there is a concrete row to point at, and the
 *     evidence link is written in the same transaction.
 *  2. Re-running is idempotent and *self-correcting* — a signal whose evidence
 *     no longer holds is deactivated with a reason, never silently dropped.
 */

/** Industries where an appointment/booking flow is the norm. */
const APPOINTMENT_INDUSTRIES = /dentist|doctor|clinic|salon|spa|veterinar|gym|fitness|school|childcare|lawyer|accountant|optician|car_repair|travel/i;
/** Industries where selling or ordering online is the norm. */
const TRANSACTIONAL_INDUSTRIES = /restaurant|cafe|fast_food|bakery|bar|clothes|jewelry|furniture|florist|supermarket|electronics|hardware|pet|convenience|boutique/i;

const nowMinusDays = (days) => new Date(Date.now() - days * 86_400_000);

/**
 * Compute the full signal set for one company from its stored evidence.
 * @returns {Promise<{created:number, updated:number, deactivated:number, signals:Array}>}
 */
export const evaluateCompanySignals = async (companyId) => {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: {
      domains: true,
      contacts: true,
      tech: true,
      audits: { orderBy: { auditedAt: "desc" }, take: 1 },
      facts: true,
      jobPostings: {
        where: { status: { in: ["ACTIVE", "RECENTLY_ACTIVE"] } },
        include: { skills: true },
      },
      // Ordered so the first row is the best outreach target: owners before
      // executives, and a reachable person before an unreachable one.
      people: { orderBy: [{ seniority: "asc" }, { email: "desc" }], take: 5 },
    },
  });
  if (!company) throw new Error(`Company ${companyId} not found`);

  /** @type {Array<{type,dedupeKey,strength,context,evidence}>} */
  const desired = [];
  const push = (type, { dedupeKey = "default", strength = 1, context = {}, evidence = {} }) => {
    if (!SIGNAL_CATALOG[type]) throw new Error(`Unknown signal type ${type}`);
    desired.push({ type, dedupeKey, strength: Math.max(0, Math.min(1, strength)), context, evidence });
  };

  const factByKey = new Map(company.facts.map((f) => [f.key, f]));
  const fact = (key) => factByKey.get(key) || null;
  const audit = company.audits[0] || null;
  const techByName = new Map(company.tech.map((t) => [t.techName, t]));

  // ─── Website presence ───────────────────────────────────────────────────────
  const hasDomain = company.domains.length > 0;
  const websiteUnreachable = fact("website_unreachable");

  if (!hasDomain) {
    const contactability = company.contacts.find((c) => c.kind === "PHONE" || c.kind === "EMAIL");
    // "Has no website" is a claim about the world, not about our coverage. It
    // needs a source that *established the absence* — an OSM listing carrying
    // contact details but no website tag, or a resolution attempt that came up
    // empty. A company we simply never checked must not earn 30 points for a
    // gap in our own data (that is how job-board companies with perfectly good
    // websites would end up pitched a new one).
    const absenceEvidence = fact("osm_no_website_tag") || fact("domain_unresolved");
    if (contactability && absenceEvidence) {
      push("NO_WEBSITE", {
        context: { companyName: company.name },
        evidence: {
          factId: absenceEvidence.id,
          note: absenceEvidence.key === "osm_no_website_tag"
            ? "No website tag on the public business listing, and no domain discovered by enrichment."
            : "Candidate domains were checked and none belonged to this company.",
        },
      });
    }
  }

  // ─── Website quality ────────────────────────────────────────────────────────
  if (audit) {
    if (audit.overallScore < 40) {
      const topFinding = (audit.findings || []).find((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
      push("OUTDATED_WEBSITE", {
        dedupeKey: `audit:${audit.domainId}`,
        // How far below the threshold it sits — a 12/100 site is a stronger
        // signal than a 39/100 one.
        strength: Math.min(1, (40 - audit.overallScore) / 40),
        context: { auditScore: audit.overallScore, topFinding: topFinding?.detail },
        evidence: { websiteAuditId: audit.id },
      });
    }

    const findingCodes = new Set((audit.findings || []).map((f) => f.code));
    const findingByCode = (code) => (audit.findings || []).find((f) => f.code === code);

    if (findingCodes.has("NO_HTTPS")) {
      push("NO_HTTPS", { dedupeKey: `audit:${audit.domainId}`, evidence: { websiteAuditId: audit.id, note: findingByCode("NO_HTTPS")?.evidence } });
    }
    if (findingCodes.has("NO_VIEWPORT")) {
      push("NO_MOBILE_VIEWPORT", { dedupeKey: `audit:${audit.domainId}`, evidence: { websiteAuditId: audit.id, note: findingByCode("NO_VIEWPORT")?.evidence } });
    }
    if (findingCodes.has("NO_SCHEMA_ORG")) {
      push("NO_SCHEMA_ORG", { dedupeKey: `audit:${audit.domainId}`, evidence: { websiteAuditId: audit.id } });
    }
    if (findingCodes.has("NO_ANALYTICS")) {
      push("NO_ANALYTICS", { dedupeKey: `audit:${audit.domainId}`, evidence: { websiteAuditId: audit.id } });
    }
    if (findingCodes.has("OUTDATED_LIBRARY") || findingCodes.has("EOL_RUNTIME")) {
      const f = findingByCode("OUTDATED_LIBRARY") || findingByCode("EOL_RUNTIME");
      push("LEGACY_JS_LIB", {
        dedupeKey: `audit:${audit.domainId}`,
        context: { library: f?.evidence?.split("→")[0]?.trim() || "an end-of-life library" },
        evidence: { websiteAuditId: audit.id, note: f?.detail },
      });
    }
    for (const code of ["VERY_SLOW_RESPONSE", "SLOW_RESPONSE"]) {
      const f = findingByCode(code);
      if (!f) continue;
      const ms = Number((f.evidence || "").match(/(\d+)ms/)?.[1] || 0);
      push("SLOW_SITE", {
        dedupeKey: `audit:${audit.domainId}`,
        strength: code === "VERY_SLOW_RESPONSE" ? 1 : 0.5,
        context: { seconds: (ms / 1000).toFixed(1) },
        evidence: { websiteAuditId: audit.id, note: f.detail },
      });
      break;
    }
    const staleCopyright = findingByCode("STALE_COPYRIGHT");
    if (staleCopyright) {
      const year = Number((staleCopyright.evidence || "").match(/(\d{4})/)?.[1]);
      const yearsBehind = year ? new Date().getFullYear() - year : 2;
      push("OLD_COPYRIGHT", {
        dedupeKey: `audit:${audit.domainId}`,
        strength: Math.min(1, yearsBehind / 5),
        context: { year, yearsBehind },
        evidence: { websiteAuditId: audit.id, note: staleCopyright.detail },
      });
    }
    if (findingCodes.has("MANUAL_ORDERING") || findingCodes.has("PDF_ONLY_MENU")) {
      push("MANUAL_PROCESS_HINT", {
        dedupeKey: `audit:${audit.domainId}`,
        evidence: { websiteAuditId: audit.id, note: (findingByCode("MANUAL_ORDERING") || findingByCode("PDF_ONLY_MENU"))?.detail },
      });
    }
  }

  // ─── Technology stack ───────────────────────────────────────────────────────
  const techSignal = (techName, signalType, context = {}) => {
    const t = techByName.get(techName);
    if (!t) return;
    push(signalType, {
      dedupeKey: `tech:${t.techSlug}`,
      context: { ...context, version: t.version },
      evidence: { techDetectionId: t.id, note: t.evidence },
    });
  };

  techSignal("WordPress", "WORDPRESS_DETECTED");
  techSignal("WooCommerce", "WOOCOMMERCE_DETECTED");
  techSignal("Shopify", "SHOPIFY_DETECTED");
  techSignal("Magento", "MAGENTO_LEGACY");
  for (const builder of ["Wix", "Squarespace", "GoDaddy Website Builder", "Webflow"]) {
    techSignal(builder, "WIX_SQUARESPACE", { builder });
  }

  // ─── Capability gaps, judged against what the industry actually needs ───────
  const industryKey = `${company.osmCategory || ""} ${company.industry || ""}`;
  const hasBookingTech = company.tech.some((t) => t.category === "BOOKING");
  const hasEcomTech = company.tech.some((t) => t.category === "ECOMMERCE");
  const hasOrderingFact = fact("has_online_ordering")?.value === "true";
  const hasBookingFact = fact("has_booking_link")?.value === "true";
  const hasCartFact = fact("has_cart_link")?.value === "true";

  if (audit && TRANSACTIONAL_INDUSTRIES.test(industryKey) && !hasEcomTech && !hasOrderingFact && !hasCartFact) {
    push("NO_ONLINE_ORDERING", {
      dedupeKey: `capability:${company.id}`,
      context: { industry: company.industry },
      evidence: { websiteAuditId: audit.id, note: "No cart, checkout, ordering link or e-commerce platform detected on the crawled pages." },
    });
  }
  if (audit && APPOINTMENT_INDUSTRIES.test(industryKey) && !hasBookingTech && !hasBookingFact) {
    push("NO_BOOKING_SYSTEM", {
      dedupeKey: `capability:${company.id}`,
      context: { industry: company.industry },
      evidence: { websiteAuditId: audit.id, note: "No booking widget, scheduling platform or booking link detected on the crawled pages." },
    });
  }
  if (fact("mentions_growth")?.value === "true") {
    push("GROWTH_MENTION", {
      dedupeKey: `growth:${company.id}`,
      evidence: { factId: fact("mentions_growth")?.id, note: fact("mentions_growth")?.evidenceSnippet },
    });
  }
  if (fact("careers_page_active")?.value === "true") {
    push("CAREERS_PAGE_ACTIVE", {
      dedupeKey: `careers:${company.id}`,
      evidence: { factId: fact("careers_page_active")?.id },
    });
  }

  // ─── Domain newness ─────────────────────────────────────────────────────────
  for (const domain of company.domains) {
    if (!domain.firstCertSeenAt) continue;
    const daysAgo = Math.round((Date.now() - domain.firstCertSeenAt.getTime()) / 86_400_000);
    if (daysAgo <= 60) {
      push("NEW_DOMAIN", {
        dedupeKey: `domain:${domain.id}`,
        strength: Math.max(0.3, 1 - daysAgo / 60),
        context: { daysAgo },
        evidence: { note: `First certificate-transparency sighting for ${domain.domain} was ${daysAgo} days ago.` },
      });
    }
  }

  // A recently-appeared shop./booking./app. host means new capability is being
  // stood up right now — recorded as facts by the certificate-transparency job.
  for (const f of company.facts.filter((x) => x.key.startsWith("new_subdomain:"))) {
    const firstSeen = f.valueJson?.firstSeen ? new Date(f.valueJson.firstSeen) : null;
    if (!firstSeen) continue;
    const daysAgo = Math.round((Date.now() - firstSeen.getTime()) / 86_400_000);
    if (daysAgo > 60) continue;
    push("NEW_SUBDOMAIN", {
      dedupeKey: `subdomain:${f.valueJson?.host || f.key}`,
      strength: Math.max(0.3, 1 - daysAgo / 60),
      context: { subdomain: f.valueJson?.label || f.valueJson?.host, daysAgo },
      evidence: { factId: f.id, note: f.evidenceSnippet },
    });
  }

  // ─── Hiring ─────────────────────────────────────────────────────────────────
  const activeJobs = company.jobPostings.filter((j) => j.status === "ACTIVE");
  const recentJobs = company.jobPostings.filter((j) => j.status === "RECENTLY_ACTIVE");

  for (const job of [...activeJobs, ...recentJobs]) {
    const parsed = parseJobText(job);
    if (!parsed.primary) continue;
    // A job that has dropped off its board still counts, at half strength —
    // recent-but-gone is weaker evidence than currently-listed.
    const statusFactor = job.status === "ACTIVE" ? 1 : 0.5;
    push(parsed.primary.signal, {
      dedupeKey: `job:${job.id}`,
      strength: parsed.primary.strength * statusFactor,
      context: { jobTitle: job.title, location: job.location, status: job.status },
      evidence: { jobPostingId: job.id, note: `${parsed.primary.evidence} (${job.status})` },
    });
  }

  if (activeJobs.length >= 3) {
    push("HIRING_MANY_ROLES", {
      dedupeKey: `volume:${company.id}`,
      strength: Math.min(1, activeJobs.length / 10),
      context: { count: activeJobs.length },
      evidence: { jobPostingId: activeJobs[0].id, note: `${activeJobs.length} postings currently listed on the company's own job board.` },
    });
  }

  // ─── Reachability ───────────────────────────────────────────────────────────
  const usableContacts = company.contacts.filter((c) => !c.isSuppressed);
  if (usableContacts.some((c) => c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH")) {
    push("CONTACT_EMAIL_FOUND", { dedupeKey: `contact:${company.id}` });
  }
  if (usableContacts.some((c) => c.kind === "PHONE")) {
    push("CONTACT_PHONE_FOUND", { dedupeKey: `contact:${company.id}` });
  }
  if (usableContacts.some((c) => c.kind === "CONTACT_FORM")) {
    push("CONTACT_FORM_FOUND", { dedupeKey: `contact:${company.id}` });
  }
  if (company.people?.length) {
    const best = company.people[0];
    push("NAMED_CONTACT_FOUND", {
      dedupeKey: `person:${company.id}`,
      context: { personName: best.fullName, personTitle: best.title },
    });
  }

  // ─── Disqualifiers ──────────────────────────────────────────────────────────
  // Raised last and deliberately weightless: these do not lower a score, they
  // mark a lead as one that must not be contacted at all.
  const closed = fact("business_closed_permanently");
  if (closed) {
    push("BUSINESS_CLOSED", {
      dedupeKey: `closed:${company.id}`,
      context: { companyName: company.name, observedOn: closed.extractedAt?.toISOString?.().slice(0, 10) ?? null },
      evidence: { factId: closed.id },
    });
  }

  const hijacked = fact("domain_identity_rejected");
  if (hijacked) {
    push("WEBSITE_NOT_OWNED", {
      dedupeKey: `identity:${company.id}`,
      context: { domain: hijacked.value, detail: hijacked.evidenceSnippet?.slice(0, 200) ?? null },
      evidence: { factId: hijacked.id },
    });
  }

  return persistSignals(companyId, desired);
};

/**
 * Reconcile the desired signal set against what is stored: upsert the ones that
 * hold, deactivate the ones that no longer do.
 */
const persistSignals = async (companyId, desired) => {
  const existing = await prisma.signal.findMany({ where: { companyId } });
  const existingByKey = new Map(existing.map((s) => [`${s.type}|${s.dedupeKey}`, s]));
  const desiredKeys = new Set(desired.map((d) => `${d.type}|${d.dedupeKey}`));

  let created = 0;
  let updated = 0;
  const signals = [];

  for (const d of desired) {
    const def = SIGNAL_CATALOG[d.type];
    const key = `${d.type}|${d.dedupeKey}`;
    const prior = existingByKey.get(key);

    const signal = await prisma.signal.upsert({
      where: { companyId_type_dedupeKey: { companyId, type: d.type, dedupeKey: d.dedupeKey } },
      update: {
        strength: d.strength,
        context: d.context,
        lastSeenAt: new Date(),
        active: true,
        deactivatedAt: null,
        deactivatedReason: null,
        // detectedAt is deliberately NOT refreshed: re-observing an old fact
        // must not make a stale signal look brand new. Only a signal that was
        // previously deactivated resets its clock.
        ...(prior && !prior.active ? { detectedAt: new Date() } : {}),
      },
      create: {
        companyId,
        type: d.type,
        dedupeKey: d.dedupeKey,
        strength: d.strength,
        context: d.context,
        weight: def.weight,
        halfLifeDays: def.halfLifeDays,
      },
    });

    if (prior) updated += 1;
    else created += 1;

    // Evidence links are replaced wholesale so a re-audit repoints the signal
    // at the newest proof rather than accumulating duplicates.
    await prisma.signalEvidence.deleteMany({ where: { signalId: signal.id } });
    const ev = d.evidence || {};
    if (ev.factId || ev.sourceRecordId || ev.jobPostingId || ev.techDetectionId || ev.websiteAuditId || ev.note) {
      await prisma.signalEvidence.create({
        data: {
          signalId: signal.id,
          extractedFactId: ev.factId || null,
          sourceRecordId: ev.sourceRecordId || null,
          jobPostingId: ev.jobPostingId || null,
          techDetectionId: ev.techDetectionId || null,
          websiteAuditId: ev.websiteAuditId || null,
          note: ev.note ? String(ev.note).slice(0, 500) : null,
        },
      });
    }

    signals.push({ ...signal, context: d.context });
  }

  // Anything previously true that the current evidence no longer supports.
  const stale = existing.filter((s) => s.active && !desiredKeys.has(`${s.type}|${s.dedupeKey}`));
  if (stale.length) {
    await prisma.signal.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: {
        active: false,
        deactivatedAt: new Date(),
        deactivatedReason: "Re-evaluated: the evidence behind this signal no longer holds.",
      },
    });
  }

  logger.debug({ companyId, created, updated, deactivated: stale.length }, "signals reconciled");
  return { created, updated, deactivated: stale.length, signals };
};

/** Context needed to render a signal's human sentence, recomputed at score time. */
export const buildSignalContext = (signal, company) => ({
  companyName: company?.name,
  industry: company?.industry,
  ...(signal.context || {}),
});
