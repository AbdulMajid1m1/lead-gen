import prisma from "../prismaClient.js";
import { ingestArea } from "../lib/ingest/overpassIngest.js";
import { ingestWebsite } from "../lib/ingest/websiteIngest.js";
import { ingestAtsBoard } from "../lib/ingest/atsIngest.js";
import { ingestAggregators } from "../lib/ingest/aggregatorIngest.js";
import { evaluateCompanySignals } from "../lib/signals/signalEngine.js";
import { scoreCompany } from "../lib/scoring/scoreEngine.js";
import { logger } from "../utils/logger.js";

/**
 * Seeds the database with real, live data — no fixtures, no fake companies.
 *
 * Everything here comes from free public sources, so a fresh clone can produce
 * genuine leads on the first run without any paid API key.
 */

/** Cities chosen for dense OpenStreetMap business coverage. */
const AREAS = [
  { location: "Dubai, United Arab Emirates", categories: ["restaurant", "salon"], radiusMeters: 8000 },
  { location: "Manchester, United Kingdom", categories: ["restaurant", "dentist"], radiusMeters: 6000 },
  { location: "Austin, Texas, United States", categories: ["restaurant", "gym"], radiusMeters: 7000 },
];

/**
 * Companies with confirmed public applicant-tracking boards. These give the
 * hiring-intelligence side of the product real ACTIVE jobs to work with.
 */
const ATS_BOARDS = [
  { provider: "ATS_GREENHOUSE", slug: "stripe" },
  { provider: "ATS_GREENHOUSE", slug: "airbnb" },
  { provider: "ATS_GREENHOUSE", slug: "figma" },
  { provider: "ATS_LEVER", slug: "palantir" },
  { provider: "ATS_LEVER", slug: "netflix" },
  { provider: "ATS_ASHBY", slug: "ashby" },
  { provider: "ATS_ASHBY", slug: "linear" },
  { provider: "ATS_SMARTRECRUITERS", slug: "visa" },
  { provider: "ATS_WORKABLE", slug: "netdata" },
];

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const main = async () => {
  const only = arg("only", "all"); // all | areas | ats | aggregators | score
  const maxCrawl = Number(arg("maxCrawl", "18"));
  const touched = new Set();
  const summary = { areas: 0, companies: 0, crawled: 0, atsBoards: 0, jobs: 0, leads: 0 };

  logger.info({ only }, "seed starting — this uses live public sources and takes a few minutes");

  // ─── Local businesses ───────────────────────────────────────────────────────
  if (only === "all" || only === "areas") {
    for (const area of AREAS) {
      for (const categoryKey of area.categories) {
        try {
          const res = await ingestArea({
            location: area.location,
            categoryKey,
            radiusMeters: area.radiusMeters,
            limit: 120,
          });
          if (!res.ok) {
            logger.warn({ ...area, categoryKey, reason: res.reason }, "area ingest failed — continuing");
            continue;
          }
          summary.areas += 1;
          summary.companies += res.created;
          res.companyIds.forEach((id) => touched.add(id));
          logger.info({ location: area.location, categoryKey, found: res.found, created: res.created, noWebsite: res.withoutWebsite.length }, "area seeded");
        } catch (err) {
          logger.warn({ ...area, categoryKey, msg: err.message }, "area ingest threw — continuing");
        }
      }
    }
  }

  // ─── Public job boards ──────────────────────────────────────────────────────
  if (only === "all" || only === "ats") {
    for (const board of ATS_BOARDS) {
      try {
        const res = await ingestAtsBoard(board);
        if (!res.ok) {
          logger.warn({ ...board, reason: res.reason }, "ATS board unavailable — continuing");
          continue;
        }
        summary.atsBoards += 1;
        summary.jobs += res.jobsIngested;
        touched.add(res.companyId);
        logger.info({ ...board, company: res.companyName, jobs: res.jobsIngested }, "ATS board seeded");
      } catch (err) {
        logger.warn({ ...board, msg: err.message }, "ATS ingest threw — continuing");
      }
    }
  }

  // ─── Aggregators ────────────────────────────────────────────────────────────
  if (only === "all" || only === "aggregators") {
    try {
      const res = await ingestAggregators({ postedWithinDays: 30, maxCompanies: 40 });
      res.companyIds.forEach((id) => touched.add(id));
      summary.jobs += res.jobsIngested;
      logger.info({ sources: res.sources, jobs: res.jobsIngested, companies: res.companyIds.length }, "aggregators seeded");
    } catch (err) {
      logger.warn({ msg: err.message }, "aggregator ingest failed — continuing");
    }
  }

  // ─── Crawl the websites we found ────────────────────────────────────────────
  if (only === "all" || only === "areas") {
    const withDomains = await prisma.company.findMany({
      where: { id: { in: [...touched] }, domains: { some: {} }, lastCrawledAt: null },
      include: { domains: { take: 1 } },
      take: maxCrawl,
    });
    logger.info({ count: withDomains.length }, "crawling company websites");

    for (const company of withDomains) {
      try {
        const res = await ingestWebsite({ companyId: company.id, url: `https://${company.domains[0].domain}`, maxPages: 4 });
        if (res.ok) summary.crawled += 1;
      } catch (err) {
        logger.debug({ company: company.name, msg: err.message }, "crawl failed");
      }
    }
  }

  // ─── Signals & scoring for everything touched ───────────────────────────────
  const toScore = touched.size
    ? [...touched]
    : (await prisma.company.findMany({ select: { id: true } })).map((c) => c.id);

  logger.info({ count: toScore.length }, "deriving signals and scoring");
  for (const companyId of toScore) {
    try {
      await evaluateCompanySignals(companyId);
      const res = await scoreCompany(companyId);
      if (!res.skipped) summary.leads += 1;
    } catch (err) {
      logger.debug({ companyId, msg: err.message }, "scoring failed");
    }
  }

  logger.info(summary, "seed complete");

  const top = await prisma.lead.findMany({
    orderBy: { score: "desc" },
    take: 8,
    include: { company: true, reasons: { orderBy: { rank: "asc" }, take: 1 } },
  });
  console.log("\nTop leads after seeding:");
  for (const l of top) {
    console.log(`  ${String(l.score).padStart(3)}  ${l.company.name.slice(0, 30).padEnd(32)} ${l.primaryOpportunity.padEnd(17)} ${(l.reasons[0]?.text || "").slice(0, 70)}`);
  }

  await prisma.$disconnect();
};

main().catch(async (err) => {
  logger.error({ err }, "seed failed");
  await prisma.$disconnect();
  process.exit(1);
});
