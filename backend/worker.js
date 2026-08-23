process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

import http from "node:http";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import prisma from "./prismaClient.js";
import { ingestAtsBoard } from "./lib/ingest/atsIngest.js";
import { ingestWebsite } from "./lib/ingest/websiteIngest.js";
import { verifyJobByUrl, jobsDueForVerification } from "./lib/jobs/jobStatusEngine.js";
import { lookupDomain } from "./lib/adapters/crtsh.js";
import { recordFact } from "./lib/provenance/recorder.js";
import { evaluateCompanySignals } from "./lib/signals/signalEngine.js";
import { scoreCompany } from "./lib/scoring/scoreEngine.js";
import { runOutreachMaintenance } from "./lib/outreach/service.js";
import { resolveCompanyDomain } from "./lib/ingest/domainResolver.js";
import { REDIS_URL, WORKER_HEALTH_PORT } from "./configs/envConfig.js";
import { logger } from "./utils/logger.js";

/**
 * Background maintenance.
 *
 * Discovery runs are executed in-process by the API (a user is watching them),
 * so this worker owns the *scheduled* work — the jobs whose whole purpose is to
 * keep stored data honest over time:
 *
 *   · re-fetch job boards so ACTIVE really means active
 *   · verify aggregator postings that no board can confirm
 *   · re-audit websites that have gone stale
 *   · re-score everything so freshness decay is reflected in the rankings
 *   · prune raw payloads past the retention window
 */

const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

const QUEUE_NAME = "leadsignal-maintenance";
const queue = new Queue(QUEUE_NAME, { connection });

const REPEATABLE = [
  { name: "verify-ats-boards", pattern: "0 */6 * * *" },   // every 6 hours
  { name: "verify-loose-jobs", pattern: "30 3 * * *" },    // nightly
  { name: "reaudit-websites", pattern: "0 4 * * *" },      // nightly
  { name: "rescore-leads", pattern: "0 */4 * * *" },       // every 4 hours
  { name: "enrich-domain-age", pattern: "15 2 * * *" },    // nightly, best-effort
  { name: "prune-payloads", pattern: "0 5 * * 0" },        // weekly
  { name: "outreach-maintenance", pattern: "*/30 * * * *" }, // replies + follow-ups
  { name: "resolve-missing-domains", pattern: "45 1 * * *" }, // nightly repair
];

const handlers = {
  /**
   * Pull replies for open outreach threads, then send any follow-up that has
   * come due. No-op until a mailbox is connected in Settings.
   */
  "outreach-maintenance": async () => runOutreachMaintenance(),

  /**
   * Companies with leads but no known website get another resolution attempt.
   * Prioritises the ones a user is most likely to be looking at.
   */
  "resolve-missing-domains": async () => {
    const companies = await prisma.company.findMany({
      where: { domains: { none: {} }, leads: { some: {} } },
      orderBy: { lastSeenAt: "desc" },
      take: 40,
      select: { id: true, name: true },
    });
    let resolved = 0;
    for (const company of companies) {
      try {
        const res = await resolveCompanyDomain(company.id, { maxCandidates: 3 });
        if (res?.found) resolved += 1;
      } catch (err) {
        logger.debug({ company: company.name, msg: err.message }, "domain retry failed");
      }
    }
    return { candidates: companies.length, resolved };
  },
  /**
   * The heart of job freshness: re-fetch each known board. One request
   * re-verifies every job that company has, and reconcileBoardJobs downgrades
   * anything that has quietly disappeared.
   */
  "verify-ats-boards": async () => {
    const accounts = await prisma.atsAccount.findMany({
      where: { isActive: true },
      orderBy: { lastFetchedAt: "asc" },
      take: 40,
    });
    let refreshed = 0;
    for (const account of accounts) {
      try {
        const res = await ingestAtsBoard({ provider: account.provider, slug: account.slug, companyId: account.companyId });
        if (res.ok) {
          refreshed += 1;
        } else {
          const fails = account.consecutiveFails + 1;
          await prisma.atsAccount.update({
            where: { id: account.id },
            data: { consecutiveFails: fails, isActive: fails < 5, lastFetchedAt: new Date() },
          });
        }
      } catch (err) {
        logger.warn({ slug: account.slug, msg: err.message }, "board re-verification failed");
      }
    }
    return { boards: accounts.length, refreshed };
  },

  /** Aggregator postings with no board to confirm them get a single URL check. */
  "verify-loose-jobs": async () => {
    const due = await jobsDueForVerification(60);
    const loose = due.filter((j) => j.url);
    let checked = 0;
    for (const job of loose.slice(0, 40)) {
      try {
        await verifyJobByUrl(job.id);
        checked += 1;
      } catch (err) {
        logger.debug({ jobId: job.id, msg: err.message }, "job URL verification failed");
      }
    }
    return { due: due.length, checked };
  },

  /** A 60-day-old audit is no longer evidence of anything current. */
  "reaudit-websites": async () => {
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    const companies = await prisma.company.findMany({
      where: {
        domains: { some: {} },
        OR: [{ lastCrawledAt: null }, { lastCrawledAt: { lt: cutoff } }],
        leads: { some: { status: { notIn: ["DO_NOT_CONTACT", "ARCHIVED", "DISQUALIFIED"] } } },
      },
      include: { domains: { take: 1 } },
      orderBy: { lastCrawledAt: "asc" },
      take: 25,
    });
    let audited = 0;
    for (const company of companies) {
      try {
        const res = await ingestWebsite({ companyId: company.id, url: `https://${company.domains[0].domain}`, maxPages: 4 });
        if (res.ok) audited += 1;
      } catch (err) {
        logger.debug({ company: company.name, msg: err.message }, "re-audit failed");
      }
    }
    return { considered: companies.length, audited };
  },

  /**
   * Re-score so decay is actually reflected. Without this a lead scored during
   * a hiring spike would keep that score forever, which is exactly the staleness
   * this product exists to avoid.
   */
  "rescore-leads": async () => {
    const companies = await prisma.company.findMany({
      where: { leads: { some: {} } },
      select: { id: true },
      take: 500,
    });
    let rescored = 0;
    for (const { id } of companies) {
      try {
        await evaluateCompanySignals(id);
        await scoreCompany(id);
        rescored += 1;
      } catch (err) {
        logger.debug({ companyId: id, msg: err.message }, "rescore failed");
      }
    }
    return { rescored };
  },

  /**
   * Date each domain from certificate-transparency logs, which is what powers
   * the NEW_DOMAIN and NEW_SUBDOMAIN signals. Best-effort by design: crt.sh is
   * a free community service and is often unavailable, so a failure here simply
   * leaves the domain undated rather than degrading anything else.
   */
  "enrich-domain-age": async () => {
    const domains = await prisma.companyDomain.findMany({
      where: { firstCertSeenAt: null },
      orderBy: { id: "asc" },
      take: 25,
    });

    let dated = 0;
    let newSubdomains = 0;
    let unavailable = 0;

    for (const domain of domains) {
      const res = await lookupDomain(domain.domain, { timeoutMs: 30_000 });
      if (!res.ok) {
        unavailable += 1;
        continue;
      }
      if (res.firstSeen) {
        await prisma.companyDomain.update({ where: { id: domain.id }, data: { firstCertSeenAt: res.firstSeen } });
        dated += 1;
      }

      // A shop./booking./app. host that appeared recently is a company standing
      // up new capability — recorded as a fact so the signal engine can use it.
      const cutoff = Date.now() - 60 * 86_400_000;
      for (const sub of res.subdomains.filter((s) => s.firstSeen.getTime() > cutoff).slice(0, 5)) {
        await recordFact({
          companyId: domain.companyId,
          key: `new_subdomain:${sub.host}`,
          value: sub.host,
          valueJson: { host: sub.host, label: sub.label, firstSeen: sub.firstSeen.toISOString() },
          confidenceLevel: "VERIFIED",
          extractorName: "crtsh",
          evidenceSnippet: `Certificate transparency logs show ${sub.host} first appeared on ${sub.firstSeen.toISOString().slice(0, 10)}.`,
        });
        newSubdomains += 1;
      }

      if (res.firstSeen || newSubdomains) {
        await evaluateCompanySignals(domain.companyId).catch(() => {});
        await scoreCompany(domain.companyId).catch(() => {});
      }
    }

    return { considered: domains.length, dated, newSubdomains, unavailable };
  },

  /**
   * Retention: raw payloads are dropped after 90 days. The derived facts keep
   * their hash and fetch timestamp, so provenance survives the prune.
   */
  "prune-payloads": async () => {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const stale = await prisma.sourceRecord.findMany({
      where: { fetchedAt: { lt: cutoff }, NOT: { payload: { equals: { pruned: true } } } },
      select: { id: true },
      take: 5000,
    });
    for (const { id } of stale) {
      await prisma.sourceRecord.update({ where: { id }, data: { payload: { pruned: true, prunedAt: new Date().toISOString() } } });
    }
    return { pruned: stale.length };
  },
};

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const handler = handlers[job.name];
    if (!handler) throw new Error(`No handler for job ${job.name}`);
    const startedAt = Date.now();
    const result = await handler(job);
    logger.info({ job: job.name, ms: Date.now() - startedAt, ...result }, "maintenance job complete");
    return result;
  },
  { connection, concurrency: 1 }, // maintenance touches third-party services; one at a time
);

worker.on("failed", (job, err) => logger.error({ job: job?.name, err }, "maintenance job failed"));

const registerSchedules = async () => {
  // Clear previously-registered schedulers so a changed cron takes effect.
  for (const existing of await queue.getJobSchedulers()) {
    await queue.removeJobScheduler(existing.key);
  }
  for (const { name, pattern } of REPEATABLE) {
    await queue.upsertJobScheduler(name, { pattern }, { name });
  }
  logger.info({ jobs: REPEATABLE.map((r) => r.name) }, "maintenance schedules registered");
};

// Minimal health endpoint so the container has something to probe.
const healthServer = http.createServer(async (req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    await connection.ping();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { worker: "up", redis: "up", database: "up" } }));
  } catch (err) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: false, message: err.message }));
  }
});

registerSchedules()
  .then(() => {
    healthServer.listen(WORKER_HEALTH_PORT, () => {
      logger.info({ port: WORKER_HEALTH_PORT }, "LeadSignal worker running");
    });
  })
  .catch((err) => {
    logger.error({ err }, "worker failed to start");
    process.exit(1);
  });

const shutdown = async () => {
  await worker.close();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
  healthServer.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { handlers, queue };
