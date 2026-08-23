/**
 * One-off repair: retry website resolution for every lead-bearing company that
 * has no known domain. The old resolver rejected real websites because it
 * compared homepages against job-posting locations; this re-runs them all
 * under the fixed rules. Safe to re-run any time.
 *
 *   node scripts/repair-domains.mjs [limit]
 */
import prisma from "../prismaClient.js";
import { resolveCompanyDomain } from "../lib/ingest/domainResolver.js";

const limit = Number(process.argv[2]) || 200;

const companies = await prisma.company.findMany({
  where: { domains: { none: {} }, leads: { some: {} } },
  orderBy: { lastSeenAt: "desc" },
  take: limit,
  select: { id: true, name: true },
});

console.log(`Retrying domain resolution for ${companies.length} companies…`);
let found = 0;
for (const [i, company] of companies.entries()) {
  try {
    const res = await resolveCompanyDomain(company.id, { maxCandidates: 3 });
    if (res.found) {
      found += 1;
      console.log(`  [${i + 1}/${companies.length}] ${company.name} → ${res.domain}`);
    }
  } catch (err) {
    console.log(`  [${i + 1}/${companies.length}] ${company.name} — error: ${err.message}`);
  }
}
console.log(`Done. Resolved ${found}/${companies.length}.`);
await prisma.$disconnect();
process.exit(0);
