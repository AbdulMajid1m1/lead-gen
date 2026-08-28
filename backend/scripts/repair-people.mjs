/**
 * Re-check stored people against the current name test, and delete the ones
 * that were never people.
 *
 * The extractor's name test used to be a blocklist anchored to the first word,
 * so any two capitalised words on a page became a contact. Live crawls wrote
 * "Performing Arts", "REGISTRATION FEES" and "Affordable Fee" to CompanyPerson,
 * and the composer greeted one of them by name in a real outreach email. The
 * test has been tightened, but a tightened test only governs the next crawl —
 * the rows already written stay until something removes them, and they still
 * feed greetings, the NAMED_CONTACT_FOUND signal and the people list in the UI.
 *
 * Deletion is safe here: nothing references CompanyPerson as a child, and a
 * name that is genuinely a person will simply be re-extracted on the next crawl
 * of that site. Titles are re-checked too — a row whose title was body copy
 * keeps the name and loses the title rather than being deleted, because the
 * name may still be real.
 *
 * Usage:
 *   node scripts/repair-people.mjs --dry-run     # report only, change nothing
 *   node scripts/repair-people.mjs               # apply
 *   node scripts/repair-people.mjs --limit 50    # sample while checking output
 */
import prisma from "../prismaClient.js";
import { __testables } from "../lib/extract/people.js";

const { looksLikePersonName, cleanTitle } = __testables;

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const main = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const limit = Number(arg("limit", 0)) || undefined;

  const people = await prisma.companyPerson.findMany({
    take: limit,
    orderBy: { id: "asc" },
    include: { company: { select: { name: true } } },
  });

  const doomed = [];
  const detitled = [];
  for (const p of people) {
    if (!looksLikePersonName(p.fullName)) { doomed.push(p); continue; }
    if (p.title && !cleanTitle(p.title)) detitled.push(p);
  }

  console.log(`people rows      : ${people.length}`);
  console.log(`not people       : ${doomed.length}`);
  console.log(`title was prose  : ${detitled.length}`);
  console.log("");

  if (doomed.length) {
    console.log("would delete (first 30):");
    for (const p of doomed.slice(0, 30)) {
      console.log(`  ${(p.fullName || "").slice(0, 34).padEnd(34)} | ${(p.company?.name || "").slice(0, 28)}`);
    }
    if (doomed.length > 30) console.log(`  … and ${doomed.length - 30} more`);
    console.log("");
  }

  if (dryRun) {
    console.log("dry run — nothing changed");
    return;
  }

  if (doomed.length) {
    const { count } = await prisma.companyPerson.deleteMany({ where: { id: { in: doomed.map((p) => p.id) } } });
    console.log(`deleted ${count} rows that were not people`);
  }
  for (const p of detitled) {
    await prisma.companyPerson.update({ where: { id: p.id }, data: { title: null } });
  }
  if (detitled.length) console.log(`cleared ${detitled.length} prose titles, keeping the names`);

  const left = await prisma.companyPerson.count();
  console.log(`people remaining : ${left}`);
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
