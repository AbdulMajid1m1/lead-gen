import prisma from "../prismaClient.js";
import {
  renderSignatureText, renderSignatureWhatsApp,
} from "../lib/outreach/signature.js";

/**
 * The starting sign-off.
 *
 * Idempotent and upsert-by-name, so re-running never creates a duplicate and
 * never clobbers edits made in Settings beyond the fields listed here. Run it
 * with `npm run seed:signatures`.
 */

const SIGNATURES = [
  {
    name: "Abdul Majid — CTO",
    fullName: "Abdul Majid",
    title: "CTO",
    website: "deventiatech.com",
    isDefault: true,
  },
];

const run = async () => {
  for (const { isDefault, ...fields } of SIGNATURES) {
    const saved = await prisma.signature.upsert({
      where: { name: fields.name },
      create: { ...fields, isDefault: Boolean(isDefault) },
      update: fields,
    });

    if (isDefault) {
      await prisma.signature.updateMany({ where: { id: { not: saved.id } }, data: { isDefault: false } });
      await prisma.signature.update({ where: { id: saved.id }, data: { isDefault: true } });
    }

    console.log(`\n✅ ${saved.name}${isDefault ? "  (default)" : ""}\n`);
    console.log("── Email (plain-text part) ─────────────────");
    console.log(renderSignatureText(saved));
    console.log("\n── WhatsApp ────────────────────────────────");
    console.log(renderSignatureWhatsApp(saved));
    console.log("────────────────────────────────────────────");
  }
};

run()
  .catch((err) => {
    console.error("Signature seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
