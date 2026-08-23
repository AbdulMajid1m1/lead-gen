import dns from "node:dns";
import zlib from "node:zlib";
import { promisify } from "node:util";
import { Agent, request } from "undici";
import { isBlockedAddress, isBlockedHostname } from "./ipGuard.js";
import {
  CRAWLER_ALLOW_PRIVATE_HOSTS,
  CRAWLER_MAX_BYTES,
  CRAWLER_MAX_REDIRECTS,
  CRAWLER_TIMEOUT_MS,
  CRAWLER_USER_AGENT,
} from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("safeFetch");

/** Thrown for every refusal so callers can record `blockReason` verbatim. */
export class FetchBlockedError extends Error {
  constructor(reason, message, meta = {}) {
    super(message);
    this.name = "FetchBlockedError";
    this.reason = reason; // machine-readable, stored on CrawlResult.blockReason
    this.meta = meta;
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);

/**
 * undici's `request` (unlike `fetch`) does not transparently decompress, so we
 * do it here. `maxOutputLength` is the zip-bomb guard: a 3MB gzip payload can
 * expand to gigabytes, and the byte cap enforced while streaming only bounds
 * the *compressed* size.
 */
const decompress = async (buffer, contentEncoding, maxBytes) => {
  const encoding = String(contentEncoding || "").toLowerCase().trim().split(",").pop()?.trim();
  if (!encoding || encoding === "identity" || buffer.length === 0) return { buffer, truncated: false };

  const opts = { maxOutputLength: maxBytes };
  try {
    switch (encoding) {
      case "gzip":
      case "x-gzip":
        return { buffer: await gunzip(buffer, opts), truncated: false };
      case "br":
        return { buffer: await brotli(buffer, opts), truncated: false };
      case "deflate":
        // Some servers send raw deflate despite the header; try both.
        try {
          return { buffer: await inflate(buffer, opts), truncated: false };
        } catch {
          return { buffer: await inflateRaw(buffer, opts), truncated: false };
        }
      default:
        return { buffer, truncated: false };
    }
  } catch (err) {
    if (err.code === "ERR_BUFFER_TOO_LARGE") {
      throw new FetchBlockedError(
        "DECOMPRESSION_BOMB",
        `Response expanded past the ${maxBytes}-byte cap when decompressing ${encoding}.`,
      );
    }
    throw new FetchBlockedError("DECOMPRESSION_FAILED", `Could not decode ${encoding} response: ${err.message}`);
  }
};

/**
 * DNS lookup that refuses to hand a private address to the socket layer.
 *
 * Enforcing here (rather than "resolve, check, then fetch") closes the
 * DNS-rebinding window: undici calls this at connect time and we only ever
 * return addresses that passed the guard.
 */
const guardedLookup = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const safe = list.filter((a) => !isBlockedAddress(a.address));
    if (safe.length === 0) {
      return callback(
        new FetchBlockedError(
          "SSRF_PRIVATE_ADDRESS",
          `Refusing to connect to ${hostname}: resolves only to non-public addresses ` +
            `(${list.map((a) => a.address).join(", ")}).`,
          { hostname },
        ),
      );
    }
    // `all:true` was forced above; honour the caller's original expectation.
    return options?.all ? callback(null, safe) : callback(null, safe[0].address, safe[0].family);
  });
};

// One pooled dispatcher for the whole process. connect.lookup is the guard.
//
// The dispatcher-level timeouts are a backstop only, deliberately far above
// CRAWLER_TIMEOUT_MS: the real per-request limit is the AbortController in
// safeFetch, and an Agent-level value would silently override any caller that
// legitimately needs longer (an Overpass query can take 45s to compute).
const DISPATCHER_TIMEOUT_CEILING_MS = 180_000;

const dispatcher = new Agent({
  connect: {
    lookup: CRAWLER_ALLOW_PRIVATE_HOSTS ? undefined : guardedLookup,
    timeout: 10_000,
  },
  headersTimeout: DISPATCHER_TIMEOUT_CEILING_MS,
  bodyTimeout: DISPATCHER_TIMEOUT_CEILING_MS,
  connections: 64,
  pipelining: 1,
});

/** Validate a URL before it is ever handed to the network stack. */
export const assertFetchableUrl = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchBlockedError("INVALID_URL", `Not a valid URL: ${rawUrl}`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new FetchBlockedError("BLOCKED_PROTOCOL", `Protocol ${url.protocol} is not crawlable.`);
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new FetchBlockedError("BLOCKED_PORT", `Port ${url.port} is not permitted.`);
  }
  if (url.username || url.password) {
    throw new FetchBlockedError("CREDENTIALS_IN_URL", "URLs with embedded credentials are refused.");
  }
  if (!CRAWLER_ALLOW_PRIVATE_HOSTS && isBlockedHostname(url.hostname)) {
    throw new FetchBlockedError("SSRF_PRIVATE_HOST", `Host ${url.hostname} is not a public host.`);
  }
  return url;
};

/**
 * Fetch a URL with every crawler-safety rule applied:
 * SSRF guard at connect time, manual redirect handling (each hop re-validated),
 * hard byte cap enforced while streaming, wall-clock timeout, and a truthful
 * User-Agent.
 *
 * @returns {Promise<{url:string, finalUrl:string, status:number, headers:object,
 *   body:string, bytes:number, truncated:boolean, elapsedMs:number, redirects:string[],
 *   contentType:string}>}
 */
export const safeFetch = async (rawUrl, opts = {}) => {
  const {
    method = "GET",
    headers = {},
    body: requestBody = null,
    timeoutMs = CRAWLER_TIMEOUT_MS,
    maxBytes = CRAWLER_MAX_BYTES,
    maxRedirects = CRAWLER_MAX_REDIRECTS,
    accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  } = opts;

  const startedAt = Date.now();
  const redirects = [];
  let url = assertFetchableUrl(rawUrl);

  // undici streams a string body with chunked transfer-encoding unless a
  // content-length is present, and some API servers (Overpass among them) wait
  // indefinitely for a chunked POST instead of processing it.
  const bodyBuffer = requestBody === null || requestBody === undefined
    ? null
    : Buffer.isBuffer(requestBody) ? requestBody : Buffer.from(String(requestBody), "utf8");
  const bodyHeaders = bodyBuffer ? { "content-length": String(bodyBuffer.length) } : {};

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await request(url.href, {
        method,
        dispatcher,
        signal: controller.signal,
        maxRedirections: 0, // handled manually so every hop is re-validated
        // Only send the body on the first hop; a 307/308 replay is not worth
        // the surprise of re-POSTing to a host we were redirected to.
        body: hop === 0 ? bodyBuffer : null,
        headers: {
          "user-agent": CRAWLER_USER_AGENT,
          accept,
          "accept-language": "en;q=0.9,*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
          ...(hop === 0 ? bodyHeaders : {}),
          ...headers,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FetchBlockedError) throw err;
      // undici wraps the lookup error; unwrap so the reason survives.
      if (err?.cause instanceof FetchBlockedError) throw err.cause;
      if (err.name === "AbortError" || err.code === "UND_ERR_HEADERS_TIMEOUT" || err.code === "UND_ERR_BODY_TIMEOUT") {
        throw new FetchBlockedError("TIMEOUT", `Timed out after ${timeoutMs}ms: ${url.href}`);
      }
      throw new FetchBlockedError(
        "NETWORK_ERROR",
        `${err.code || err.name || "Network error"} fetching ${url.href}: ${err.message}`,
      );
    }

    // ─── Redirect: validate the next hop with the same rules ────────────────
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.body.dump().catch(() => {});
      clearTimeout(timer);
      if (hop === maxRedirects) {
        throw new FetchBlockedError("TOO_MANY_REDIRECTS", `Exceeded ${maxRedirects} redirects from ${rawUrl}`);
      }
      const next = new URL(res.headers.location, url.href);
      redirects.push(next.href);
      // A public URL redirecting to 169.254.169.254 is the classic SSRF
      // escape; assertFetchableUrl re-runs the full guard on every hop.
      url = assertFetchableUrl(next.href);
      continue;
    }

    // ─── Terminal response: stream with a hard byte cap ─────────────────────
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    try {
      for await (const chunk of res.body) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (bytes - maxBytes))));
          res.body.destroy();
          break;
        }
        chunks.push(chunk);
      }
    } catch (err) {
      if (!truncated) {
        clearTimeout(timer);
        throw new FetchBlockedError("BODY_READ_ERROR", `Failed reading body of ${url.href}: ${err.message}`);
      }
    }
    clearTimeout(timer);

    const contentType = String(res.headers["content-type"] || "");
    const raw = Buffer.concat(chunks);
    const { buffer: decoded } = await decompress(raw, res.headers["content-encoding"], maxBytes);
    const body = decoded.toString("utf8");

    if (truncated) {
      logger.debug({ url: url.href, maxBytes }, "response truncated at byte cap");
    }

    return {
      url: rawUrl,
      finalUrl: url.href,
      status: res.statusCode,
      headers: res.headers,
      body,
      bytes,
      truncated,
      contentType,
      redirects,
      elapsedMs: Date.now() - startedAt,
    };
  }

  throw new FetchBlockedError("TOO_MANY_REDIRECTS", `Exceeded ${maxRedirects} redirects from ${rawUrl}`);
};

/** Fetch and JSON.parse, with a clear error when a source returns HTML instead. */
export const safeFetchJson = async (rawUrl, opts = {}) => {
  const res = await safeFetch(rawUrl, { accept: "application/json,*/*;q=0.8", ...opts });
  if (res.status >= 400) {
    throw new FetchBlockedError("HTTP_ERROR", `HTTP ${res.status} from ${rawUrl}`, { status: res.status });
  }
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch {
    throw new FetchBlockedError(
      "INVALID_JSON",
      `Expected JSON from ${rawUrl} but got ${res.contentType || "unknown content-type"}.`,
    );
  }
};
