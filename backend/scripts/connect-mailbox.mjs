/**
 * Connect the outreach sending mailbox from environment variables.
 *
 * The Settings UI is the normal way to add a mailbox, but it cannot reach the
 * production database — so provisioning the same row on the server meant
 * hand-writing it, which is how a mailbox ends up live with no warm-up date and
 * no verified credentials. This does what the UI does, from env, on either side.
 *
 * Usage (inside the api container in production):
 *   node scripts/connect-mailbox.mjs            # create or update, then verify
 *   node scripts/connect-mailbox.mjs --dry-run  # verify credentials, write nothing
 *
 * Idempotent: re-running updates hosts and credentials in place. `warmupStartedAt`
 * is written only when the row is first created — re-running must never restart
 * a ramp that is already part-way through, or a mailbox could be held at 5/day
 * forever by a careless second run.
 */
import "dotenv/config";
import prisma from "../prismaClient.js";
import { verifySmtp } from "../lib/outreach/mailer.js";
import { verifyImap } from "../lib/outreach/inbox.js";

const dryRun = process.argv.includes("--dry-run");

const required = (key) => {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key}. Set it in backend.env (production) or backend/.env (local).`);
    process.exit(1);
  }
  return value;
};

const email = required("MAILBOX_EMAIL").toLowerCase();
const appPassword = required("MAILBOX_APP_PASSWORD").replace(/\s+/g, "");

const config = {
  provider: "SMTP",
  email,
  displayName: process.env.MAILBOX_DISPLAY_NAME?.trim() || null,
  smtpHost: process.env.MAILBOX_SMTP_HOST?.trim() || "smtp.zoho.com",
  smtpPort: Number(process.env.MAILBOX_SMTP_PORT) || 465,
  // Zoho's SMTP login is the address itself, so no separate user is stored.
  smtpUser: null,
  authPassword: appPassword,
  imapHost: process.env.MAILBOX_IMAP_HOST?.trim() || "imap.zoho.com",
  imapPort: Number(process.env.MAILBOX_IMAP_PORT) || 993,
  imapUser: null,
  // Replies arrive in the same mailbox we send from, so IMAP reuses the password.
  imapPassword: appPassword,
};

const run = async () => {
  console.log(`Mailbox   ${config.email}`);
  console.log(`SMTP      ${config.smtpHost}:${config.smtpPort}`);
  console.log(`IMAP      ${config.imapHost}:${config.imapPort}`);
  console.log("");

  // Verify before writing: a mailbox that cannot authenticate is worse than no
  // mailbox, because the scheduler will keep handing it work.
  const [smtp, imap] = await Promise.all([verifySmtp(config), verifyImap(config)]);
  console.log(`SMTP      ${smtp.ok ? "OK" : `FAILED — ${smtp.error}`}`);
  console.log(`IMAP      ${imap.ok ? "OK" : `FAILED — ${imap.error}`}`);
  if (!smtp.ok || !imap.ok) {
    console.error("\nCredentials did not verify — nothing written.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n--dry-run: verified, nothing written.");
    return;
  }

  const existing = await prisma.emailAccount.findUnique({ where: { email: config.email } });
  const account = existing
    ? await prisma.emailAccount.update({ where: { id: existing.id }, data: config })
    : await prisma.emailAccount.create({
        data: { ...config, warmupStartedAt: new Date() },
      });

  await prisma.emailAccount.updateMany({
    where: { id: { not: account.id } },
    data: { isDefault: false },
  });
  const saved = await prisma.emailAccount.update({
    where: { id: account.id },
    data: { isDefault: true, status: "CONNECTED", lastError: null },
  });

  const ramp = saved.warmupStartedAt
    ? `warm-up started ${saved.warmupStartedAt.toISOString().slice(0, 10)}`
    : "no warm-up date — this mailbox will open at the full daily cap";
  console.log(`\n${existing ? "Updated" : "Connected"} ${saved.email} — default sender, ${ramp}.`);
};

run()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
