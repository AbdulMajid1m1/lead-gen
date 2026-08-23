import { EventEmitter } from "node:events";
import prisma from "../../prismaClient.js";
import { ingestArea } from "../ingest/overpassIngest.js";
import { ingestWebsite } from "../ingest/websiteIngest.js";
import { discoverAndIngestAts } from "../ingest/atsIngest.js";
import { resolveCompanyDomain } from "../ingest/domainResolver.js";
import { discoverViaWebSearch, resolveCandidates } from "../research/discover.js";
import { verifyCandidateClaims, passesExistenceGate } from "../research/verifier.js";
import { composeForRun } from "../research/compose.js";
import { snapshotGrid } from "../research/grid.js";
import { CostTracker } from "../llm/responses.js";
import { buildWhere } from "../nlquery/planner.js";
import pLimit from "p-limit";
import { ingestAggregators } from "../ingest/aggregatorIngest.js";
import { evaluateCompanySignals } from "../signals/signalEngine.js";
import { scoreCompany } from "../scoring/scoreEngine.js";
import { DISCOVERY_MAX_COMPANIES, DISCOVERY_MAX_CRAWL_HOSTS, DISCOVERY_TIMEOUT_MS, RESEARCH_TIMEOUT_MS, AI_MAX_CITATION_FETCHES, CRAWLER_CONCURRENCY } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("discovery");

/**
 * Executes a discovery plan and streams progress.
 *
 * Runs in-process with a hard concurrency cap rather than through the queue:
 * a discovery run is started by a user who is *watching* it, so the latency of
 * a queue round-trip buys nothing, and the run's own step records in Postgres
 * already give it durability and observability. The worker owns the scheduled
 * work (job re-verification, re-audits) where queueing genuinely helps.
 */

export const discoveryEvents = new EventEmitter();
discoveryEvents.setMaxListeners(200);

const active = new Map(); // runId → { cancelled }
let inFlight = 0;
const MAX_CONCURRENT_RUNS = 2;

const emit = (runId, event) => discoveryEvents.emit(runId, { ...event, at: new Date().toISOString() });

export const createDiscoveryRun = async ({ plan, trigger = "NL_QUERY", searchQueryId = null }) => {
  const run = await prisma.discoveryRun.create({
    data: {
      trigger,
      searchQueryId,
      plan,
      status: "PENDING",
      steps: {
        create: plan.steps.map((s) => ({
          ordinal: s.ordinal,
          kind: s.kind,
          label: s.label.slice(0, 200),
          status: "PENDING",
        })),
      },
    },
    include: { steps: { orderBy: { ordinal: "asc" } } },
  });
  return run;
};

export const startDiscoveryRun = (runId, parsed) => {
  if (active.has(runId)) return;
  active.set(runId, { cancelled: false });
  // Deliberately not awaited: the HTTP response returns the run id immediately
  // and the client follows progress over SSE.
  executeRun(runId, parsed).catch((err) => {
    logger.error({ err, runId }, "discovery run crashed");
  });
};

export const cancelDiscoveryRun = (runId) => {
  const state = active.get(runId);
  if (state) state.cancelled = true;
};

const executeRun = async (runId, parsed) => {
  while (inFlight >= MAX_CONCURRENT_RUNS) {
    await new Promise((r) => setTimeout(r, 500));
  }
  inFlight += 1;

  const planned = await prisma.discoveryRun.findUnique({ where: { id: runId }, select: { plan: true } });
  const isResearch = planned?.plan?.mode === "RESEARCH";
  const deadline = Date.now() + (isResearch ? RESEARCH_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS);
  const stats = { companiesFound: 0, crawled: 0, blocked: 0, jobsFound: 0, leadsCreated: 0, errors: 0 };
  const touchedCompanyIds = new Set();
  // Spend governor for the AI steps. Shared across the whole run so one search
  // strategy cannot consume the budget meant for verification and composition.
  const tracker = new CostTracker();

  await prisma.discoveryRun.update({ where: { id: runId }, data: { status: "RUNNING", startedAt: new Date() } });
  emit(runId, { type: "run.started", stats });

  const run = await prisma.discoveryRun.findUnique({ where: { id: runId }, include: { steps: { orderBy: { ordinal: "asc" } } } });
  const planSteps = run.plan.steps || [];

  let failedSteps = 0;

  for (const step of run.steps) {
    const state = active.get(runId);
    if (state?.cancelled) break;

    // SIGNALS, SCORE and SNAPSHOT are cheap, purely local, and they are what
    // turns everything already collected into visible results. Skipping them on
    // a slow run threw away the whole run's work and reported zero rows, so the
    // deadline only ever stops further *collection*.
    const FINALISING = new Set(["SIGNALS", "SCORE", "SNAPSHOT"]);
    if (Date.now() > deadline && !FINALISING.has(step.kind)) {
      logger.warn({ runId, step: step.kind }, "past the time budget — skipping further collection");
      await prisma.discoveryRunStep.update({
        where: { id: step.id },
        data: { status: "CANCELLED", finishedAt: new Date(), errorText: "Skipped: the run reached its time budget." },
      });
      continue;
    }

    const planStep = planSteps.find((p) => p.ordinal === step.ordinal) || {};
    await prisma.discoveryRunStep.update({ where: { id: step.id }, data: { status: "RUNNING", startedAt: new Date() } });
    emit(runId, { type: "step.started", ordinal: step.ordinal, kind: step.kind, label: step.label });

    try {
      const counts = await runStep({ kind: step.kind, params: planStep.params || {}, parsed, runId, touchedCompanyIds, stats, deadline, tracker });
      await prisma.discoveryRunStep.update({
        where: { id: step.id },
        data: { status: "SUCCEEDED", finishedAt: new Date(), counts },
      });
      emit(runId, { type: "step.finished", ordinal: step.ordinal, status: "SUCCEEDED", counts, stats });
    } catch (err) {
      failedSteps += 1;
      stats.errors += 1;
      logger.warn({ runId, step: step.kind, msg: err.message }, "discovery step failed");
      await prisma.discoveryRunStep.update({
        where: { id: step.id },
        data: { status: "FAILED", finishedAt: new Date(), errorText: String(err.message).slice(0, 1000) },
      });
      emit(runId, { type: "step.finished", ordinal: step.ordinal, status: "FAILED", error: err.message, stats });
    }
  }

  const status = active.get(runId)?.cancelled ? "CANCELLED"
    : failedSteps === 0 ? "SUCCEEDED"
    : failedSteps < run.steps.length ? "PARTIAL"
    : "FAILED";

  await prisma.discoveryRun.update({
    where: { id: runId },
    data: { status, finishedAt: new Date(), stats, aiUsage: tracker.calls ? tracker.toJSON() : undefined },
  });
  emit(runId, { type: "run.finished", status, stats });

  active.delete(runId);
  inFlight -= 1;
  logger.info({ runId, status, ...stats }, "discovery run complete");
};

const runStep = async ({ kind, params, parsed, runId, touchedCompanyIds, stats, deadline, tracker }) => {
  switch (kind) {
    case "OVERPASS": {
      const res = await ingestArea({
        location: params.location,
        categoryKey: params.categoryKey,
        radiusMeters: params.radiusMeters || 10_000,
        limit: Math.min(params.limit || 120, DISCOVERY_MAX_COMPANIES),
        discoveryRunId: runId,
      });
      if (!res.ok) throw new Error(`OpenStreetMap lookup failed: ${res.reason}`);
      res.companyIds.forEach((id) => touchedCompanyIds.add(id));
      stats.companiesFound += res.found;
      emit(runId, { type: "progress", stats });
      return { found: res.found, created: res.created, existing: res.updated, withoutWebsite: res.withoutWebsite.length };
    }

    case "CRAWL": {
      // Companies discovered through a job board arrive with a name and nothing
      // else. Resolving a website first is what makes them contactable at all —
      // without it they can never score any reachability points.
      // A failed resolution is retried after a week, not banned forever — the
      // resolver's rules improve and sites change.
      const retryCutoff = new Date(Date.now() - 7 * 86_400_000);
      const domainless = await prisma.company.findMany({
        where: {
          id: { in: [...touchedCompanyIds] },
          domains: { none: {} },
          facts: { none: { key: "domain_unresolved", extractedAt: { gte: retryCutoff } } },
        },
        take: Math.min(params.maxResolve || 20, 25),
      });
      let resolved = 0;
      for (const company of domainless) {
        if (Date.now() > deadline || active.get(runId)?.cancelled) break;
        try {
          const res = await resolveCompanyDomain(company.id, { maxCandidates: 3 });
          if (res.found && !res.alreadyKnown) resolved += 1;
        } catch (err) {
          logger.debug({ company: company.name, msg: err.message }, "domain resolution failed");
        }
      }
      if (resolved) emit(runId, { type: "progress", stats });

      const companies = await prisma.company.findMany({
        where: { id: { in: [...touchedCompanyIds] }, domains: { some: {} } },
        include: { domains: { take: 1 } },
        take: Math.min(params.maxHosts || 40, DISCOVERY_MAX_CRAWL_HOSTS),
      });

      // Crawl companies concurrently — the "many tabs" idea, done politely:
      // hostPolicy still serialises requests *per host*, so this parallelism
      // only ever spans different websites and never hammers one server.
      let crawled = 0;
      let blocked = 0;
      const limit = pLimit(Math.max(2, Math.min(CRAWLER_CONCURRENCY, 8)));
      await Promise.allSettled(companies.map((company) => limit(async () => {
        if (Date.now() > deadline || active.get(runId)?.cancelled) return;
        try {
          const res = await ingestWebsite({
            companyId: company.id,
            url: `https://${company.domains[0].domain}`,
            maxPages: params.maxPagesPerHost || 4,
            discoveryRunId: runId,
          });
          if (res.ok) crawled += 1;
          else blocked += 1;
        } catch {
          blocked += 1;
        }
        stats.crawled = crawled;
        stats.blocked = blocked;
        if ((crawled + blocked) % 5 === 0) emit(runId, { type: "progress", stats });
      })));
      return { crawled, blocked, resolved, considered: companies.length };
    }

    case "ATS_PROBE": {
      // Probe the companies we have on hand that look like employers.
      const candidates = await prisma.company.findMany({
        where: {
          id: { in: [...touchedCompanyIds] },
          atsAccounts: { none: {} },
        },
        take: 25,
      });
      let found = 0;
      let jobs = 0;
      for (const company of candidates) {
        if (Date.now() > deadline || active.get(runId)?.cancelled) break;
        const res = await discoverAndIngestAts({ companyId: company.id, companyName: company.name });
        if (res.ok) {
          found += 1;
          jobs += res.jobsIngested;
        }
      }
      stats.jobsFound += jobs;
      return { probed: candidates.length, boardsFound: found, jobsIngested: jobs };
    }

    case "AGGREGATOR": {
      const res = await ingestAggregators({
        jobTitleContains: params.jobTitleContains || parsed?.query?.jobTitleContains || [],
        postedWithinDays: params.postedWithinDays || 30,
        location: parsed?.query?.location?.name || null,
        maxCompanies: 60,
        discoveryRunId: runId,
      });
      res.companyIds.forEach((id) => touchedCompanyIds.add(id));
      stats.companiesFound += res.companiesCreated;
      stats.jobsFound += res.jobsIngested;
      emit(runId, { type: "progress", stats });
      return { companiesCreated: res.companiesCreated, jobsIngested: res.jobsIngested, sources: res.sources };
    }

    case "SIGNALS": {
      let evaluated = 0;
      for (const companyId of touchedCompanyIds) {
        if (Date.now() > deadline) break;
        try {
          await evaluateCompanySignals(companyId);
          evaluated += 1;
        } catch (err) {
          logger.debug({ companyId, msg: err.message }, "signal evaluation failed");
        }
      }
      return { evaluated };
    }

    case "SCORE": {
      let created = 0;
      let skipped = 0;
      for (const companyId of touchedCompanyIds) {
        try {
          const res = await scoreCompany(companyId, { discoveryRunId: runId });
          if (res.skipped) skipped += 1;
          else created += 1;
        } catch (err) {
          logger.debug({ companyId, msg: err.message }, "scoring failed");
        }
      }
      stats.leadsCreated = created;
      emit(runId, { type: "progress", stats });
      return { leadsCreated: created, belowThreshold: skipped };
    }

    // ─── AI research steps ──────────────────────────────────────────────────

    case "DB_MATCH": {
      // Seed the run with what we already know. This is what makes a research
      // run degrade to "our own search" rather than to nothing when the AI is
      // unavailable — and it gives ATS_PROBE a set of companies to check.
      const where = buildWhere(parsed?.query || {});
      const matches = await prisma.lead.findMany({ where, select: { companyId: true }, take: 50 });
      matches.forEach((m) => touchedCompanyIds.add(m.companyId));
      stats.companiesFound += matches.length;
      emit(runId, { type: "progress", stats });
      return { matched: matches.length };
    }


    case "AI_DISCOVER": {
      const brief = await loadBrief(runId);
      if (!brief) throw new Error("No research brief is available for this run.");
      const strategy = brief.searchStrategies?.[params.strategyIndex ?? 0];
      if (!strategy) throw new Error("The brief contains no strategy at this position.");

      const res = await discoverViaWebSearch({ runId, strategy, brief, tracker, maxCompanies: params.maxCompanies || 12 });
      if (!res.ok) throw new Error(`AI web search unavailable: ${res.reason}`);
      stats.companiesFound += res.created;
      emit(runId, { type: "progress", stats });
      return { found: res.created, uncited: res.uncited, pagesSearched: res.searched, notes: res.notes };
    }

    case "RESOLVE_MERGE": {
      const brief = await loadBrief(runId);
      const res = await resolveCandidates(runId, { exclusions: brief?.exclusions || [] });
      // Newly resolved companies join the crawl/scoring set for the later steps.
      const resolved = await prisma.aiCandidate.findMany({
        where: { runId, companyId: { not: null } },
        select: { companyId: true },
      });
      resolved.forEach((r) => touchedCompanyIds.add(r.companyId));
      emit(runId, { type: "progress", stats });
      return res;
    }

    case "AI_VERIFY": {
      const candidates = await prisma.aiCandidate.findMany({
        where: { runId, companyId: { not: null }, status: { in: ["MATCHED_EXISTING", "CREATED_COMPANY"] } },
        select: { id: true },
      });
      const totals = { confirmed: 0, contradicted: 0, uncheckable: 0, fetches: 0, rejected: 0 };
      let budget = AI_MAX_CITATION_FETCHES;

      for (const { id } of candidates) {
        if (Date.now() > deadline || active.get(runId)?.cancelled) break;
        const res = await verifyCandidateClaims(id, { fetchBudget: budget });
        budget -= res.fetches;
        totals.confirmed += res.confirmed;
        totals.contradicted += res.contradicted;
        totals.uncheckable += res.uncheckable;
        totals.fetches += res.fetches;

        // The existence gate: a business we could not show exists never becomes
        // a scored lead, however confident the model was about it.
        const gate = await passesExistenceGate(id);
        if (!gate.passed) {
          const candidate = await prisma.aiCandidate.update({
            where: { id },
            data: { status: "REJECTED_NO_EXISTENCE", rejectedReason: gate.reason },
          });
          if (candidate.companyId) touchedCompanyIds.delete(candidate.companyId);
          totals.rejected += 1;
        }
      }
      emit(runId, { type: "progress", stats });
      return totals;
    }

    case "AI_COMPOSE": {
      const leads = await prisma.lead.findMany({
        where: { companyId: { in: [...touchedCompanyIds] }, status: { notIn: ["DO_NOT_CONTACT", "ARCHIVED"] } },
        orderBy: { score: "desc" },
        select: { id: true },
      });
      const brief = await loadBrief(runId);
      const res = await composeForRun({ runId, leadIds: leads.map((l) => l.id), tracker, serviceOverride: brief?.service || null });
      emit(runId, { type: "progress", stats });
      return res;
    }

    case "SNAPSHOT": {
      const res = await snapshotGrid(runId);
      return res;
    }

    default:
      throw new Error(`Unknown discovery step kind: ${kind}`);
  }
};

export const getRunWithSteps = (runId) =>
  prisma.discoveryRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { ordinal: "asc" } }, _count: { select: { leads: true } } },
  });

/** The brief drives every AI step; it is written before the run starts. */
const loadBrief = async (runId) => {
  const row = await prisma.researchBrief.findUnique({ where: { runId } });
  return row?.brief ?? null;
};
