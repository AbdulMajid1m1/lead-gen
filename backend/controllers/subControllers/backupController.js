import { spawn } from "node:child_process";
import { createGzip } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import { URL as NodeURL } from "node:url";
import { z } from "zod";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { DB_BACKUP_PASSWORD, DATABASE_URL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("backup");

export const backupSchema = z.object({
  password: z.string().min(1, "The backup password is required."),
});

/**
 * Constant-time password check.
 *
 * Buffers of differing length make timingSafeEqual throw, so length is compared
 * first — deliberately, and cheaply. Length is not the secret here; the value is.
 */
const passwordMatches = (supplied) => {
  if (!DB_BACKUP_PASSWORD) return false;
  const a = Buffer.from(String(supplied ?? ""), "utf8");
  const b = Buffer.from(DB_BACKUP_PASSWORD, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * POST /api/backup/database — stream a full pg_dump of the database.
 *
 * Plain SQL, gzipped on the fly, restorable with:
 *     gunzip < backup.sql.gz | psql "$DATABASE_URL"
 *
 * POST rather than GET because the body carries a password, and a secret in a
 * query string is written to nginx's access log and kept in browser history.
 *
 * Notes on why this is safe to expose to an authenticated admin:
 *   - requireAuth + ADMIN role at the route layer, and a separate backup
 *     password on top. This endpoint hands over every contact the crawler has
 *     ever collected, so a live session alone is not enough on its own.
 *   - The database password reaches pg_dump through PGPASSWORD, never argv —
 *     arguments are visible to every process on the box via `ps`.
 *   - Output is streamed, so memory stays flat no matter how large the DB gets.
 *   - --no-owner --no-acl makes the dump restorable onto a different host with
 *     different role names, which is the situation you are in during a real
 *     recovery.
 */
export const downloadDatabaseBackup = asyncHandler(async (req, res) => {
  if (!DB_BACKUP_PASSWORD) {
    throw createError(503, "Backup download is not configured on this server. Set DB_BACKUP_PASSWORD.");
  }
  // 403, not 401: the session is perfectly valid, the second factor is what
  // failed. A 401 here would be read as "your session expired" and bounce the
  // admin to the login screen over a typo.
  if (!passwordMatches(req.body?.password)) {
    throw createError(403, "That backup password is not correct.");
  }

  const dbUrl = new NodeURL(DATABASE_URL || "");
  const dbName = dbUrl.pathname.replace(/^\//, "").split("?")[0];
  if (!dbUrl.hostname || !dbName) {
    throw createError(500, "DATABASE_URL is missing or malformed on the server.");
  }

  const args = [
    "-h", dbUrl.hostname,
    "-p", dbUrl.port || "5432",
    "-U", decodeURIComponent(dbUrl.username),
    "-d", dbName,
    "--no-owner",
    "--no-acl",
    "--clean",
    "--if-exists",
    "-Fp",
  ];

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const filename = `leadsignal-backup-${stamp}.sql.gz`;

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const dump = spawn("pg_dump", args, {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(dbUrl.password || "") },
  });
  const gzip = createGzip({ level: 6 });

  let stderrBuf = "";
  dump.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  dump.on("error", (err) => {
    logger.error({ err }, "pg_dump failed to start");
    if (!res.headersSent) {
      const msg = err.code === "ENOENT"
        ? "pg_dump is not installed in the API image. Rebuild with postgresql-client-16."
        : `The backup could not be started: ${err.message}`;
      // Headers are still ours to write, so this surfaces as a clean JSON error.
      res.status(500).json({ success: false, message: msg });
      return;
    }
    try { res.destroy(err); } catch { /* already tearing down */ }
  });

  // ── Finishing the response by hand ──────────────────────────────────────────
  // Letting gzip end the response is subtly wrong. When pg_dump dies partway,
  // its stdout simply closes; gzip reads that as a clean end of input and writes
  // a *valid* gzip trailer. The download then succeeds, gunzips without
  // complaint, and contains a silently truncated database — a backup that only
  // reveals itself as useless on the day it is needed.
  //
  // Instead: pipe with { end: false }, wait for both the compressor to drain and
  // pg_dump to report its exit code, then either end the response normally or
  // destroy the socket. A destroyed socket aborts the chunked transfer, which
  // every HTTP client reports as a failed download rather than a complete one.
  let gzipEnded = false;
  let dumpExit = null;
  let settled = false;

  const maybeFinish = () => {
    if (settled || !gzipEnded || dumpExit === null) return;
    settled = true;
    if (dumpExit === 0) {
      logger.info({ filename }, "database backup streamed");
      res.end();
    } else {
      logger.error({ code: dumpExit, stderr: stderrBuf.slice(-500) }, "pg_dump exited non-zero");
      res.destroy(new Error(`pg_dump exited with code ${dumpExit}`));
    }
  };

  gzip.on("end", () => { gzipEnded = true; maybeFinish(); });
  dump.on("close", (code) => { dumpExit = code; maybeFinish(); });

  // Stop dumping if the admin closes the tab mid-download.
  req.on("close", () => {
    if (!dump.killed) {
      try { dump.kill("SIGTERM"); } catch { /* already gone */ }
    }
  });

  dump.stdout.pipe(gzip);
  gzip.pipe(res, { end: false });
});
