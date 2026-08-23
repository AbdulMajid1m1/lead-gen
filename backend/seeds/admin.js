/**
 * Provision the admin account from the environment.
 *
 * Called once on API boot and also runnable by hand (`npm run seed:admin`).
 * Idempotent, and deliberately conservative about an account that already
 * exists: the .env is the *initial* credential, not a source of truth that
 * overwrites a password the operator has since changed in the UI. Set
 * ADMIN_PASSWORD_RESET=true for the "I am locked out, force it back" case.
 */
import prisma from "../prismaClient.js";
import { hashPassword, passwordProblem } from "../lib/auth/password.js";
import { revokeAllSessionsForUser } from "../lib/auth/session.js";
import {
  ADMIN_EMAIL,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  ADMIN_PASSWORD_RESET,
  NODE_ENV,
} from "../configs/envConfig.js";
import { logger } from "../utils/logger.js";

export const ensureAdminUser = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    // envConfig already refuses to boot without these in production, so this
    // only ever fires in a local checkout that has not filled its .env in.
    logger.warn("ADMIN_EMAIL/ADMIN_PASSWORD are unset — no admin account provisioned.");
    return null;
  }

  const problem = passwordProblem(ADMIN_PASSWORD);
  if (problem) {
    if (NODE_ENV === "production") {
      throw new Error(`[seeds/admin] ADMIN_PASSWORD is too weak: ${problem}`);
    }
    logger.warn({ problem }, "ADMIN_PASSWORD is weak; allowed outside production only.");
  }

  const existing = await prisma.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });

  if (!existing) {
    const user = await prisma.adminUser.create({
      data: {
        email: ADMIN_EMAIL,
        name: ADMIN_NAME,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        role: "ADMIN",
      },
    });
    logger.info({ email: user.email }, "admin account provisioned from environment");
    return user;
  }

  if (ADMIN_PASSWORD_RESET) {
    const user = await prisma.adminUser.update({
      where: { id: existing.id },
      data: {
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        name: ADMIN_NAME,
        isActive: true,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    // A forced reset is a recovery action; anything already signed in should
    // not survive it.
    await revokeAllSessionsForUser(user.id);
    logger.warn({ email: user.email }, "admin password reset from environment (ADMIN_PASSWORD_RESET)");
    return user;
  }

  // Re-activate and unlock, but leave the password alone. This is what makes a
  // restart a usable remedy for a locked-out operator without it silently
  // undoing a password they deliberately changed.
  if (!existing.isActive || existing.lockedUntil) {
    const user = await prisma.adminUser.update({
      where: { id: existing.id },
      data: { isActive: true, failedLoginCount: 0, lockedUntil: null },
    });
    logger.info({ email: user.email }, "admin account re-activated and unlocked on boot");
    return user;
  }

  return existing;
};

// Allow `node seeds/admin.js` as well as an import from index.js.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureAdminUser()
    .then((user) => {
      console.log(user ? `Admin ready: ${user.email}` : "No admin provisioned.");
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
