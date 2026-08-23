import { CRAWLER_DEFAULT_DELAY_MS } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("hostPolicy");

/**
 * Per-host politeness state: serialises requests to a host, enforces the
 * crawl-delay between them, and applies exponential backoff when the host
 * signals distress (429 / 403 / 5xx).
 *
 * In-process by design: the worker pool is the only thing that crawls, and a
 * single Redis round-trip per request would cost more than it saves. Scaling
 * to multiple worker processes means partitioning hosts by worker (see
 * docs/ARCHITECTURE.md) rather than sharing this map.
 */
const hosts = new Map(); // host → state

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 min ceiling
const MAX_CONSECUTIVE_FAILURES = 5;

const stateFor = (host) => {
  let s = hosts.get(host);
  if (!s) {
    s = {
      host,
      nextAllowedAt: 0,
      crawlDelayMs: CRAWLER_DEFAULT_DELAY_MS,
      consecutiveFailures: 0,
      blockedUntil: 0,
      blockReason: null,
      chain: Promise.resolve(),
      requests: 0,
    };
    hosts.set(host, s);
  }
  return s;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const setCrawlDelay = (host, delayMs) => {
  const s = stateFor(host);
  s.crawlDelayMs = Math.max(delayMs || 0, CRAWLER_DEFAULT_DELAY_MS);
};

/** Is this host currently in a backoff window? */
export const getHostBlock = (host) => {
  const s = hosts.get(host);
  if (!s || s.blockedUntil <= Date.now()) return null;
  return { until: new Date(s.blockedUntil), reason: s.blockReason, retryInMs: s.blockedUntil - Date.now() };
};

/**
 * Run `fn` under this host's politeness lock. Requests to the same host run
 * strictly one at a time, spaced by the crawl-delay.
 */
export const withHostSlot = async (host, fn) => {
  const s = stateFor(host);

  const run = async () => {
    const block = getHostBlock(host);
    if (block) {
      const err = new Error(
        `Host ${host} is in backoff for ${Math.ceil(block.retryInMs / 1000)}s (${block.reason}).`,
      );
      err.reason = "HOST_BACKOFF";
      err.retryInMs = block.retryInMs;
      throw err;
    }
    const wait = s.nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
    s.nextAllowedAt = Date.now() + s.crawlDelayMs;
    s.requests += 1;
    return fn();
  };

  // Chain onto the host's queue so concurrent callers serialise per host while
  // different hosts still run in parallel.
  const result = s.chain.then(run, run);
  s.chain = result.then(() => {}, () => {});
  return result;
};

/**
 * Feed the outcome of a request back into the host's backoff state.
 * `retryAfterSeconds` comes from the Retry-After header when present — a host
 * that tells us when to come back is always obeyed over our own formula.
 */
export const recordOutcome = (host, { status, ok, retryAfterSeconds } = {}) => {
  const s = stateFor(host);

  if (ok || (status && status < 400 && status !== 429)) {
    s.consecutiveFailures = 0;
    return;
  }

  const isDistress = status === 429 || status === 403 || status === 503 || (status >= 500 && status < 600) || !status;
  if (!isDistress) return; // 404/410 is a page problem, not a host problem

  s.consecutiveFailures += 1;

  let backoff = Math.min(BASE_BACKOFF_MS * 2 ** (s.consecutiveFailures - 1), MAX_BACKOFF_MS);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    backoff = Math.max(backoff, Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS));
  }
  // Jitter avoids a thundering herd when many queued jobs share a host.
  backoff = Math.round(backoff * (0.85 + Math.random() * 0.3));

  s.blockedUntil = Date.now() + backoff;
  s.blockReason = status ? `HTTP_${status}` : "NETWORK_ERROR";

  if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    s.blockedUntil = Date.now() + MAX_BACKOFF_MS;
    s.blockReason = `REPEATED_${s.blockReason}`;
  }

  logger.debug(
    { host, status, failures: s.consecutiveFailures, backoffMs: backoff },
    "host entered backoff",
  );
};

/** Parse Retry-After in either seconds or HTTP-date form. */
export const parseRetryAfter = (value) => {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : null;
};

export const _resetHostPolicy = () => hosts.clear();
export const _hostStats = () =>
  [...hosts.values()].map(({ host, requests, consecutiveFailures, blockedUntil, crawlDelayMs }) => ({
    host, requests, consecutiveFailures, crawlDelayMs,
    blockedForMs: Math.max(0, blockedUntil - Date.now()),
  }));
