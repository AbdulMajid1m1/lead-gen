import robotsParser from "robots-parser";
import { safeFetch, FetchBlockedError } from "./safeFetch.js";
import { CRAWLER_RESPECT_ROBOTS, CRAWLER_USER_AGENT, CRAWLER_DEFAULT_DELAY_MS } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("robots");

// The bare token a site owner would write in robots.txt to target us.
export const ROBOTS_UA_TOKEN = CRAWLER_USER_AGENT.split("/")[0] || "LeadSignalBot";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — robots.txt changes are rare
const NEGATIVE_TTL_MS = 30 * 60 * 1000;  // retry unreachable robots sooner
const cache = new Map(); // origin → { robots, crawlDelayMs, sitemaps, fetchedAt, expiresAt, status }

/**
 * Load (and cache) the robots.txt for an origin.
 *
 * Failure policy, deliberately asymmetric:
 *  - 404 / 410 → no rules exist, crawling is allowed (RFC 9309).
 *  - 5xx / network error → treated as "disallow all". A site that is failing
 *    is the last one that should receive extra traffic from us.
 */
export const getRobots = async (origin) => {
  const cached = cache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const robotsUrl = `${origin}/robots.txt`;
  let entry;

  try {
    const res = await safeFetch(robotsUrl, {
      accept: "text/plain,*/*;q=0.8",
      maxBytes: 512 * 1024,
      timeoutMs: 10_000,
    });

    if (res.status === 404 || res.status === 410) {
      entry = { robots: null, crawlDelayMs: CRAWLER_DEFAULT_DELAY_MS, sitemaps: [], status: res.status, allowAll: true };
    } else if (res.status >= 400) {
      // 401/403 on robots.txt means the whole site is access-controlled.
      entry = { robots: null, crawlDelayMs: CRAWLER_DEFAULT_DELAY_MS, sitemaps: [], status: res.status, denyAll: true };
    } else {
      const robots = robotsParser(robotsUrl, res.body);
      const declared = robots.getCrawlDelay(ROBOTS_UA_TOKEN);
      entry = {
        robots,
        // Honour a declared crawl-delay, but never go *faster* than our own
        // default politeness floor.
        crawlDelayMs: Number.isFinite(declared)
          ? Math.max(declared * 1000, CRAWLER_DEFAULT_DELAY_MS)
          : CRAWLER_DEFAULT_DELAY_MS,
        sitemaps: robots.getSitemaps() || [],
        status: res.status,
      };
    }
  } catch (err) {
    const reason = err instanceof FetchBlockedError ? err.reason : "NETWORK_ERROR";
    logger.debug({ origin, reason }, "robots.txt unreachable — treating host as disallowed");
    entry = {
      robots: null,
      crawlDelayMs: CRAWLER_DEFAULT_DELAY_MS,
      sitemaps: [],
      status: 0,
      denyAll: true,
      error: reason,
    };
  }

  entry.fetchedAt = Date.now();
  entry.expiresAt = Date.now() + (entry.denyAll ? NEGATIVE_TTL_MS : CACHE_TTL_MS);
  cache.set(origin, entry);
  return entry;
};

/**
 * @returns {Promise<{allowed:boolean, reason:string|null, crawlDelayMs:number,
 *   sitemaps:string[], robotsStatus:number}>}
 */
export const checkRobots = async (rawUrl) => {
  const url = new URL(rawUrl);
  const entry = await getRobots(url.origin);

  if (!CRAWLER_RESPECT_ROBOTS) {
    // Only reachable in development — envConfig refuses to boot production
    // with this off. Still reported so the decision is visible in provenance.
    return { allowed: true, reason: "ROBOTS_CHECK_DISABLED", crawlDelayMs: entry.crawlDelayMs, sitemaps: entry.sitemaps, robotsStatus: entry.status };
  }

  if (entry.denyAll) {
    return {
      allowed: false,
      reason: entry.error ? `ROBOTS_UNREACHABLE_${entry.error}` : `ROBOTS_HTTP_${entry.status}`,
      crawlDelayMs: entry.crawlDelayMs,
      sitemaps: [],
      robotsStatus: entry.status,
    };
  }

  if (entry.allowAll || !entry.robots) {
    return { allowed: true, reason: null, crawlDelayMs: entry.crawlDelayMs, sitemaps: entry.sitemaps, robotsStatus: entry.status };
  }

  const allowed = entry.robots.isAllowed(url.href, ROBOTS_UA_TOKEN);
  return {
    // robots-parser returns undefined when no rule matches → allowed.
    allowed: allowed !== false,
    reason: allowed === false ? "ROBOTS_DISALLOWED" : null,
    crawlDelayMs: entry.crawlDelayMs,
    sitemaps: entry.sitemaps,
    robotsStatus: entry.status,
  };
};

/** Test seam — clears the in-process robots cache. */
export const _clearRobotsCache = () => cache.clear();
