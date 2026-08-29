import prisma from "../../prismaClient.js";
import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { SIGNAL_CATALOG, WEBSITE_PITCH_SIGNALS, personIsCorroborated } from "../signals/signalCatalog.js";
import { decayFactor, relativeAge, freshnessBucket } from "../scoring/decay.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { MIN_RESULTS_BEFORE_DISCOVER, AI_MAX_SEARCH_CALLS } from "../../configs/envConfig.js";
import { expandLocation } from "../research/brief.js";
import { pickDisplayPhone, pickWhatsAppNumber } from "../outreach/phoneRank.js";
import { sendPolicyFor, isRoleAddress } from "../outreach/sendPolicy.js";
import { emailMatchesName } from "../extract/people.js";
import { icpToSearchStrategies, icpToParsedQuery } from "../promoter/icp.js";

/**
 * Turns a StructuredQuery into database results and, when the database cannot
 * answer it yet, into a plan for going and finding out.
 *
 * The second half is what makes this a discovery product rather than a search
 * over a static table: typing a query the system has never seen should still
 * produce leads.
 */

const NEVER_SHOW = ["DO_NOT_CONTACT", "ARCHIVED", "DISQUALIFIED"];

/** Build the Prisma `where` clause for a parsed query. */
export const buildWhere = (q, { includeAllStatuses = false } = {}) => {
  const and = [];

  if (!includeAllStatuses) and.push({ status: { notIn: NEVER_SHOW } });

  if (q.industries?.length) {
    const labels = q.industries.map((k) => OSM_CATEGORIES[k]?.label).filter(Boolean);
    const tagPrefixes = q.industries.flatMap((k) => (OSM_CATEGORIES[k]?.tags || []).map(([tk, tv]) => `${tk}=${tv}`));
    and.push({
      company: {
        OR: [
          ...(labels.length ? [{ industry: { in: labels } }] : []),
          ...(tagPrefixes.length ? [{ osmCategory: { in: tagPrefixes } }] : []),
          ...(q.industries.length ? [{ osmCategory: { in: q.industries } }] : []),
        ],
      },
    });
  }

  if (q.location?.name) {
    // Location matching is textual against the city recorded on the company or
    // its locations; the geographic search happens during discovery, not here.
    // A country-level query also matches by countryCode and its major cities —
    // "Saudi Arabia" must find companies whose city says "Riyadh".
    const name = q.location.raw || q.location.name;
    const expanded = expandLocation({ name, countryCode: null, cities: [] }) || {};
    const cityTerms = [name, ...(expanded.cities || [])];
    and.push({
      company: {
        OR: [
          ...cityTerms.flatMap((c) => [
            { city: { contains: c, mode: "insensitive" } },
            { locations: { some: { city: { contains: c, mode: "insensitive" } } } },
            { locations: { some: { addressLine: { contains: c, mode: "insensitive" } } } },
          ]),
          ...(expanded.countryCode ? [{ countryCode: expanded.countryCode }] : []),
        ],
      },
    });
  }

  if (q.signals?.length) {
    // Any of the requested signals, active only — a deactivated signal must
    // never satisfy a search.
    and.push({ company: { signals: { some: { type: { in: q.signals }, active: true } } } });
  }

  if (q.technologies?.length) {
    and.push({ company: { tech: { some: { techName: { in: q.technologies } } } } });
  }
  if (q.excludeTechnologies?.length) {
    and.push({ company: { tech: { none: { techName: { in: q.excludeTechnologies } } } } });
  }

  if (q.service) and.push({ OR: [{ primaryOpportunity: q.service }, { opportunities: { some: { service: q.service } } }] });

  if (q.jobTitleContains?.length) {
    and.push({
      company: {
        jobPostings: {
          some: {
            status: { in: ["ACTIVE", "RECENTLY_ACTIVE"] },
            OR: q.jobTitleContains.map((t) => ({ normalizedTitle: { contains: t, mode: "insensitive" } })),
          },
        },
      },
    });
  }

  if (q.postedWithinDays) {
    and.push({ newestEvidenceAt: { gte: new Date(Date.now() - q.postedWithinDays * 86_400_000) } });
  }

  if (q.sizeBucket) and.push({ company: { sizeBucket: q.sizeBucket } });
  if (q.minScore) and.push({ score: { gte: q.minScore } });

  // Leftover words are only a company-name search when the query gave nothing
  // else to go on. Applying them as a hard filter alongside real constraints
  // silently zeroes out correct results: "hair salons in Lisbon" leaves "hair"
  // unclaimed, and no salon there is actually *named* "hair".
  const hasStructuredConstraint =
    q.industries?.length || q.location?.name || q.signals?.length ||
    q.technologies?.length || q.service || q.jobTitleContains?.length;

  if (q.freeText?.length && !hasStructuredConstraint) {
    const term = q.freeText.join(" ");
    if (term.length >= 3) {
      and.push({
        company: {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { normalizedName: { contains: term, mode: "insensitive" } },
          ],
        },
      });
    }
  }

  return and.length ? { AND: and } : {};
};

const LEAD_CARD_INCLUDE = {
  company: {
    include: {
      domains: true,
      contacts: { where: { isSuppressed: false } },
      locations: { take: 1 },
    },
  },
  reasons: { orderBy: { rank: "asc" }, take: 3 },
  opportunities: { orderBy: { rank: "asc" } },
  actions: { orderBy: { priority: "desc" }, take: 1 },
};

/**
 * Rank leads for a query.
 *
 * Ordering happens in JS rather than SQL because the ranking multiplies the
 * stored score by live freshness decay — a value that changes with the clock,
 * so it cannot be an index.
 */
export const searchLeads = async (parsed, { page = 1, pageSize = 25 } = {}) => {
  const where = buildWhere(parsed.query);

  const total = await prisma.lead.count({ where });
  // Over-fetch so re-ranking has something to work with, then page in memory.
  const candidates = await prisma.lead.findMany({
    where,
    include: LEAD_CARD_INCLUDE,
    orderBy: [{ score: "desc" }, { newestEvidenceAt: "desc" }],
    take: Math.min(500, Math.max(pageSize * 4, 100)),
  });

  const ranked = candidates
    .map((lead) => {
      const ageFactor = decayFactor({ detectedAt: lead.newestEvidenceAt, halfLifeDays: 60 });
      // 70% quality, 30% recency — a strong old lead still beats a weak new one.
      let rankScore = lead.score * (0.7 + 0.3 * ageFactor);

      // A lead nobody can contact is not actionable, however strong its
      // signals. Reachability already earns score points; this demotes the
      // unreachable ones in ranking too, so the first page is always made of
      // companies the user can actually approach today. They are still
      // returned — just below everything contactable.
      const reachable = (lead.company?.contacts || []).some(
        (c) => (c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH") || c.kind === "PHONE" || c.kind === "CONTACT_FORM",
      );
      if (!reachable) rankScore *= 0.6;

      return { lead, rankScore };
    })
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice((page - 1) * pageSize, page * pageSize)
    .map(({ lead, rankScore }) => toLeadCard(lead, rankScore));

  return { leads: ranked, total, page, pageSize };
};

export const toLeadCard = (lead, rankScore = null, { forProduct = false } = {}) => {
  const contacts = lead.company?.contacts || [];
  // Prefer the domain the identity check confirmed; a rejected one must never
  // be the address shown on the card.
  const domains = lead.company?.domains || [];
  const primaryDomain = domains.find((d) => d.identityStatus === "CONFIRMED")
    || domains.find((d) => d.identityStatus !== "REJECTED")
    || null;
  // A name is only shown when something corroborates that it is a person, the
  // same standard the composer applies before greeting one — otherwise the
  // grid offers a contact the email would refuse to use.
  const rawPerson = lead.company?.people?.[0] || null;
  const person = personIsCorroborated(rawPerson, emailMatchesName) ? rawPerson : null;
  const email = contacts.find((c) => c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH");
  // Ranked, not "first row": a company's switchboard and its owner's mobile are
  // both PHONE contacts, and only one of them is worth a WhatsApp message.
  const homeCountry = lead.company?.countryCode || null;
  const phone = pickDisplayPhone(contacts, homeCountry);
  const whatsapp = pickWhatsAppNumber(contacts, homeCountry);
  const form = contacts.find((c) => c.kind === "CONTACT_FORM");

  return {
    id: lead.id,
    score: lead.score,
    rankScore: rankScore === null ? undefined : Math.round(rankScore * 10) / 10,
    type: lead.type,
    status: lead.status,
    primaryOpportunity: lead.primaryOpportunity,
    opportunities: (lead.opportunities || []).map((o) => ({ service: o.service, points: o.points, rank: o.rank })),
    freshness: {
      score: lead.freshnessScore,
      newestEvidenceAt: lead.newestEvidenceAt,
      relative: relativeAge(lead.newestEvidenceAt),
      bucket: freshnessBucket(lead.newestEvidenceAt),
    },
    company: {
      id: lead.company?.id,
      name: lead.company?.name,
      industry: lead.company?.industry,
      city: lead.company?.city || lead.company?.locations?.[0]?.city || null,
      countryCode: lead.company?.countryCode,
      domain: primaryDomain?.domain || null,
      // Carried onto the card so the grid can mark an unverified website before
      // anyone clicks through and emails an address taken from the wrong site.
      domainIdentityStatus: primaryDomain?.identityStatus || "UNCHECKED",
    },
    // On a product-scoped list the website diagnostics are not why this lead
    // matters, and shown as "why it matched" they describe a different sale.
    topReasons: (lead.reasons || [])
      .filter((r) => !(forProduct && WEBSITE_PITCH_SIGNALS.has(r.signal?.type)))
      .map((r) => ({ text: r.text, confidenceLevel: r.confidenceLevel })),
    contact: {
      hasEmail: Boolean(email),
      hasPhone: Boolean(phone),
      hasForm: Boolean(form),
      // Whether this lead is reachable on WhatsApp at all, and on which number
      // — so the bulk bar can count honestly instead of assuming every phone
      // is a WhatsApp account.
      hasWhatsApp: Boolean(whatsapp),
      email: email?.value || null,
      phone: phone?.display || null,
      whatsapp: whatsapp ? { number: whatsapp.number, display: whatsapp.display, kind: whatsapp.kind, why: whatsapp.why } : null,
      formUrl: form?.value || null,
      // A named person turns "Dear Sir/Madam" into a real greeting, so the
      // grid shows whether one exists before the lead is opened.
      personName: person?.fullName || null,
      personTitle: person?.title || null,
    },
    // Whether we are legally allowed to cold-email this lead, and why. Computed
    // here rather than in the UI so the grid, the bulk bar and the sender can
    // never disagree about it — and surfaced on every lead, not just at send
    // time, because in the opt-in markets the restriction reaches collection
    // too (EDPB Guidelines 1/2024, fn. 143).
    compliance: {
      email: sendPolicyFor({ countryCode: homeCountry, channel: "EMAIL", roleAddress: isRoleAddress(email) }),
      whatsapp: sendPolicyFor({ countryCode: homeCountry, channel: "WHATSAPP" }),
    },
    recommendedAction: lead.actions?.[0]
      ? { actionType: lead.actions[0].actionType, title: lead.actions[0].title, rationale: lead.actions[0].rationale }
      : null,
    scoredAt: lead.scoredAt,
  };
};

/**
 * Build an ordered discovery plan for a query the database cannot yet answer.
 *
 * The plan is stored on the DiscoveryRun so the UI can show exactly what the
 * system is about to do, and afterwards what each step actually found.
 */
export const buildDiscoveryPlan = (parsed) => {
  const q = parsed.query;
  const steps = [];
  let ordinal = 0;

  const wantsHiring = q.signals.some((s) => s.startsWith("HIRING_")) || q.jobTitleContains.length > 0;

  // A place with no industry ("businesses in Saudi Arabia that need HR
  // software") still has to search *that place*. Falling through to the global
  // job aggregators instead produced leads on the other side of the world that
  // the location filter then discarded — a run that reported success and
  // returned nothing. These defaults are the categories most likely to yield a
  // technology opportunity in any town.
  const DEFAULT_CATEGORIES = ["restaurant", "salon", "real_estate"];
  const categories = q.industries.length ? q.industries.slice(0, 3)
    : q.location ? DEFAULT_CATEGORIES
    : [];
  const wantsLocalBusinesses = categories.length > 0 && Boolean(q.location);

  if (wantsLocalBusinesses) {
    for (const categoryKey of categories) {
      steps.push({
        ordinal: ordinal++,
        kind: "OVERPASS",
        label: q.industries.length
          ? `Find ${OSM_CATEGORIES[categoryKey]?.label || categoryKey} businesses in ${q.location.name} via OpenStreetMap`
          : `No industry given — sampling ${OSM_CATEGORIES[categoryKey]?.label || categoryKey} businesses in ${q.location.name}`,
        params: { categoryKey, location: q.location.name, radiusMeters: 10_000, limit: 120 },
      });
    }
    steps.push({
      ordinal: ordinal++,
      kind: "CRAWL",
      label: "Crawl and audit the websites that were found",
      params: { maxHosts: 40, maxPagesPerHost: 7 },
    });
  }

  if (wantsHiring) {
    steps.push({
      ordinal: ordinal++,
      kind: "ATS_PROBE",
      label: q.location
        ? `Check public job boards for hiring companies in ${q.location.name}`
        : "Check public job boards for companies hiring these roles",
      params: { jobTitleContains: q.jobTitleContains, location: q.location?.name || null },
    });
    steps.push({
      ordinal: ordinal++,
      kind: "AGGREGATOR",
      label: "Search public job aggregators for matching live postings",
      params: { jobTitleContains: q.jobTitleContains, postedWithinDays: q.postedWithinDays || 30, location: q.location?.name || null },
    });
    // Hiring-led discovery finds companies by name alone. Without this step
    // they have no website, so no contact route and no reachability score.
    if (!wantsLocalBusinesses) {
      steps.push({
        ordinal: ordinal++,
        kind: "CRAWL",
        label: "Find each company's website and collect public contact details",
        params: { maxHosts: 25, maxPagesPerHost: 7, maxResolve: 20 },
      });
    }
  }

  // A query with neither a place nor a hiring angle still gets the ATS sweep —
  // it is the one source that works without a location.
  if (steps.length === 0) {
    steps.push({
      ordinal: ordinal++,
      kind: "AGGREGATOR",
      label: "Search public job aggregators for relevant companies",
      params: { jobTitleContains: q.jobTitleContains, postedWithinDays: q.postedWithinDays || 30 },
    });
  }

  // Google Places is optional and skips itself when no key is configured. It
  // runs before SIGNALS so a permanently closed business is known to scoring
  // rather than being ranked and emailed like a live one.
  steps.push({ ordinal: ordinal++, kind: "PLACES_VERIFY", label: "Cross-check each business against Google Places", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SIGNALS", label: "Derive signals from the collected evidence", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SCORE", label: "Score and rank the resulting leads", params: {} });

  return { steps, estimatedSeconds: steps.length * 25 };
};

/** Should a live discovery run be triggered for this query? */
export const shouldDiscover = (resultCount, parsed) =>
  resultCount < MIN_RESULTS_BEFORE_DISCOVER && (parsed.confidence >= 0.25 || parsed.query.industries.length > 0);

/** Human summary of the signal types a query asked for, for the empty state. */
export const describeSignals = (signals = []) =>
  [...new Set(signals.map((s) => SIGNAL_CATALOG[s]?.label).filter(Boolean))];

/**
 * Explain an empty result set.
 *
 * "0 leads matched" with no reason is the most frustrating thing this product
 * can say, especially straight after a discovery run reports success. This
 * re-counts the query with each constraint dropped in turn, so the answer can
 * name the filter that actually eliminated everything and suggest a fix.
 */
export const explainEmptyResult = async (parsed) => {
  const q = parsed.query;

  const constraints = [
    { key: "location", label: q.location ? `location “${q.location.name}”` : null,
      omit: (c) => ({ ...c, location: null }),
      hint: q.location ? `Try a specific city rather than a region — “Riyadh” or “Jeddah” finds far more than “Saudi Arabia”.` : null },
    { key: "service", label: q.service ? `service “${SERVICE_LABELS[q.service] || q.service}”` : null,
      omit: (c) => ({ ...c, service: null }),
      hint: q.service ? `No company found so far shows evidence of needing ${SERVICE_LABELS[q.service] || q.service}. That need is only detectable from a website or a job posting.` : null },
    { key: "signals", label: q.signals?.length ? `the “${describeSignals(q.signals).join(", ")}” condition` : null,
      omit: (c) => ({ ...c, signals: [] }),
      hint: q.signals?.length ? "Drop the condition to see every company found in that area." : null },
    { key: "industries", label: q.industries?.length ? `industry “${q.industries.map((k) => OSM_CATEGORIES[k]?.label || k).join(", ")}”` : null,
      omit: (c) => ({ ...c, industries: [] }), hint: null },
    { key: "jobTitleContains", label: q.jobTitleContains?.length ? "the requested job titles" : null,
      omit: (c) => ({ ...c, jobTitleContains: [] }), hint: null },
    { key: "postedWithinDays", label: q.postedWithinDays ? `the last ${q.postedWithinDays} days` : null,
      omit: (c) => ({ ...c, postedWithinDays: null }),
      hint: q.postedWithinDays ? "Widen the time window." : null },
  ].filter((c) => c.label);

  const blockers = [];
  for (const constraint of constraints) {
    const relaxed = await prisma.lead.count({ where: buildWhere(constraint.omit(q)) });
    if (relaxed > 0) {
      blockers.push({ key: constraint.key, label: constraint.label, wouldMatch: relaxed, hint: constraint.hint });
    }
  }

  const totalLeads = await prisma.lead.count({ where: { status: { notIn: NEVER_SHOW } } });

  return {
    totalLeadsInDatabase: totalLeads,
    // Sorted so the most productive thing to relax comes first.
    blockers: blockers.sort((a, b) => b.wouldMatch - a.wouldMatch),
    unparsed: parsed.unparsed || [],
  };
};


/**
 * Build the plan for an AI deep-research run.
 *
 * Both engines run: AI web search for reach (it finds businesses no map query
 * would surface) and the deterministic map/crawl path for ground truth. The
 * steps after them exist to make the AI's output trustworthy — resolve, verify,
 * gate, score — before anything reaches the grid.
 */
export const buildResearchPlan = (parsed, brief) => {
  const steps = [];
  let ordinal = 0;
  const q = parsed.query;
  const wantsHiring = (q.signals || []).some((s) => s.startsWith("HIRING_")) || (q.jobTitleContains || []).length > 0;

  // Everything the database already knows that matches this query joins the
  // run first. The AI engine is one input among several — when it is down, the
  // run must still stand on the deterministic ones. (Its absence here is why a
  // hiring query once returned an empty grid while quick search found leads.)
  steps.push({
    ordinal: ordinal++,
    kind: "DB_MATCH",
    label: "Include matching companies already in the database",
    params: {},
  });

  const strategies = (brief.searchStrategies || []).slice(0, AI_MAX_SEARCH_CALLS);
  strategies.forEach((strategy, index) => {
    steps.push({
      ordinal: ordinal++,
      kind: "AI_DISCOVER",
      label: `AI web search — ${strategy.label}`,
      params: { strategyIndex: index, maxCompanies: 12 },
    });
  });

  // The map search still runs: it is the only source that can prove a business
  // exists at an address, and it is where "listed but no website" comes from.
  const cities = brief.location?.cities?.length ? brief.location.cities.slice(0, 2) : [brief.location?.name].filter(Boolean);
  // Without an industry there is still a useful map search to run: these are
  // the categories most likely to carry a technology opportunity anywhere.
  // (With the AI brief available, its industries take precedence.)
  const named = brief.industries?.length ? brief.industries : q.industries || [];
  const categories = (named.length ? named : ["restaurant", "clothes"]).slice(0, 2);
  for (const city of cities) {
    for (const categoryKey of categories) {
      steps.push({
        ordinal: ordinal++,
        kind: "OVERPASS",
        label: `Map search — ${OSM_CATEGORIES[categoryKey]?.label || categoryKey} in ${city}`,
        params: { categoryKey, location: city, radiusMeters: 12_000, limit: 100 },
      });
    }
  }

  // Hiring queries get the deterministic hiring engines: live company job
  // boards for verification and public aggregators for fresh SME discovery.
  if (wantsHiring) {
    steps.push({
      ordinal: ordinal++,
      kind: "AGGREGATOR",
      label: "Search public job aggregators for matching live postings",
      params: { jobTitleContains: q.jobTitleContains, postedWithinDays: q.postedWithinDays || 30, location: q.location?.name || null },
    });
    steps.push({
      ordinal: ordinal++,
      kind: "ATS_PROBE",
      label: "Check the companies' own job boards",
      params: {},
    });
  }

  steps.push({ ordinal: ordinal++, kind: "RESOLVE_MERGE", label: "Merge and de-duplicate everything found", params: {} });
  steps.push({
    ordinal: ordinal++,
    kind: "CRAWL",
    label: "Visit each website and collect published contact details",
    params: { maxHosts: 30, maxPagesPerHost: 7, maxResolve: 15 },
  });
  steps.push({ ordinal: ordinal++, kind: "AI_VERIFY", label: "Verify every AI-claimed detail against a real page", params: {} });
  steps.push({ ordinal: ordinal++, kind: "PLACES_VERIFY", label: "Cross-check each business against Google Places", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SIGNALS", label: "Derive signals from the collected evidence", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SCORE", label: "Score and rank the results", params: {} });
  steps.push({ ordinal: ordinal++, kind: "AI_COMPOSE", label: "Write a personalised outreach email for each match", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SNAPSHOT", label: "Save the results to history", params: {} });

  return { steps, estimatedSeconds: steps.length * 30, mode: "RESEARCH" };
};


/**
 * Build the plan for a promote run — sourcing leads for one named product.
 *
 * Deliberately the same step kinds as buildResearchPlan, so the runner executes
 * almost all of it unchanged. What differs is where the targeting comes from: a
 * research run is aimed by a parsed sentence, a promote run by the product's
 * approved ICP, and the ICP is the only authority. Two consequences show up
 * below — hiring is used whenever the ICP asks for it, because a job posting is
 * the strongest buying signal this system can actually detect; and the map
 * engine is skipped rather than given default categories, because sampling
 * restaurants for an HR platform spends the run's budget on leads the ICP
 * already excludes.
 */
export const buildPromotePlan = (product, options = {}) => {
  // The human gate, enforced where the work is planned rather than only where
  // it is launched: an unapproved ICP is one nobody has read, and every lead
  // this plan would source gets emailed.
  if (!product?.icpApprovedAt) throw new Error("This product's ICP has not been approved yet.");
  const icp = product.icp || {};
  // The same reading of the ICP the run itself is given, so the plan's map
  // categories, job-title needles and market cannot disagree with what
  // DB_MATCH and the aggregators go on to filter by.
  const q = icpToParsedQuery(icp).query;

  const steps = [];
  let ordinal = 0;

  steps.push({
    ordinal: ordinal++,
    kind: "DB_MATCH",
    label: "Include matching companies already in the database",
    params: {},
  });

  const strategies = (icpToSearchStrategies(icp) || []).slice(0, options.maxSearchCalls || AI_MAX_SEARCH_CALLS);
  strategies.forEach((strategy, index) => {
    steps.push({
      ordinal: ordinal++,
      kind: "AI_DISCOVER",
      label: `AI web search — ${strategy.label}`,
      params: { strategyIndex: index, maxCompanies: 12 },
    });
  });

  // Companies that already use a competitor, whenever the ICP names one. This
  // is the highest-intent source the run has — a public review is a confirmed
  // category buyer stating its own pain — but it is scheduled here among the
  // other discovery steps precisely so it earns no shortcut: its candidates go
  // through the same merge, crawl and verification as everything else.
  const competitors = (icp.competitorsToDisplace || []).map((c) => String(c || "").trim()).filter(Boolean);
  if (competitors.length) {
    steps.push({
      ordinal: ordinal++,
      kind: "COMPETITOR_USERS",
      label: `Find companies already using ${competitors.slice(0, 3).join(", ")}`,
      params: { maxCompanies: 12 },
    });
  }

  // Hiring, whenever the ICP names a job posting as evidence. The aggregator
  // finds employers this database has never seen; the ATS probe confirms the
  // posting on the company's own board rather than trusting the aggregator.
  const wantsHiring = (icp.buyingSignals || []).some((s) => s?.detectableVia === "JOB_POSTING");
  if (wantsHiring) {
    steps.push({
      ordinal: ordinal++,
      kind: "AGGREGATOR",
      label: "Search public job aggregators for matching live postings",
      params: { jobTitleContains: q.jobTitleContains, postedWithinDays: 30, location: q.location?.name || null },
    });
    steps.push({
      ordinal: ordinal++,
      kind: "ATS_PROBE",
      label: "Check the companies' own job boards",
      params: {},
    });
  }

  // The map engine only earns its place when the ICP names both a real place
  // and an industry that OpenStreetMap actually models. Without an industry
  // there is no honest default here: a research run can fall back to sampling
  // local businesses because its query asked for a place, but a promote run
  // would just be buying leads its own ICP disqualifies.
  // Every market the ICP ranked, not just the one the parsed query collapsed to,
  // and a few industries rather than two. On a promote run the map engine is
  // often the only discovery source that works — the global job aggregators do
  // not cover Gulf SMBs, and web search needs an AI provider with credit — so
  // searching one city for two categories leaves most of an approved profile
  // unused. Still bounded: the crawl cap downstream is what governs the cost.
  const rankedCities = [...(icp.geographies || [])]
    .sort((a, b) => (a?.priority ?? 99) - (b?.priority ?? 99))
    .map((g) => g?.region)
    .filter(Boolean);
  // Two markets by two categories. Each map step is now one Overpass request
  // per tag, which is what made multi-tag categories work at all but also makes
  // a busy one take a couple of minutes; six steps would spend the whole run's
  // time budget before the crawler ever started.
  const cities = (rankedCities.length ? rankedCities : [q.location?.name].filter(Boolean)).slice(0, 2);
  const categories = (q.industries || []).slice(0, 2);
  if (cities.length && categories.length) {
    for (const city of cities) {
      for (const categoryKey of categories) {
        steps.push({
          ordinal: ordinal++,
          kind: "OVERPASS",
          label: `Map search — ${OSM_CATEGORIES[categoryKey]?.label || categoryKey} in ${city}`,
          params: { categoryKey, location: city, radiusMeters: 12_000, limit: 100 },
        });
      }
    }
  }

  steps.push({ ordinal: ordinal++, kind: "RESOLVE_MERGE", label: "Merge and de-duplicate everything found", params: {} });
  steps.push({
    ordinal: ordinal++,
    kind: "CRAWL",
    label: "Visit each website and collect published contact details",
    params: { maxHosts: 30, maxPagesPerHost: 7, maxResolve: 15 },
  });
  steps.push({ ordinal: ordinal++, kind: "AI_VERIFY", label: "Verify every AI-claimed detail against a real page", params: {} });
  steps.push({ ordinal: ordinal++, kind: "PLACES_VERIFY", label: "Cross-check each business against Google Places", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SIGNALS", label: "Derive signals from the collected evidence", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SCORE", label: "Score and rank the results", params: {} });
  steps.push({ ordinal: ordinal++, kind: "AI_COMPOSE", label: "Write a personalised outreach email for each match", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SNAPSHOT", label: "Save the results to history", params: {} });

  return { steps, estimatedSeconds: steps.length * 30, mode: "PROMOTE" };
};
