import prisma from "../../prismaClient.js";
import { safeFetchJson } from "../crawler/safeFetch.js";
import { withHostSlot, setCrawlDelay } from "../crawler/hostPolicy.js";
import { ensureSource, recordSourceRecord, resolveCompany, recordFact } from "../provenance/recorder.js";
import { initialStatusFor } from "../jobs/jobStatusEngine.js";
import { parseJobText } from "../extract/jobTextParser.js";
import { normalizeJobTitle, normalizeDomain } from "../../utils/normalize.js";
import { expandLocation } from "../research/brief.js";
import { log } from "../../utils/logger.js";

const logger = log("aggregator");

/**
 * Public job aggregators.
 *
 * These are a *discovery* channel, not a source of truth about whether a role
 * is open: an aggregator listing outlives the vacancy behind it. Everything
 * ingested here therefore starts at RECENTLY_ACTIVE or UNKNOWN, and only
 * becomes ACTIVE if the company's own board confirms it (see jobStatusEngine).
 */

const AGGREGATORS = {
  AGG_ARBEITNOW: {
    kind: "AGG_ARBEITNOW",
    name: "Arbeitnow",
    host: "www.arbeitnow.com",
    attribution: "Job data from the public Arbeitnow job-board API.",
    url: () => "https://www.arbeitnow.com/api/job-board-api",
    parse: (json) =>
      (json?.data || []).map((j) => ({
        externalId: j.slug,
        title: j.title,
        companyName: j.company_name,
        url: j.url,
        location: j.location,
        remote: Boolean(j.remote),
        postedAt: j.created_at ? new Date(j.created_at * 1000) : null,
        descriptionSnippet: stripHtml(j.description),
        tags: j.tags || [],
        raw: j,
      })),
  },
  AGG_JOBICY: {
    kind: "AGG_JOBICY",
    name: "Jobicy",
    host: "jobicy.com",
    attribution: "Job data from the public Jobicy API.",
    url: () => "https://jobicy.com/api/v2/remote-jobs?count=50",
    parse: (json) =>
      (json?.jobs || []).map((j) => ({
        externalId: String(j.id),
        title: j.jobTitle,
        companyName: j.companyName,
        url: j.url,
        location: j.jobGeo,
        remote: true,
        postedAt: j.pubDate ? new Date(j.pubDate) : null,
        descriptionSnippet: stripHtml(j.jobExcerpt || j.jobDescription),
        tags: j.jobIndustry || [],
        raw: j,
      })),
  },
  AGG_REMOTIVE: {
    kind: "AGG_REMOTIVE",
    name: "Remotive",
    host: "remotive.com",
    attribution: "Job data from the public Remotive API. Used for company discovery only, per their terms.",
    // Remotive's own payload states a limit of roughly four fetches per day and
    // forbids republishing to job sites. We are neither: this is capped hard
    // below and the data is used to find companies, never re-listed.
    url: (params) => `https://remotive.com/api/remote-jobs?limit=${Math.min(params.limit || 50, 100)}`,
    dailyFetchLimit: 4,
    parse: (json) =>
      (json?.jobs || []).map((j) => ({
        externalId: String(j.id),
        title: j.title,
        companyName: j.company_name,
        url: j.url,
        location: j.candidate_required_location,
        remote: true,
        postedAt: j.publication_date ? new Date(j.publication_date) : null,
        descriptionSnippet: stripHtml(j.description),
        tags: j.tags || [],
        raw: j,
      })),
  },
};


/**
 * Does an aggregator posting plausibly sit in the requested place?
 *
 * Aggregator location strings are free text ("Remote, EU", "Riyadh, SA",
 * "Anywhere"), so this matches on any significant word of the query and
 * accepts a worldwide-remote listing only when it does not name a *different*
 * region.
 */
const jobMatchesLocation = (job, location) => {
  const haystack = `${job.location || ""} ${job.raw?.candidate_required_location || ""}`.toLowerCase();
  if (!haystack.trim()) return false;

  // A country query must also match its major cities — a Riyadh posting is a
  // "Saudi Arabia" result even though the string never says so.
  const expanded = expandLocation({ name: String(location), countryCode: null, cities: [] }) || {};
  const terms = [String(location), ...(expanded.cities || [])];
  const words = terms.flatMap((t) => t.toLowerCase().split(/\s+/)).filter((w) => w.length >= 3);
  return words.some((w) => haystack.includes(w));
  // Globally-remote listings ("Worldwide", "Anywhere") used to pass here, which
  // is exactly how a Saudi Arabia search filled up with London tech employers.
  // A place-specific search now returns place-specific companies only.
};

/** Job locations that are regions, not cities — never record them as a city. */
const NON_CITY_LOCATION = /^(?:remote|worldwide|anywhere|global|any location|emea|apac|europe|eu|usa|americas|north america|latam|asia|africa|international)$/i;

const cityFromJobLocation = (location) => {
  const first = String(location || "").split(",")[0]?.trim();
  if (!first || NON_CITY_LOCATION.test(first)) return null;
  return first;
};

const stripHtml = (html) =>
  html ? String(html).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 1500) : null;

for (const a of Object.values(AGGREGATORS)) setCrawlDelay(a.host, 3000);

/** Enforce a per-source daily fetch budget where the source's terms require it. */
const withinDailyBudget = async (sourceId, limit) => {
  if (!limit) return true;
  const since = new Date(Date.now() - 24 * 3600_000);
  const count = await prisma.sourceRecord.count({ where: { sourceId, fetchedAt: { gte: since } } });
  return count < limit * 60; // one fetch yields many records; budget by batch
};

/**
 * Pull matching jobs from the aggregators and land the hiring companies.
 */
export const ingestAggregators = async ({
  jobTitleContains = [],
  postedWithinDays = 30,
  location = null,
  maxCompanies = 60,
  discoveryRunId = null,
} = {}) => {
  const cutoff = new Date(Date.now() - postedWithinDays * 86_400_000);
  const companyIds = new Set();
  const usedSources = [];
  let jobsIngested = 0;
  let companiesCreated = 0;

  for (const def of Object.values(AGGREGATORS)) {
    if (companyIds.size >= maxCompanies) break;

    const source = await ensureSource({ kind: def.kind, name: def.name, baseUrl: `https://${def.host}`, attribution: def.attribution });
    if (!(await withinDailyBudget(source.id, def.dailyFetchLimit))) {
      logger.info({ source: def.name }, "skipping — daily fetch budget for this source is spent");
      continue;
    }

    let jobs;
    try {
      const res = await withHostSlot(def.host, () => safeFetchJson(def.url({ limit: 100 }), { timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 }));
      jobs = def.parse(res.json);
      usedSources.push(def.name);
    } catch (err) {
      logger.warn({ source: def.name, msg: err.message }, "aggregator fetch failed");
      continue;
    }

    for (const job of jobs) {
      if (companyIds.size >= maxCompanies) break;
      if (!job.companyName || !job.title) continue;
      if (job.postedAt && job.postedAt < cutoff) continue;

      // Only keep postings that actually indicate technology work — the whole
      // point is finding companies with a technology need.
      const parsed = parseJobText(job);
      if (!parsed.primary) continue;

      // If the query named specific roles, respect it.
      if (jobTitleContains.length) {
        const t = normalizeJobTitle(job.title);
        if (!jobTitleContains.some((needle) => t.includes(needle.trim()))) continue;
      }
      // When the user named a place, the job must actually be in it. The
      // previous rule exempted remote jobs, which meant a search for Saudi
      // Arabia happily ingested globally-remote German postings and then
      // filtered every one of them back out at render time — 23 leads of
      // wasted crawling and a confusing empty result.
      if (location && !jobMatchesLocation(job, location)) continue;

      const record = await recordSourceRecord({
        sourceId: source.id,
        externalId: String(job.externalId),
        url: job.url,
        payload: job.raw,
      });

      // Only an explicit company-website field may become a domain. An earlier
      // version also accepted `companyLogo`, which is hosted by the aggregator —
      // that assigned "jobicy.com" to the company as its own website.
      const declaredWebsite = job.raw?.company_website || job.raw?.companyWebsite || job.raw?.company_url || null;
      const domainGuess = normalizeDomain(declaredWebsite);
      const aggregatorHost = normalizeDomain(`https://${def.host}`);

      const { company, created } = await resolveCompany({
        name: job.companyName,
        domain: domainGuess && domainGuess !== aggregatorHost ? domainGuess : null,
        // The posting's location describes the job, not the company HQ — and
        // "Worldwide"/"Remote" is not a city at all.
        city: cityFromJobLocation(job.location),
        industry: "Technology employer",
        discoveredVia: def.kind,
      });
      if (created) companiesCreated += 1;
      companyIds.add(company.id);

      const status = initialStatusFor({ fromBoard: false, postedAt: job.postedAt });

      const stored = await prisma.jobPosting.upsert({
        where: { sourceId_externalId: { sourceId: source.id, externalId: String(job.externalId) } },
        update: {
          companyId: company.id,
          title: job.title.slice(0, 300),
          normalizedTitle: normalizeJobTitle(job.title).slice(0, 300),
          url: job.url,
          location: job.location?.slice(0, 255) ?? null,
          remote: job.remote,
          postedAt: job.postedAt,
          descriptionSnippet: job.descriptionSnippet?.slice(0, 2000) ?? null,
        },
        create: {
          companyId: company.id,
          sourceId: source.id,
          externalId: String(job.externalId),
          title: job.title.slice(0, 300),
          normalizedTitle: normalizeJobTitle(job.title).slice(0, 300),
          url: job.url,
          location: job.location?.slice(0, 255) ?? null,
          remote: job.remote,
          postedAt: job.postedAt,
          descriptionSnippet: job.descriptionSnippet?.slice(0, 2000) ?? null,
          status,
          statusEvidence: [{
            method: "aggregator_listing",
            source: def.name,
            decidedStatus: status,
            note: "Listed on a public aggregator; not yet confirmed against the company's own board.",
            at: new Date().toISOString(),
          }],
        },
      });

      for (const s of parsed.skills.slice(0, 30)) {
        await prisma.jobSkill.upsert({
          where: { jobPostingId_skill: { jobPostingId: stored.id, skill: s.skill } },
          update: {},
          create: { jobPostingId: stored.id, skill: s.skill, kind: s.kind },
        });
      }

      await recordFact({
        companyId: company.id,
        key: `job_posting:${stored.id}`,
        value: job.title.slice(0, 300),
        valueJson: { jobId: stored.id, status, roleCategory: parsed.primary.signal, source: def.name },
        confidenceLevel: "DETECTED",
        extractorName: "aggregatorIngest",
        evidenceSnippet: `Listed on ${def.name} as "${job.title}"${job.location ? ` (${job.location})` : ""}${job.postedAt ? `, posted ${job.postedAt.toISOString().slice(0, 10)}` : ""}.`,
        sourceRecordId: record.id,
      });

      jobsIngested += 1;
    }
  }

  logger.info({ sources: usedSources, jobsIngested, companies: companyIds.size }, "aggregators ingested");
  return { companyIds: [...companyIds], companiesCreated, jobsIngested, sources: usedSources };
};

/**
 * Upgrade aggregator-discovered companies by finding their real job board.
 * A confirmed board turns UNKNOWN postings into verifiable ACTIVE ones.
 */
export const confirmAggregatorCompanies = async (companyIds, { discoverAndIngestAts }) => {
  let confirmed = 0;
  for (const id of companyIds) {
    const company = await prisma.company.findUnique({ where: { id } });
    if (!company) continue;
    const res = await discoverAndIngestAts({ companyId: id, companyName: company.name });
    if (res.ok) confirmed += 1;
  }
  return { confirmed };
};
