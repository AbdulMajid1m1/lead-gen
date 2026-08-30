/**
 * One-off repair for two ways a company acquired facts that were never its own.
 *
 *  1. A namesake's job board. The ATS probe accepted the first slug that
 *     existed, so a Berlin beer hall was linked to a US fintech's Greenhouse
 *     board and scored to the top of the list as "hiring ML engineers in
 *     Seattle". `boardFitsCompany` now stops that at ingest; this applies the
 *     same test to every board already linked, using the job locations
 *     already stored — no refetch needed.
 *
 *  2. A store that is not a store. The WooCommerce fingerprint fired on the
 *     plugin's stylesheet, which every WordPress theme that bundles WooCommerce
 *     ships whether or not there is a shop. The fixed fingerprint needs product
 *     or cart markup; this re-fetches each flagged home page once and re-runs
 *     detection under the fixed rules.
 *
 * Every company touched has its signals re-evaluated (a hiring signal whose
 * jobs are now closed is deactivated by the ordinary reconciliation) and is
 * rescored. Drafts are not rewritten here — run the draft regeneration after.
 *
 * Dry run by default; nothing is written without --apply. Safe to re-run.
 *
 *   node scripts/repair-ats-boards.mjs [--apply] [--skip-woo] [--skip-ats]
 */
import prisma from "../prismaClient.js";
import { boardFitsCompany } from "../lib/ingest/atsIngest.js";
import { evaluateCompanySignals } from "../lib/signals/signalEngine.js";
import { scoreCompany } from "../lib/scoring/scoreEngine.js";
import { recordFact } from "../lib/provenance/recorder.js";
import { fetchPage } from "../lib/crawler/fetchPage.js";
import { detectTechnologies } from "../lib/analyze/techDetect.js";

const apply = process.argv.includes("--apply");
const skipWoo = process.argv.includes("--skip-woo");
const skipAts = process.argv.includes("--skip-ats");
const touched = new Set();
const summary = { atsChecked: 0, atsMismatched: 0, jobsClosed: 0, wooChecked: 0, wooFalse: 0, wooUnreachable: 0, rescored: 0 };

// ─── 1. Namesake boards ───────────────────────────────────────────────────────
if (!skipAts) {
  const accounts = await prisma.atsAccount.findMany({
    where: { isActive: true },
    include: { company: { select: { id: true, name: true, countryCode: true, city: true } } },
  });
  for (const account of accounts) {
    summary.atsChecked += 1;
    // Only this board's own jobs are evidence for or against it: an
    // aggregator posting for the same company is a different source.
    const jobs = await prisma.jobPosting.findMany({
      where: { companyId: account.companyId, status: { in: ["ACTIVE", "RECENTLY_ACTIVE", "UNKNOWN"] }, source: { kind: account.provider } },
      select: { id: true, location: true, remote: true },
    });
    const fit = boardFitsCompany({ slug: account.slug, jobs }, account.company);
    if (fit.ok) continue;

    summary.atsMismatched += 1;
    console.log(`ATS  ✗ ${account.company.name} (${account.company.countryCode}) ← ${account.provider}:${account.slug} — ${fit.reason}`);
    if (!apply) continue;

    await prisma.atsAccount.update({ where: { id: account.id }, data: { isActive: false } });
    const closed = await prisma.jobPosting.updateMany({
      where: { id: { in: jobs.map((j) => j.id) } },
      data: {
        status: "CLOSED", disappearedAt: new Date(),
        statusEvidence: { reason: "ATS_BOARD_MISMATCH", detail: fit.reason.slice(0, 300), repairedAt: new Date().toISOString() },
      },
    });
    summary.jobsClosed += closed.count;
    await recordFact({
      companyId: account.companyId, key: "ats_board_rejected", value: `${account.provider}:${account.slug}`,
      confidenceLevel: "VERIFIED", extractorName: "repair-ats-boards", evidenceSnippet: fit.reason.slice(0, 500),
    });
    touched.add(account.companyId);
  }
}

// ─── 2. Stores that are not stores ───────────────────────────────────────────
if (!skipWoo) {
  const rows = await prisma.technologyDetection.findMany({
    where: { techName: "WooCommerce" },
    include: { company: { select: { id: true, name: true, domains: { select: { domain: true, isPrimary: true } } } } },
  });
  for (const row of rows) {
    const domain = row.company.domains.find((d) => d.isPrimary)?.domain || row.company.domains[0]?.domain;
    if (!domain) continue;
    summary.wooChecked += 1;
    const page = await fetchPage(`https://${domain}/`);
    if (!page.ok || !page.body) {
      summary.wooUnreachable += 1;
      console.log(`WOO  ? ${row.company.name} — ${domain} unreachable (${page.blockReason || page.status || "no body"}), left as is`);
      continue;
    }
    const { technologies } = detectTechnologies({ html: page.body, headers: page.headers || {}, url: page.finalUrl });
    if (technologies.some((t) => t.name === "WooCommerce")) continue;

    summary.wooFalse += 1;
    console.log(`WOO  ✗ ${row.company.name} — ${domain} has the plugin but no shop markup`);
    if (!apply) continue;
    await prisma.technologyDetection.delete({ where: { id: row.id } });
    touched.add(row.companyId);
  }
}

// ─── 3. Re-evaluate and rescore what changed ─────────────────────────────────
if (apply) {
  for (const companyId of touched) {
    await evaluateCompanySignals(companyId);
    await scoreCompany(companyId);
    summary.rescored += 1;
  }
}

console.log(`${apply ? "APPLIED" : "DRY RUN"} ${JSON.stringify(summary)}`);
await prisma.$disconnect();
process.exit(0);
