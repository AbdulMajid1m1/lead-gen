#!/usr/bin/env node
/**
 * One-off sweep: disqualify every existing lead whose company is in a line of
 * trade this agency does not work with (lib/qualify/excludedCategories.js).
 *
 * The scoring engine now applies the same rule on every pass, so this only
 * exists to clear the backlog that entered before the rule did — and to do it
 * visibly, with a list, rather than waiting for the four-hourly re-score.
 *
 *   node scripts/sweep-excluded-categories.mjs            # dry run: list only
 *   node scripts/sweep-excluded-categories.mjs --apply    # disqualify + close threads
 *
 * Leads a human has already dispositioned (CONVERTED, NOT_INTERESTED,
 * DO_NOT_CONTACT, DISQUALIFIED) are listed but left alone.
 */
import prisma from "../prismaClient.js";
import { classifyCompanyExclusion, exclusionNote } from "../lib/qualify/excludedCategories.js";
import { setStatus } from "../lib/scoring/scoreEngine.js";

const apply = process.argv.includes("--apply");
const LEAVE_ALONE = new Set(["CONVERTED", "NOT_INTERESTED", "DO_NOT_CONTACT", "DISQUALIFIED"]);

const companies = await prisma.company.findMany({
  select: {
    id: true, name: true, industry: true, osmCategory: true, description: true, city: true, countryCode: true,
    leads: { select: { id: true, status: true, score: true, threads: { where: { status: { in: ["AWAITING_REPLY", "REPLIED"] } }, select: { id: true, status: true, channel: true } } } },
  },
});

const rows = [];
for (const company of companies) {
  const hit = classifyCompanyExclusion(company);
  if (!hit) continue;
  rows.push({ company, hit, lead: company.leads[0] || null });
}

const withLead = rows.filter((r) => r.lead);
console.log(`Companies in an excluded trade: ${rows.length} (${withLead.length} with a lead)\n`);
console.log(["category", "matched", "source", "lead status", "score", "company", "city"].join(" | "));
for (const r of rows.sort((a, b) => (b.lead?.score ?? -1) - (a.lead?.score ?? -1))) {
  console.log([r.hit.category, r.hit.matched, r.hit.source, r.lead?.status ?? "-", r.lead?.score ?? "-", r.company.name, `${r.company.city ?? ""}/${r.company.countryCode ?? ""}`].join(" | "));
}

if (!apply) {
  console.log("\nDry run — nothing changed. Re-run with --apply to disqualify.");
  await prisma.$disconnect();
  process.exit(0);
}

let disqualified = 0;
let threadsClosed = 0;
let skipped = 0;
for (const r of withLead) {
  if (LEAVE_ALONE.has(r.lead.status)) { skipped += 1; continue; }
  await setStatus(r.lead.id, "DISQUALIFIED", exclusionNote(r.hit));
  disqualified += 1;
  for (const t of r.lead.threads) {
    // No follow-up may chase a business we have decided not to work with.
    await prisma.outreachThread.update({ where: { id: t.id }, data: { status: "CLOSED", nextFollowUpAt: null } });
    threadsClosed += 1;
  }
}
console.log(`\nDisqualified ${disqualified} lead(s), closed ${threadsClosed} open thread(s), left ${skipped} human-dispositioned lead(s) alone.`);
await prisma.$disconnect();
