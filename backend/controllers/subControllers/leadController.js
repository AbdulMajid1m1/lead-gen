import { z } from "zod";
import prisma from "../../prismaClient.js";
import { toLeadCard } from "../../lib/nlquery/planner.js";
import { setStatus, SERVICE_LABELS } from "../../lib/scoring/scoreEngine.js";
import { SIGNAL_CATALOG } from "../../lib/signals/signalCatalog.js";
import { relativeAge, freshnessBucket, decayFactor } from "../../lib/scoring/decay.js";
import { countryName } from "../../utils/countries.js";
import { createError } from "../../utils/createError.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { pickWhatsAppNumber } from "../../lib/outreach/phoneRank.js";
import { sendPolicyFor, isRoleAddress, isSendBlocked } from "../../lib/outreach/sendPolicy.js";

export const listSchema = z.object({
  status: z.string().optional(),
  service: z.string().optional(),
  type: z.string().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  city: z.string().max(120).optional(),
  /// Free-text over the company name and its domain, so the grid has a way to
  /// find one known company without knowing which filter it falls under.
  search: z.string().trim().max(120).optional(),
  /// Comma-separated ISO-3166 alpha-2 codes; "UNKNOWN" selects leads whose
  /// country was never established. Values come from GET /api/leads/countries.
  country: z.string().max(400).optional(),
  industry: z.string().max(120).optional(),
  /// Narrows the list to the leads a SaaS Promoter product actually sourced,
  /// so the promoter page can reuse this endpoint rather than growing a second
  /// listing that filters and pages differently from All leads.
  productId: z.string().min(1).max(64).optional(),
  runId: z.string().min(1).max(64).optional(),
  freshness: z.enum(["NEW_TODAY", "NEW_THIS_WEEK", "THIS_MONTH", "THIS_QUARTER", "OLDER"]).optional(),
  sort: z.enum(["score", "freshness", "created"]).default("created"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const FRESHNESS_DAYS = { NEW_TODAY: 1, NEW_THIS_WEEK: 7, THIS_MONTH: 30, THIS_QUARTER: 90 };

/** GET /api/leads */
/**
 * The list filters, shared by the list itself, the tab counts and bulk
 * selection — one construction so the three can never disagree about what
 * "matching leads" means. `ignoreStatus` powers the tab counters, which need
 * every status counted under the *other* active filters.
 */
const buildListWhere = (q, { ignoreStatus = false } = {}) => {
  const where = { AND: [] };

  if (!ignoreStatus) {
    if (q.status) where.AND.push({ status: { in: q.status.split(",") } });
    else where.AND.push({ status: { notIn: ["DO_NOT_CONTACT", "ARCHIVED"] } });
  }

  if (q.service) where.AND.push({ primaryOpportunity: { in: q.service.split(",") } });
  if (q.type) where.AND.push({ type: { in: q.type.split(",") } });
  if (q.minScore !== undefined) where.AND.push({ score: { gte: q.minScore } });
  if (q.city) where.AND.push({ company: { city: { contains: q.city, mode: "insensitive" } } });
  // Name or domain: the two things someone actually remembers a company by.
  if (q.search) {
    where.AND.push({
      company: {
        OR: [
          { name: { contains: q.search, mode: "insensitive" } },
          { normalizedName: { contains: q.search, mode: "insensitive" } },
          { domains: { some: { domain: { contains: q.search.toLowerCase() } } } },
        ],
      },
    });
  }

  // Country is a multi-select: every selected country is OR-ed together, so
  // picking "United Kingdom" and "Portugal" shows the leads of both. Companies
  // whose country was never established are only included when the caller
  // explicitly asks for UNKNOWN.
  if (q.country) {
    const picked = parseCountryParam(q.country);
    if (picked.codes.length === 0 && !picked.unknown) {
      where.AND.push({ id: { in: [] } }); // an all-invalid selection matches nothing
    } else {
      where.AND.push({
        company: {
          OR: [
            ...(picked.codes.length ? [{ countryCode: { in: picked.codes } }] : []),
            ...(picked.unknown ? [{ countryCode: null }] : []),
          ],
        },
      });
    }
  }
  if (q.industry) where.AND.push({ company: { industry: { contains: q.industry, mode: "insensitive" } } });
  // A lead belongs to a promoted product through the run that found it.
  if (q.productId) where.AND.push({ discoveryRun: { promotedProductId: q.productId } });
  if (q.runId) where.AND.push({ discoveryRunId: q.runId });
  if (q.freshness && FRESHNESS_DAYS[q.freshness]) {
    where.AND.push({ newestEvidenceAt: { gte: new Date(Date.now() - FRESHNESS_DAYS[q.freshness] * 86_400_000) } });
  } else if (q.freshness === "OLDER") {
    where.AND.push({ newestEvidenceAt: { lt: new Date(Date.now() - 90 * 86_400_000) } });
  }

  return where;
};

export const listLeads = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = buildListWhere(q);

  // "created" is the default: the newest lead is always the first row. The id
  // tiebreak matters because a discovery run writes its whole batch inside the
  // same millisecond — without it, paging can repeat or skip rows.
  const orderBy = q.sort === "freshness" ? [{ newestEvidenceAt: "desc" }, { id: "desc" }]
    : q.sort === "created" ? [{ createdAt: "desc" }, { id: "desc" }]
    : [{ score: "desc" }, { newestEvidenceAt: "desc" }, { id: "desc" }];

  const [total, leads] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        company: { include: { domains: true, contacts: { where: { isSuppressed: false } }, locations: { take: 1 }, people: { orderBy: [{ seniority: "asc" }, { email: "desc" }], take: 1 } } },
        // The signal type is what distinguishes a reason about the company
        // from one about its website, which a product-scoped list drops.
        reasons: { orderBy: { rank: "asc" }, take: 6, include: { signal: { select: { type: true } } } },
        opportunities: { orderBy: { rank: "asc" } },
        actions: { orderBy: { priority: "desc" }, take: 1 },
      },
    }),
  ]);

  const forProduct = Boolean(q.productId);
  res.json({
    success: true,
    data: {
      leads: leads.map((l) => toLeadCard(l, null, { forProduct })),
      total, page: q.page, pageSize: q.pageSize,
    },
  });
});

/** Split the `country` query parameter into valid ISO codes plus the UNKNOWN flag. */
const parseCountryParam = (raw) => {
  const parts = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    codes: [...new Set(parts.filter((p) => /^[A-Z]{2}$/.test(p)))],
    unknown: parts.includes("UNKNOWN"),
  };
};

/**
 * GET /api/leads/countries
 *
 * The countries the filter dropdown is allowed to offer — derived from the
 * leads that actually exist, never from a static list. Offering a country with
 * nothing behind it produces an empty grid and no explanation for it.
 */
export const listCountries = asyncHandler(async (req, res) => {
  const visible = { status: { notIn: ["DO_NOT_CONTACT", "ARCHIVED"] } };

  const grouped = await prisma.company.findMany({
    where: { leads: { some: visible } },
    select: { countryCode: true, _count: { select: { leads: { where: visible } } } },
  });

  const counts = new Map();
  let unknown = 0;
  for (const row of grouped) {
    const n = row._count.leads;
    if (!n) continue;
    if (!row.countryCode) unknown += n;
    else counts.set(row.countryCode.toUpperCase(), (counts.get(row.countryCode.toUpperCase()) || 0) + n);
  }

  const countries = [...counts.entries()]
    .map(([code, leadCount]) => ({ code, name: countryName(code), leadCount }))
    .sort((a, b) => b.leadCount - a.leadCount || a.name.localeCompare(b.name));

  res.json({
    success: true,
    data: {
      countries,
      // Surfaced separately so the dropdown can offer it last, and only when
      // there is something to select.
      unknown: unknown ? { code: "UNKNOWN", name: "Unknown country", leadCount: unknown } : null,
      total: countries.reduce((sum, c) => sum + c.leadCount, 0) + unknown,
    },
  });
});

/**
 * GET /api/leads/:id
 * The full story of one lead — everything needed to decide whether and how to
 * make contact, in a single response.
 */
export const getLead = asyncHandler(async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.id },
    include: {
      company: {
        include: {
          domains: true,
          contacts: true,
          // Ordered so the first row is the best outreach target — the enum is
          // declared most-senior-first, so ascending puts owners at the top.
          people: { orderBy: [{ seniority: "asc" }, { email: "desc" }] },
          locations: true,
          tech: { orderBy: { category: "asc" } },
          audits: { orderBy: { auditedAt: "desc" }, take: 1 },
          facts: { orderBy: { extractedAt: "desc" } },
          signals: { where: { active: true }, include: { evidence: true } },
          jobPostings: { orderBy: [{ status: "asc" }, { postedAt: "desc" }], include: { skills: true, source: true } },
          atsAccounts: true,
        },
      },
      reasons: { orderBy: { rank: "asc" }, include: { signal: true } },
      opportunities: { orderBy: { rank: "asc" } },
      actions: { orderBy: { priority: "desc" } },
      outreach: true,
      history: { orderBy: { changedAt: "desc" } },
      discoveryRun: { include: { steps: { orderBy: { ordinal: "asc" } } } },
      searchQuery: true,
    },
  });
  if (!lead) throw createError(404, "Lead not found.");

  const c = lead.company;
  const audit = c.audits[0] || null;
  const now = Date.now();

  const jobs = c.jobPostings.map((j) => ({
    id: j.id,
    title: j.title,
    url: j.url,
    location: j.location,
    department: j.department,
    employmentType: j.employmentType,
    remote: j.remote,
    status: j.status,
    postedAt: j.postedAt,
    postedRelative: j.postedAt ? relativeAge(j.postedAt) : null,
    lastSeenActiveAt: j.lastSeenActiveAt,
    lastVerifiedAt: j.lastVerifiedAt,
    verifiedRelative: j.lastVerifiedAt ? relativeAge(j.lastVerifiedAt) : null,
    deadlineAt: j.deadlineAt,
    skills: j.skills.map((s) => s.skill),
    source: { kind: j.source.kind, name: j.source.name },
    // Why we believe this status — the answer to "is this actually open?"
    statusEvidence: j.statusEvidence || [],
    descriptionSnippet: j.descriptionSnippet,
  }));

  res.json({
    success: true,
    data: {
      id: lead.id,
      score: lead.score,
      scoreBreakdown: lead.scoreBreakdown,
      type: lead.type,
      status: lead.status,
      primaryOpportunity: lead.primaryOpportunity,
      primaryOpportunityLabel: SERVICE_LABELS[lead.primaryOpportunity],
      freshness: {
        score: lead.freshnessScore,
        newestEvidenceAt: lead.newestEvidenceAt,
        relative: relativeAge(lead.newestEvidenceAt),
        bucket: freshnessBucket(lead.newestEvidenceAt),
      },
      company: {
        id: c.id,
        name: c.name,
        industry: c.industry,
        osmCategory: c.osmCategory,
        description: c.description,
        city: c.city,
        countryCode: c.countryCode,
        sizeBucket: c.sizeBucket,
        firstSeenAt: c.firstSeenAt,
        lastCrawledAt: c.lastCrawledAt,
        lastEnrichedAt: c.lastEnrichedAt,
        // identityStatus travels with every domain so the UI can warn before
        // anyone emails an address on a site that is not this company's.
        domains: c.domains.map((d) => ({
          domain: d.domain, isPrimary: d.isPrimary, httpsOk: d.httpsOk, discoveredVia: d.discoveredVia,
          identityStatus: d.identityStatus, identityScore: d.identityScore,
          identityReason: d.identityReason, identityCheckedAt: d.identityCheckedAt,
        })),
        locations: c.locations.map((l) => ({ addressLine: l.addressLine, city: l.city, country: l.country, lat: l.lat, lon: l.lon })),
      },
      contacts: {
        emails: c.contacts.filter((x) => x.kind === "EMAIL").map(contactDto),
        phones: c.contacts.filter((x) => x.kind === "PHONE").map(contactDto),
        forms: c.contacts.filter((x) => x.kind === "CONTACT_FORM").map(contactDto),
        socials: c.contacts.filter((x) => x.kind === "SOCIAL").map(contactDto),
      },
      // The people a business publishes about itself, best target first, so
      // outreach can open with a name instead of "Dear Sir/Madam".
      people: (c.people || []).map((p) => ({
        fullName: p.fullName, title: p.title, seniority: p.seniority,
        email: p.email, linkedinUrl: p.linkedinUrl, profileUrl: p.profileUrl,
        observedOnUrl: p.observedOnUrl, confidenceLevel: p.confidenceLevel,
      })),
      opportunities: lead.opportunities.map((o) => ({
        service: o.service, label: SERVICE_LABELS[o.service], points: o.points, rank: o.rank, rationale: o.rationale,
      })),
      reasons: lead.reasons.map((r) => ({
        rank: r.rank,
        text: r.text,
        confidenceLevel: r.confidenceLevel,
        signal: r.signal ? {
          id: r.signal.id,
          type: r.signal.type,
          label: SIGNAL_CATALOG[r.signal.type]?.label,
          strength: r.signal.strength,
          weight: r.signal.weight,
          detectedAt: r.signal.detectedAt,
          detectedRelative: relativeAge(r.signal.detectedAt),
          decay: Number(decayFactor(r.signal, now).toFixed(3)),
        } : null,
      })),
      signals: c.signals.map((s) => ({
        id: s.id,
        type: s.type,
        label: SIGNAL_CATALOG[s.type]?.label || s.type,
        strength: s.strength,
        weight: s.weight,
        halfLifeDays: s.halfLifeDays,
        detectedAt: s.detectedAt,
        detectedRelative: relativeAge(s.detectedAt),
        decay: Number(decayFactor(s, now).toFixed(3)),
        evidenceCount: s.evidence.length,
        notes: s.evidence.map((e) => e.note).filter(Boolean),
      })),
      website: audit ? {
        overallScore: audit.overallScore,
        subscores: audit.subscores,
        findings: audit.findings,
        pagesAudited: audit.pagesAudited,
        auditedAt: audit.auditedAt,
        auditedRelative: relativeAge(audit.auditedAt),
      } : null,
      technologies: c.tech.map((t) => ({
        name: t.techName, category: t.category, version: t.version,
        confidence: t.confidence, matchedOn: t.matchedOn, evidence: t.evidence, detectedAt: t.detectedAt,
      })),
      jobs,
      jobSummary: {
        active: jobs.filter((j) => j.status === "ACTIVE").length,
        recentlyActive: jobs.filter((j) => j.status === "RECENTLY_ACTIVE").length,
        expired: jobs.filter((j) => ["EXPIRED", "CLOSED"].includes(j.status)).length,
        unknown: jobs.filter((j) => j.status === "UNKNOWN").length,
        atsBoards: c.atsAccounts.map((a) => ({ provider: a.provider, slug: a.slug, boardUrl: a.boardUrl, lastFetchedAt: a.lastFetchedAt })),
      },
      facts: c.facts.map((f) => ({
        key: f.key, value: f.value, confidenceLevel: f.confidenceLevel,
        extractorName: f.extractorName, evidenceSnippet: f.evidenceSnippet, extractedAt: f.extractedAt,
      })),
      actions: lead.actions.map((a) => ({ actionType: a.actionType, title: a.title, rationale: a.rationale, priority: a.priority })),
      outreach: lead.outreach.map((o) => ({
        channel: o.channel, subjectLine: o.subjectLine, openingLine: o.openingLine,
        talkingPoints: o.talkingPoints, generatedBy: o.generatedBy, confidenceLevel: o.confidenceLevel,
      })),
      history: lead.history.map((h) => ({ fromStatus: h.fromStatus, toStatus: h.toStatus, note: h.note, changedAt: h.changedAt })),
      discovery: lead.discoveryRun ? {
        id: lead.discoveryRun.id,
        trigger: lead.discoveryRun.trigger,
        status: lead.discoveryRun.status,
        startedAt: lead.discoveryRun.startedAt,
        steps: lead.discoveryRun.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, label: s.label, status: s.status, counts: s.counts })),
      } : null,
      originQuery: lead.searchQuery ? { id: lead.searchQuery.id, rawText: lead.searchQuery.rawText } : null,
      scoredAt: lead.scoredAt,
      createdAt: lead.createdAt,
    },
  });
});

const contactDto = (c) => ({
  value: c.value,
  kind: c.kind,
  roleHint: c.roleHint,
  confidenceLevel: c.confidenceLevel,
  isSuppressed: c.isSuppressed,
  createdAt: c.createdAt,
});

export const statusSchema = z.object({
  status: z.enum(["NEW", "QUALIFIED", "CONTACTED", "FOLLOW_UP", "REPLIED", "INTERESTED", "CONVERTED", "NOT_INTERESTED", "DISQUALIFIED", "ARCHIVED", "DO_NOT_CONTACT"]),
  note: z.string().max(1000).optional(),
});

/** PATCH /api/leads/:id/status */
export const updateStatus = asyncHandler(async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, include: { company: { include: { domains: true } } } });
  if (!lead) throw createError(404, "Lead not found.");

  const updated = await setStatus(lead.id, req.body.status, req.body.note || null);

  // "Do not contact" is a promise, not a label — it must also enter the
  // suppression list so future discovery never resurfaces this company.
  if (req.body.status === "DO_NOT_CONTACT") {
    await prisma.suppressionEntry.upsert({
      where: { kind_value: { kind: "COMPANY", value: lead.company.normalizedName } },
      update: { reason: req.body.note || "Marked do-not-contact from the lead view." },
      create: { kind: "COMPANY", value: lead.company.normalizedName, reason: req.body.note || "Marked do-not-contact from the lead view." },
    });
    for (const d of lead.company.domains) {
      await prisma.suppressionEntry.upsert({
        where: { kind_value: { kind: "DOMAIN", value: d.domain } },
        update: {},
        create: { kind: "DOMAIN", value: d.domain, reason: "Company marked do-not-contact." },
      });
    }
  }

  res.json({ success: true, message: `Lead marked ${req.body.status.toLowerCase().replace(/_/g, " ")}.`, data: { id: updated.id, status: updated.status } });
});

/**
 * GET /api/leads/:id/provenance
 * The full chain: Source → discovery → crawl → extracted data → evidence →
 * signal → reason → score. This is the answer to "where did this come from?".
 */
export const getProvenance = asyncHandler(async (req, res) => {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.id },
    include: {
      company: {
        include: {
          signals: { where: { active: true }, include: {
            evidence: {
              include: {
                extractedFact: { include: { sourceRecord: { include: { source: true } }, crawlResult: { include: { crawlRequest: true } } } },
                sourceRecord: { include: { source: true } },
                jobPosting: { include: { source: true } },
                techDetection: { include: { crawlResult: { include: { crawlRequest: true } } } },
                websiteAudit: true,
              },
            },
          } },
        },
      },
      reasons: { orderBy: { rank: "asc" } },
      discoveryRun: { include: { steps: { orderBy: { ordinal: "asc" } } } },
    },
  });
  if (!lead) throw createError(404, "Lead not found.");

  const crawls = await prisma.crawlRequest.findMany({
    where: { companyId: lead.companyId },
    include: { result: true },
    orderBy: { createdAt: "asc" },
    take: 40,
  });

  const chains = lead.company.signals.map((signal) => {
    const reason = lead.reasons.find((r) => r.signalId === signal.id);
    return {
      signal: {
        id: signal.id,
        type: signal.type,
        label: SIGNAL_CATALOG[signal.type]?.label || signal.type,
        strength: signal.strength,
        weight: signal.weight,
        detectedAt: signal.detectedAt,
        detectedRelative: relativeAge(signal.detectedAt),
        decay: Number(decayFactor(signal, Date.now()).toFixed(3)),
        points: Number((signal.weight * signal.strength * decayFactor(signal, Date.now())).toFixed(2)),
      },
      reason: reason ? { text: reason.text, confidenceLevel: reason.confidenceLevel } : null,
      evidence: signal.evidence.map(evidenceDto),
    };
  }).sort((a, b) => b.signal.points - a.signal.points);

  res.json({
    success: true,
    data: {
      leadId: lead.id,
      discovery: lead.discoveryRun ? {
        id: lead.discoveryRun.id,
        trigger: lead.discoveryRun.trigger,
        status: lead.discoveryRun.status,
        startedAt: lead.discoveryRun.startedAt,
        finishedAt: lead.discoveryRun.finishedAt,
        steps: lead.discoveryRun.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, label: s.label, status: s.status, counts: s.counts })),
      } : null,
      crawls: crawls.map((c) => ({
        url: c.url,
        priority: c.priority,
        status: c.status,
        robotsDecision: c.robotsDecision,
        attempts: c.attempts,
        httpStatus: c.result?.httpStatus ?? null,
        blockReason: c.result?.blockReason ?? null,
        blockDetail: c.result?.blockDetail ?? null,
        bytes: c.result?.bytes ?? null,
        totalMs: c.result?.totalMs ?? null,
        finalUrl: c.result?.finalUrl ?? null,
        jsRendered: c.result?.jsRendered ?? false,
        fetchedAt: c.result?.fetchedAt ?? null,
      })),
      chains,
      scoreBreakdown: lead.scoreBreakdown,
    },
  });
});

const evidenceDto = (e) => {
  if (e.extractedFact) {
    const f = e.extractedFact;
    return {
      kind: "EXTRACTED_FACT",
      note: e.note,
      fact: { key: f.key, value: f.value, confidenceLevel: f.confidenceLevel, extractor: f.extractorName, snippet: f.evidenceSnippet, extractedAt: f.extractedAt },
      source: f.sourceRecord ? sourceDto(f.sourceRecord) : null,
      crawl: f.crawlResult ? crawlDto(f.crawlResult) : null,
    };
  }
  if (e.jobPosting) {
    return {
      kind: "JOB_POSTING",
      note: e.note,
      job: {
        title: e.jobPosting.title, url: e.jobPosting.url, status: e.jobPosting.status,
        postedAt: e.jobPosting.postedAt, lastVerifiedAt: e.jobPosting.lastVerifiedAt,
        statusEvidence: e.jobPosting.statusEvidence,
      },
      // Same shape as every other evidence type's `source` — the UI reads one
      // set of field names, so a divergent shape here renders as "undefined".
      source: {
        sourceKind: e.jobPosting.source.kind,
        sourceName: e.jobPosting.source.name,
        attribution: e.jobPosting.source.attribution,
        url: e.jobPosting.url,
        fetchedAt: e.jobPosting.lastVerifiedAt || e.jobPosting.firstSeenAt,
        fetchedRelative: relativeAge(e.jobPosting.lastVerifiedAt || e.jobPosting.firstSeenAt),
      },
    };
  }
  if (e.techDetection) {
    const t = e.techDetection;
    return {
      kind: "TECHNOLOGY",
      note: e.note,
      technology: { name: t.techName, category: t.category, version: t.version, confidenceLevel: t.confidence, matchedOn: t.matchedOn, evidence: t.evidence },
      crawl: t.crawlResult ? crawlDto(t.crawlResult) : null,
    };
  }
  if (e.websiteAudit) {
    const a = e.websiteAudit;
    return {
      kind: "WEBSITE_AUDIT",
      note: e.note,
      audit: { overallScore: a.overallScore, subscores: a.subscores, findings: a.findings, pagesAudited: a.pagesAudited, auditedAt: a.auditedAt },
    };
  }
  if (e.sourceRecord) return { kind: "SOURCE_RECORD", note: e.note, source: sourceDto(e.sourceRecord) };
  return { kind: "NOTE", note: e.note };
};

const sourceDto = (record) => ({
  sourceKind: record.source?.kind,
  sourceName: record.source?.name,
  attribution: record.source?.attribution,
  externalId: record.externalId,
  url: record.url,
  payloadHash: record.payloadHash,
  fetchedAt: record.fetchedAt,
  fetchedRelative: relativeAge(record.fetchedAt),
});

const crawlDto = (result) => ({
  url: result.crawlRequest?.url,
  finalUrl: result.finalUrl,
  httpStatus: result.httpStatus,
  robotsDecision: result.crawlRequest?.robotsDecision,
  blockReason: result.blockReason,
  bytes: result.bytes,
  totalMs: result.totalMs,
  fetchedAt: result.fetchedAt,
});


/**
 * GET /api/leads/ids — every lead id matching the current filters, capped.
 * This is what makes "select all 324 matching" one click instead of thirteen
 * pages of checkboxes; the cap mirrors the campaign recipient limit.
 */
export const listLeadIds = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = buildListWhere(q);

  const rows = await prisma.lead.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
    select: {
      id: true,
      company: {
        select: {
          countryCode: true,
          // `value` and `confidenceLevel` are needed to tell a mobile from a
          // switchboard; without them the WhatsApp count is a guess.
          contacts: {
            where: { isSuppressed: false },
            select: { kind: true, roleHint: true, value: true, confidenceLevel: true, isSuppressed: true },
          },
        },
      },
    },
  });

  // "Has a phone number" and "can be reached on WhatsApp" are not the same
  // claim. Counting them as one is what let a bulk send promise forty
  // recipients and deliver to fifteen — the rest were landlines.
  const waPlausible = rows.filter((r) => {
    const best = pickWhatsAppNumber(r.company.contacts, r.company.countryCode);
    return best && best.kind !== "LANDLINE";
  }).length;

  // Leads the legal gate will refuse at campaign creation. Counted here so the
  // bulk bar can say so *before* a campaign is built, rather than the user
  // discovering it in a list of skips afterwards.
  const emailBlocked = rows.filter((r) =>
    isSendBlocked(sendPolicyFor({
      countryCode: r.company.countryCode,
      channel: "EMAIL",
      roleAddress: r.company.contacts.some((c) => c.kind === "EMAIL" && isRoleAddress(c)),
    }))).length;
  const blockedCountries = [...new Set(rows
    .map((r) => r.company.countryCode)
    .filter((code) => code && isSendBlocked(sendPolicyFor({ countryCode: code, channel: "EMAIL" }))))];

  res.json({
    success: true,
    data: {
      ids: rows.map((r) => r.id),
      withEmail: rows.filter((r) => r.company.contacts.some((c) => c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH")).length,
      withPhone: rows.filter((r) => r.company.contacts.some((c) => c.kind === "PHONE" || (c.kind === "SOCIAL" && c.roleHint === "WHATSAPP"))).length,
      // Leads whose best number is a WhatsApp link, a mobile, or a number we
      // cannot classify. Landline-only leads are excluded: they will almost
      // certainly come back "not registered on WhatsApp".
      withWhatsApp: waPlausible,
      // How many of this selection cannot lawfully be cold-emailed, and where.
      emailBlocked,
      blockedCountries,
      capped: rows.length === 500,
    },
  });
});

/**
 * GET /api/leads/status-counts — how many leads sit in each pipeline stage
 * under the current filters (status excluded). Drives the tab badges.
 */
export const statusCounts = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = buildListWhere(q, { ignoreStatus: true });

  const grouped = await prisma.lead.groupBy({ by: ["status"], where, _count: { _all: true } });
  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const of = (...keys) => keys.reduce((acc, k) => acc + (counts[k] || 0), 0);

  res.json({
    success: true,
    data: {
      pending: of("NEW", "QUALIFIED"),
      contacted: of("CONTACTED", "FOLLOW_UP"),
      replied: of("REPLIED"),
      working: of("INTERESTED"),
      all: of("NEW", "QUALIFIED", "CONTACTED", "FOLLOW_UP", "REPLIED", "INTERESTED", "CONVERTED", "NOT_INTERESTED"),
      raw: counts,
    },
  });
});
