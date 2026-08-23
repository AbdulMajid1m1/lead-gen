/**
 * Authentication middleware.
 *
 * Reads the session cookie directly off the request rather than pulling in
 * cookie-parser: this API sets exactly one cookie and reads exactly one, and a
 * dependency whose whole job is `String.split` is not worth the supply chain.
 */
import { resolveSession, touchSession } from "../lib/auth/session.js";
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

/** Restrict a route to a role. Mount after requireAuth. */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.auth?.user) return unauthorized(res);
  if (!roles.includes(req.auth.user.role)) {
    return res.status(403).json({
      success: false,
      message: "You do not have permission to perform this action.",
      code: "FORBIDDEN",
    });
  }
  next();
};
