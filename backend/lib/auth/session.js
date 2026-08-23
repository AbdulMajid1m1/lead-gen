/**
 * Session issuing, lookup and revocation.
 *
 * The cookie carries 32 random bytes and nothing else. All state — who it
 * belongs to, when it expires, whether it was revoked — lives in AdminSession,
 * so signing out actually ends the session rather than asking the client to
 * forget a token that would otherwise still validate.
 *
 * Only the SHA-256 of the token is stored. Read access to the database (a
 * backup, a dump, a curious support query) therefore does not yield a usable
 * cookie.
 */
import { createHash, randomBytes } from "node:crypto";
import prisma from "../../prismaClient.js";
import { NODE_ENV, SESSION_COOKIE_NAME, SESSION_TTL_HOURS } from "../../configs/envConfig.js";

const TOKEN_BYTES = 32;

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** Best-effort client IP. `trust proxy` is set, so req.ip already unwraps XFF. */
const clientIp = (req) => (req.ip || req.socket?.remoteAddress || "").slice(0, 64) || null;

/**
 * Issue a session and set its cookie.
 *
 * The cookie is httpOnly (so a stored-XSS cannot read it), sameSite=lax (so a
 * cross-site form post cannot ride it, while a normal top-level navigation back
 * into the app still arrives signed in) and secure outside development.
 */
export const createSession = async (res, req, userId) => {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: (req.get("user-agent") || "").slice(0, 400) || null,
      ip: clientIp(req),
    },
  });

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });

  return { token, expiresAt };
};

/**
 * Resolve a raw cookie value to its live session and user.
 *
 * Returns null for missing, unknown, expired or revoked tokens, and for a
 * deactivated account — the caller only ever has to check for null.
 */
export const resolveSession = async (token) => {
  if (!token || typeof token !== "string") return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user?.isActive) return null;

  return session;
};

/**
 * Refresh lastSeenAt, but at most once every few minutes.
 *
 * Without the guard every authenticated request — including the dashboard's
 * polling and each SSE reconnect — would issue a write, turning a read-heavy
 * console into a write-heavy one for no operational gain.
 */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
export const touchSession = async (session) => {
  if (Date.now() - session.lastSeenAt.getTime() < TOUCH_INTERVAL_MS) return;
  await prisma.adminSession
    .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {});
};

export const revokeSession = async (token) => {
  if (!token) return;
  await prisma.adminSession
    .updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => {});
};

/** Used after a password change: every other device must re-authenticate. */
export const revokeAllSessionsForUser = async (userId) => {
  await prisma.adminSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

export const clearSessionCookie = (res) => {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
};

/**
 * Delete sessions that expired or were revoked more than a day ago. Called from
 * the worker's nightly maintenance so the table does not grow without bound.
 */
export const pruneSessions = async () => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { count } = await prisma.adminSession.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
};
