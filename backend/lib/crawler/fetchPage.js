import crypto from "node:crypto";
import { safeFetch, FetchBlockedError } from "./safeFetch.js";
import { checkRobots } from "./robots.js";
import { withHostSlot, recordOutcome, setCrawlDelay, parseRetryAfter, getHostBlock } from "./hostPolicy.js";
import { detectBlock } from "./blockDetection.js";
import { log } from "../../utils/logger.js";

const logger = log("crawler");

/**
 * The one function the rest of the system uses to touch a remote page.
 *
 * It always resolves — never throws — to a uniform outcome record, because
 * *why* a crawl failed is itself provenance we store on CrawlResult:
 *
 *   { ok, status, blockReason, robotsAllowed, robotsReason, body, ... }
 */
export const fetchPage = async (rawUrl, opts = {}) => {
  const startedAt = new Date();
  const base = {
    url: rawUrl,
    finalUrl: null,
    ok: false,
    status: null,
    blockReason: null,
    blockDetail: null,
    robotsAllowed: null,
    robotsReason: null,
    contentHash: null,
    body: null,
    contentType: null,
    bytes: 0,
    elapsedMs: 0,
    redirects: [],
    jsRendered: false,
    startedAt,
    finishedAt: null,
    headers: {},
  };

  let host;
  try {
    host = new URL(rawUrl).host;
  } catch {
    return { ...base, blockReason: "INVALID_URL", blockDetail: `Not a valid URL: ${rawUrl}`, finishedAt: new Date() };
  }

  // Cheap pre-check so a host in backoff does not even consume a queue slot.
  const existingBlock = getHostBlock(host);
  if (existingBlock && !opts.ignoreBackoff) {
    return {
      ...base,
      blockReason: "HOST_BACKOFF",
      blockDetail: `${existingBlock.reason}; retry in ${Math.ceil(existingBlock.retryInMs / 1000)}s`,
      finishedAt: new Date(),
    };
  }

  // ─── robots.txt ─────────────────────────────────────────────────────────────
  let robots;
  try {
    robots = await checkRobots(rawUrl);
    setCrawlDelay(host, robots.crawlDelayMs);
  } catch (err) {
    return {
      ...base,
      blockReason: "ROBOTS_ERROR",
      blockDetail: err.message,
      robotsAllowed: false,
      finishedAt: new Date(),
    };
  }

  if (!robots.allowed) {
    logger.debug({ url: rawUrl, reason: robots.reason }, "skipped by robots.txt");
    return {
      ...base,
      blockReason: robots.reason,
      blockDetail: `robots.txt for ${host} does not permit this path`,
      robotsAllowed: false,
      robotsReason: robots.reason,
      finishedAt: new Date(),
    };
  }

  // ─── fetch under the host politeness lock ───────────────────────────────────
  let res;
  try {
    res = await withHostSlot(host, () => safeFetch(rawUrl, opts));
  } catch (err) {
    const reason = err instanceof FetchBlockedError ? err.reason : err.reason || "NETWORK_ERROR";
    if (reason !== "HOST_BACKOFF") recordOutcome(host, { ok: false });
    return {
      ...base,
      robotsAllowed: true,
      robotsReason: robots.reason,
      blockReason: reason,
      blockDetail: err.message,
      finishedAt: new Date(),
    };
  }

  recordOutcome(host, {
    status: res.status,
    ok: res.status < 400,
    retryAfterSeconds: parseRetryAfter(res.headers["retry-after"]),
  });

  const detection = detectBlock(res);
  const contentHash = crypto.createHash("sha256").update(res.body || "").digest("hex");

  return {
    ...base,
    finalUrl: res.finalUrl,
    ok: res.status >= 200 && res.status < 300 && !detection.blocked,
    status: res.status,
    blockReason: detection.blocked ? detection.reason : res.status >= 400 ? `HTTP_${res.status}` : null,
    blockDetail: detection.detail,
    robotsAllowed: true,
    robotsReason: robots.reason,
    contentHash,
    body: res.body,
    contentType: res.contentType,
    bytes: res.bytes,
    elapsedMs: res.elapsedMs,
    redirects: res.redirects,
    jsRendered: detection.jsRendered,
    headers: res.headers,
    finishedAt: new Date(),
  };
};
