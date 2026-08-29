/**
 * Crawl, evaluate and score companies already sitting in the database.
 *
 * A discovery run has two budgets that a wide sweep exhausts long before it
 * runs out of companies: DISCOVERY_MAX_CRAWL_HOSTS and the run deadline. When
 * a single run lands companies across several cities, the crawl budget is spent
 * on whichever hosts the loop reached first and the rest are left with a
 * CompanyDomain and no CrawlResult. Those companies are not low quality — they
 * are unassessed, and they score nothing because scoreEngine has no opportunity
 * signal to read. The Austin restaurant set was in exactly that state: 120
 * companies, 0 crawled, 7 leads, and those 7 only because NO_WEBSITE can be
 * derived without fetching anything.
 *
 * This script finishes the job for one city, using the same three library
 * functions the runner's CRAWL → SIGNALS → SCORE steps call, so every guard
 * still applies: robots.txt and per-host serialisation in the crawler,
 * verifyDomainIdentity rejecting a domain that turns out to belong to somebody
 * else, the suppression list, and MIN_SCORE_TO_CREATE_LEAD. Nothing here
 * consults an LLM, so it works with no AI credit.
 *
 * Usage (inside the api container):
 *   node scripts/assess-city.mjs --city Austin --dry-run
 *   node scripts/assess-city.mjs --city Austin --concurrency 3
 *   node scripts/assess-city.mjs --city Austin --country US --limit 10
 *
 * Re-running is safe: crawl results, signals and leads all upsert on natural
 * keys, so a second pass refreshes evidence rather than duplicating it. By
 * default a company crawled within --recrawl-days (7) is skipped, so an
 * interrupted sweep can simply be run again.
 */
import prisma from "../prismaClient.js";
import pLimit from "p-limit";
import { ingestWebsite } from "../lib/ingest/websiteIngest.js";
import { evaluateCompanySignals } from "../lib/signals/signalEngine.js";
import { scoreCompany } from "../lib/scoring/scoreEngine.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const city = arg("city");
const country = arg("country");
const limit = Number(arg("limit", 0)) || 0;
const concurrency = Math.max(1, Math.min(Number(arg("concurrency", 3)) || 3, 8));
const maxPages = Math.max(1, Number(arg("max-pages", 6)) || 6);
const recrawlDays = Number(arg("recrawl-days", 7)) || 7;
const dryRun = flag("dry-run");

if (!city) {
  console.error("--city is required, e.g. --city Austin");
  process.exit(1);
}

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : "0%");

const main = async () => {
  const recrawlCutoff = new Date(Date.now() - recrawlDays * 86_400_000);

  // Only companies with a domain: without one there is nothing to fetch, and
  // NO_WEBSITE has already been derived for them by the original run.
  const companies = await prisma.company.findMany({
    where: {
      city,
      ...(country ? { countryCode: country } : {}),
      domains: { some: {} },
      OR: [{ lastCrawledAt: null }, { lastCrawledAt: { lt: recrawlCutoff } }],
    },
    include: { domains: { take: 1 } },
    orderBy: { name: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`${companies.length} company(ies) in ${city}${country ? `, ${country}` : ""} with a domain and no crawl in the last ${recrawlDays} day(s).`);
  if (!companies.length) return;

  if (dryRun) {
    for (const c of companies) console.log(`  ${c.name.padEnd(34)} ${c.domains[0].domain}`);
    console.log("\n--dry-run: nothing fetched, nothing written.");
    return;
  }

  // Recorded as a real run so every CrawlRequest and Lead it produces is
  // attributable, and so the sweep is visible in the UI alongside the
  // discovery runs whose crawl budget ran out.
  const run = await prisma.discoveryRun.create({
    data: {
      trigger: "MANUAL",
      status: "RUNNING",
      startedAt: new Date(),
      plan: {
        mode: "ASSESS",
        note: `Crawl + score existing ${city} companies whose original run ran out of crawl budget`,
        city,
        countryCode: country,
        steps: [
          { ordinal: 1, kind: "CRAWL", label: `Crawl ${companies.length} ${city} websites` },
          { ordinal: 2, kind: "SIGNALS", label: "Evaluate signals" },
          { ordinal: 3, kind: "SCORE", label: "Score and create leads" },
        ],
      },
      steps: {
        create: [
          { ordinal: 1, kind: "CRAWL", label: `Crawl ${companies.length} ${city} websites`.slice(0, 200) },
          { ordinal: 2, kind: "SIGNALS", label: "Evaluate signals" },
          { ordinal: 3, kind: "SCORE", label: "Score and create leads" },
        ],
      },
    },
    include: { steps: { orderBy: { ordinal: "asc" } } },
  });
  const stepId = (ordinal) => run.steps.find((s) => s.ordinal === ordinal).id;
  const startStep = (o) => prisma.discoveryRunStep.update({ where: { id: stepId(o) }, data: { status: "RUNNING", startedAt: new Date() } });
  const endStep = (o, counts, status = "SUCCEEDED") =>
    prisma.discoveryRunStep.update({ where: { id: stepId(o) }, data: { status, counts, finishedAt: new Date() } });

  console.log(`run ${run.id} — crawling at concurrency ${concurrency}, ${maxPages} pages per host\n`);

  // ─── CRAWL ────────────────────────────────────────────────────────────────
  await startStep(1);
  const stats = { crawled: 0, blocked: 0, errors: 0 };
  let done = 0;
  const gate = pLimit(concurrency);
  await Promise.allSettled(companies.map((company) => gate(async () => {
    const domain = company.domains[0].domain;
    try {
      const res = await ingestWebsite({
        companyId: company.id,
        url: `https://${domain}`,
        maxPages,
        discoveryRunId: run.id,
      });
      if (res.ok) {
        stats.crawled += 1;
        console.log(`  [${++done}/${companies.length}] ok      ${company.name} (${domain}) audit=${res.auditScore ?? "-"}`);
      } else {
        stats.blocked += 1;
        console.log(`  [${++done}/${companies.length}] blocked ${company.name} (${domain}) ${res.reason || ""}`);
      }
    } catch (err) {
      stats.errors += 1;
      console.log(`  [${++done}/${companies.length}] error   ${company.name} (${domain}) ${err.message}`);
    }
  })));
  await endStep(1, stats);
  console.log(`\ncrawled ${stats.crawled}, blocked ${stats.blocked}, errors ${stats.errors}\n`);

  // ─── SIGNALS ──────────────────────────────────────────────────────────────
  await startStep(2);
  let evaluated = 0;
  for (const company of companies) {
    try {
      await evaluateCompanySignals(company.id);
      evaluated += 1;
    } catch (err) {
      console.log(`  signals failed for ${company.name}: ${err.message}`);
    }
  }
  await endStep(2, { evaluated });
  console.log(`signals evaluated for ${evaluated} company(ies)\n`);

  // ─── SCORE ────────────────────────────────────────────────────────────────
  await startStep(3);
  let created = 0;
  let skipped = 0;
  const reasons = {};
  for (const company of companies) {
    try {
      const res = await scoreCompany(company.id, { discoveryRunId: run.id });
      if (res.skipped) {
        skipped += 1;
        reasons[res.reason] = (reasons[res.reason] || 0) + 1;
      } else {
        created += 1;
      }
    } catch (err) {
      console.log(`  scoring failed for ${company.name}: ${err.message}`);
    }
  }
  await endStep(3, { leadsCreated: created, belowThreshold: skipped });

  await prisma.discoveryRun.update({
    where: { id: run.id },
    data: {
      status: stats.errors && !stats.crawled ? "FAILED" : stats.errors || stats.blocked ? "PARTIAL" : "SUCCEEDED",
      finishedAt: new Date(),
      stats: { companiesFound: companies.length, ...stats, jobsFound: 0, leadsCreated: created },
    },
  });

  console.log(`leads created/updated: ${created} (${pct(created, companies.length)} of the set)`);
  console.log(`not a lead: ${skipped}${Object.keys(reasons).length ? ` — ${Object.entries(reasons).map(([r, n]) => `${r}: ${n}`).join(", ")}` : ""}`);
  console.log(`\nrun ${run.id} finished.`);
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
