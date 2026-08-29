/**
 * Authentication middleware.
 *
 * Reads the session cookie directly off the request rather than pulling in
 * cookie-parser: this API sets exactly one cookie and reads exactly one, and a
 * dependency whose whole job is `String.split` is not worth the supply chain.
 */
import { resolveSession, touchSession } from "../lib/auth/session.js";
import { canManageUsers, hasAnyPermission, isReadOnly } from "../lib/auth/permissions.js";
import { SESSION_COOKIE_NAME } from "../configs/envConfig.js";

/** Parse a Cookie header into a plain object. Returns {} when absent. */
export const parseCookies = (header) => {
  const out = {};
  if (!header || typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue; // first occurrence wins, as browsers do
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value; // a malformed %-escape is still a usable opaque string
    }
  }
  return out;
};

export const readSessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] || null;

const unauthorized = (res, message = "Authentication required.") =>
  res.status(401).json({ success: false, message, code: "UNAUTHENTICATED" });

/**
 * Reject anything without a live session.
 *
 * Attaches req.auth = { user, session } for downstream handlers.
 */
export const requireAuth = async (req, res, next) => {
  try {
    const token = readSessionToken(req);
    if (!token) return unauthorized(res);

    const session = await resolveSession(token);
    if (!session) return unauthorized(res, "Your session has expired. Please sign in again.");

    req.auth = { user: session.user, session, token };
    // Fire-and-forget: a failed bookkeeping write must not fail the request.
    touchSession(session).catch(() => {});
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Populate req.auth when a session exists, but never reject. Used by routes
 * that are readable signed-out yet render differently when signed in.
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = readSessionToken(req);
    if (token) {
      const session = await resolveSession(token);
      if (session) req.auth = { user: session.user, session, token };
    }
  } catch {
    // An auth lookup failure on an optional path is not the caller's problem.
  }
  next();
};

const forbidden = (res, message, code = "FORBIDDEN") =>
  res.status(403).json({ success: false, message, code });

/** Restrict a route to a role. Mount after requireAuth. */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.auth?.user) return unauthorized(res);
  if (!roles.includes(req.auth.user.role)) {
    return forbidden(res, "You do not have permission to perform this action.");
  }
  next();
};

/** Team management: provisioning seats and deciding what anyone else may see. */
export const requireUserAdmin = (req, res, next) => {
  if (!req.auth?.user) return unauthorized(res);
  if (!canManageUsers(req.auth.user)) {
    return forbidden(res, "Only a super admin can manage team members.");
  }
  next();
};

/**
 * Gate a route on one or more permission keys — any one of them is enough.
 *
 * "Any of" rather than "all of" because several endpoints legitimately serve
 * more than one screen: the lead list feeds All leads, SaaS Promoter and the
 * bulk-send picker alike, and a promoter who cannot open /leads would still
 * need to read it.
 *
 * Mount after requireAuth. Permissions are re-read from the session's user row
 * on every request, so revoking access takes effect on the next call rather
 * than when the session happens to expire.
 */
export const requirePermission = (...keys) => (req, res, next) => {
  const user = req.auth?.user;
  if (!user) return unauthorized(res);
  if (!hasAnyPermission(user, keys)) {
    return forbidden(res, "You do not have access to this section. Ask a super admin to grant it.", "FORBIDDEN_SECTION");
  }
  next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse every state-changing request from a read-only seat.
 *
 * Mounted once, for the whole authenticated surface, rather than per route: a
 * read-only account that could write through a single endpoint somebody forgot
 * to annotate is not read-only at all. Changing your own password is the one
 * write a VIEWER can make, and that route is registered before this gate.
 */
export const blockReadOnlyWrites = (req, res, next) => {
  if (isReadOnly(req.auth?.user) && !SAFE_METHODS.has(req.method)) {
    return forbidden(
      res,
      "Your account is read-only. Ask a super admin if you need to make changes.",
      "READ_ONLY",
    );
  }
  next();
};
