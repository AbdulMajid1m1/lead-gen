/**
 * Password hashing.
 *
 * scrypt from node:crypto rather than bcrypt/argon2 from npm. Both of those are
 * native addons: they need a toolchain in the image, they break on Node major
 * upgrades, and they are a supply-chain dependency for the one thing in this
 * codebase that must not be tampered with. scrypt is memory-hard, is in the
 * standard library, and is what RFC 7914 recommends for exactly this job.
 *
 * Stored form:  scrypt$N$r$p$<salt-base64>$<hash-base64>
 * The parameters travel with the digest, so raising the cost later still
 * verifies every password hashed before the change.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// ~64 MB per hash (128 * N * r bytes). Comfortably above the 2017 RFC minimum
// and still well under the API container's memory budget, even if several
// logins land at once — see maxmem below.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
// scrypt's default maxmem is 32 MB, which N=2^15 exceeds — it would throw
// instead of hashing. Give it headroom rather than weakening the parameters.
const MAX_MEM = 192 * 1024 * 1024;

/** Hash a plaintext password into its portable, self-describing digest. */
export const hashPassword = async (plain) => {
  if (typeof plain !== "string" || plain.length === 0) {
    throw new Error("hashPassword: a non-empty password is required");
  }
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAX_MEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
};

/**
 * Verify a password against a stored digest.
 *
 * Returns false — never throws — for a malformed or unrecognised digest, so a
 * corrupted row locks that account out instead of crashing the login route.
 */
export const verifyPassword = async (plain, stored) => {
  if (typeof plain !== "string" || typeof stored !== "string") return false;

  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived;
  try {
    derived = await scrypt(plain, salt, expected.length, { N: n, r, p, maxmem: MAX_MEM });
  } catch {
    return false;
  }

  // Lengths already match by construction, but timingSafeEqual throws if they
  // ever do not, and a throw here would leak "malformed digest" as a 500.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
};

/**
 * Minimum strength for a provisioned account. Deliberately short of a full
 * policy engine: these accounts are created by an operator, not by the public,
 * so the check exists to catch "admin123" in a .env, not to police users.
 */
export const passwordProblem = (plain) => {
  if (typeof plain !== "string" || plain.length < 12) {
    return "Password must be at least 12 characters.";
  }
  if (!/[a-z]/.test(plain) || !/[A-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Password must contain lower-case, upper-case and numeric characters.";
  }
  return null;
};
