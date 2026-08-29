/**
 * Admin authentication: sign in, sign out, whoami, change password.
 *
 * Two properties this file exists to preserve:
 *   · A failed login never reveals whether the address is known. Same message,
 *     same status, and a hash is computed even for an unknown address so the
 *     response time does not answer the question either.
 *   · Repeated failures lock the account for a while. Rate limiting by IP alone
 *     is not enough — a spray from many addresses against one mailbox is the
 *     realistic attack against a single-tenant console.
 */
import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { hashPassword, passwordProblem, verifyPassword } from "../../lib/auth/password.js";
import {
  clearSessionCookie,
  createSession,
  revokeAllSessionsForUser,
  revokeSession,
} from "../../lib/auth/session.js";
import { publicUser } from "../../lib/auth/serialize.js";
import { readSessionToken } from "../../middlewares/requireAuth.js";
import { LOGIN_LOCK_MINUTES, LOGIN_MAX_ATTEMPTS } from "../../configs/envConfig.js";
import { logger } from "../../utils/logger.js";

// A digest of a value nobody can present. Verifying against it burns the same
// scrypt work as a real check, which is what keeps unknown-address responses
// indistinguishable from wrong-password ones.
const DECOY_HASH = await hashPassword(`decoy:${Math.random()}:${Date.now()}`);

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(255),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(200),
  newPassword: z.string().min(1).max(200),
});

const INVALID = "Incorrect email or password.";

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.adminUser.findUnique({ where: { email } });

  // Locked accounts are told so explicitly. Hiding it would only make a locked
  // operator retry — extending their own lockout — with no security gain, since
  // reaching a lock already proves the address exists.
  if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000));
    return res.status(429).json({
      success: false,
      message: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      code: "ACCOUNT_LOCKED",
    });
  }

  // For an unknown or deactivated account the decoy is verified and the result
  // thrown away: the work happens either way, so the timing tells an attacker
  // nothing about which addresses exist.
  let ok;
  if (user?.isActive) {
    ok = await verifyPassword(password, user.passwordHash);
  } else {
    await verifyPassword(password, DECOY_HASH);
    ok = false;
  }

  if (!ok) {
    if (user) {
      const attempts = user.failedLoginCount + 1;
      const lock = attempts >= LOGIN_MAX_ATTEMPTS;
      await prisma.adminUser.update({
        where: { id: user.id },
        data: {
          failedLoginCount: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60 * 1000) : null,
        },
      });
      logger.warn({ email, attempts, locked: lock, ip: req.ip }, "failed admin login");
    } else {
      logger.warn({ email, ip: req.ip }, "failed admin login for unknown address");
    }
    return res.status(401).json({ success: false, message: INVALID, code: "INVALID_CREDENTIALS" });
  }

  await prisma.adminUser.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  await createSession(res, req, user.id);
  logger.info({ userId: user.id, email: user.email, ip: req.ip }, "admin signed in");

  res.json({ success: true, message: "Signed in.", data: { user: publicUser(user) } });
});

export const logout = asyncHandler(async (req, res) => {
  await revokeSession(readSessionToken(req));
  clearSessionCookie(res);
  res.json({ success: true, message: "Signed out.", data: null });
});

/**
 * Whoami. The frontend calls this on boot to decide between the app and the
 * login screen, so it must stay cheap — requireAuth has already loaded the row.
 */
export const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: publicUser(req.auth.user) } });
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = req.auth.user;

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return res.status(400).json({
      success: false,
      message: "Your current password is incorrect.",
      code: "INVALID_CREDENTIALS",
      field: "currentPassword",
    });
  }

  const problem = passwordProblem(newPassword);
  if (problem) {
    return res.status(400).json({ success: false, message: problem, field: "newPassword" });
  }

  await prisma.adminUser.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  // Every existing session dies, including this one — a password change is the
  // action you take when you think a session was stolen.
  await revokeAllSessionsForUser(user.id);
  clearSessionCookie(res);
  logger.info({ userId: user.id }, "admin password changed; all sessions revoked");

  res.json({
    success: true,
    message: "Password updated. Please sign in again.",
    data: null,
  });
});
