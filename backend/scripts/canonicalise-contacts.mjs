/**
 * Second-pass contact canonicalisation.
 *
 * The 20260827180000_canonical_contacts migration does the mechanical half in
 * SQL - punctuation and casing. This does the half that needs the calling-code
 * table: promoting a nationally-written number ("030 78001738" on a German
 * company) to E.164, and dropping a trunk zero written after a country code
 * ("+49 (0)30 ..."). Both produce rows the SQL pass leaves as distinct strings.
 *
 * Safe to run repeatedly - it is a convergence, not a transformation. Run with
 * DRY=1 first to see what it would do.
 *
 *   node scripts/canonicalise-contacts.mjs          # apply
 *   DRY=1 node scripts/canonicalise-contacts.mjs    # report only
 */
import prisma from "../prismaClient.js";
import { canonicalPhone, canonicalEmail } from "../lib/outreach/phoneRank.js";

const DRY = process.env.DRY === "1";

const CONFIDENCE_ORDER = { VERIFIED: 0, DETECTED: 1, INFERRED: 2, AI_GENERATED: 3 };

/** Same survivor rule as the migration, so the two passes cannot disagree. */
const bestOf = (rows) =>
  [...rows].sort((a, b) =>
    (CONFIDENCE_ORDER[a.confidenceLevel] ?? 9) - (CONFIDENCE_ORDER[b.confidenceLevel] ?? 9)
    || (a.verifiedAt ? 0 : 1) - (b.verifiedAt ? 0 : 1)
    || new Date(a.createdAt) - new Date(b.createdAt)
    || a.id.localeCompare(b.id),
  )[0];

const run = async () => {
  const companies = await prisma.company.findMany({
    where: { contacts: { some: { kind: { in: ["EMAIL", "PHONE"] } } } },
    select: { id: true, countryCode: true, contacts: { where: { kind: { in: ["EMAIL", "PHONE"] } } } },
  });

  let rewritten = 0;
  let merged = 0;
  let suppressionsCarried = 0;

  for (const company of companies) {
    // Group by what the value *should* be, per kind.
    const groups = new Map();
    for (const c of company.contacts) {
      const canonical = c.kind === "EMAIL"
        ? canonicalEmail(c.value)
        : canonicalPhone(c.value, company.countryCode);
      const key = `${c.kind} ${canonical}`;
      if (!groups.has(key)) groups.set(key, { kind: c.kind, canonical, rows: [] });
      groups.get(key).rows.push(c);
    }

    for (const { canonical, rows } of groups.values()) {
      if (rows.length === 1 && rows[0].value === canonical) continue;

      const keep = bestOf(rows);
      const drop = rows.filter((r) => r.id !== keep.id);
      // A suppression on any spelling has to survive onto the survivor, or a
      // contact someone asked us never to use comes back to life.
      const suppressed = rows.some((r) => r.isSuppressed);
      if (suppressed && !keep.isSuppressed) suppressionsCarried += 1;

      if (DRY) {
        if (drop.length) {
          console.log(`  merge ${rows.map((r) => JSON.stringify(r.value)).join(" + ")} -> ${JSON.stringify(canonical)}`);
        } else if (keep.value !== canonical) {
          console.log(`  rewrite ${JSON.stringify(keep.value)} -> ${JSON.stringify(canonical)}`);
        }
        rewritten += keep.value !== canonical ? 1 : 0;
        merged += drop.length;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        if (drop.length) {
          const dropIds = drop.map((r) => r.id);
          // `verifiedContactId` carries no foreign key, so a dangling id would
          // fail silently rather than loudly. Re-point it before deleting.
          await tx.aiClaim.updateMany({
            where: { verifiedContactId: { in: dropIds } },
            data: { verifiedContactId: keep.id },
          });
          await tx.contact.deleteMany({ where: { id: { in: dropIds } } });
        }
        if (keep.value !== canonical || (suppressed && !keep.isSuppressed)) {
          await tx.contact.update({
            where: { id: keep.id },
            data: { value: canonical, ...(suppressed ? { isSuppressed: true } : {}) },
          });
        }
      });
      rewritten += keep.value !== canonical ? 1 : 0;
      merged += drop.length;
    }
  }

  console.log(
    `${DRY ? "[dry run] would rewrite" : "rewrote"} ${rewritten} contact value(s), ` +
    `${DRY ? "would merge" : "merged"} ${merged} duplicate(s), ` +
    `carrying ${suppressionsCarried} suppression(s) onto the survivor.`,
  );
};

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
