import { safeFetchJson, FetchBlockedError } from "../crawler/safeFetch.js";
import { withHostSlot, setCrawlDelay } from "../crawler/hostPolicy.js";
import { log } from "../../utils/logger.js";

const logger = log("crtsh");

/**
 * Certificate Transparency lookups via crt.sh.
 *
 * Every publicly-trusted TLS certificate is logged, publicly and permanently.
 * That makes CT the cheapest reliable answer to "how new is this business
 * online?" — the first certificate for a domain is issued when the site goes
 * up, so it dates the digital presence far better than a copyright notice.
 *
 * It also reveals *new subdomains*: a `shop.` or `booking.` host appearing this
 * month is a company standing up new capability right now.
 *
 * crt.sh is slow and frequently unavailable, so every caller must treat this as
 * best-effort. It is only ever run from scheduled maintenance, never inline in
 * a user-facing request.
 */

const HOST = "crt.sh";
setCrawlDelay(HOST, 10_000); // this is a free community service — be gentle

const INTERESTING_SUBDOMAIN = /^(shop|store|app|booking|book|order|portal|checkout|api|admin|my|account|dashboard)\./i;

/**
 * crt.sh emits UTC timestamps with no timezone designator
 * ("2026-08-10T00:00:00"), which `new Date()` interprets as *local* time. Left
 * alone that shifts every certificate date by up to a day, which matters when
 * "first seen within 60 days" decides whether a company counts as new.
 */
const parseUtc = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * @returns {Promise<{ok:boolean, firstSeen:Date|null, subdomains:Array, reason:string|null}>}
 */
export const lookupDomain = async (domain, { timeoutMs = 30_000 } = {}) => {
  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;

  let entries;
  try {
    const res = await withHostSlot(HOST, () =>
      safeFetchJson(url, { timeoutMs, maxBytes: 12 * 1024 * 1024 }),
    );
    entries = Array.isArray(res.json) ? res.json : [];
  } catch (err) {
    const reason = err instanceof FetchBlockedError ? err.reason : "NETWORK_ERROR";
    // Expected often enough that it is not worth a warning.
    logger.debug({ domain, reason }, "crt.sh unavailable — skipping (best-effort source)");
    return { ok: false, firstSeen: null, subdomains: [], reason };
  }

  const parsed = parseCertificates(entries, domain);
  logger.debug(
    { domain, certificates: entries.length, firstSeen: parsed.firstSeen, interestingSubdomains: parsed.subdomains.length },
    "crt.sh lookup complete",
  );
  return { ok: true, ...parsed, reason: null };
};

/**
 * Pure parsing of a crt.sh payload, separated from fetching so it can be
 * verified without depending on a third-party service that is often down.
 *
 * @returns {{firstSeen: Date|null, subdomains: Array<{host,label,firstSeen}>}}
 */
export const parseCertificates = (entries, domain) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { firstSeen: null, subdomains: [] };
  }

  let firstSeen = null;
  const bySubdomain = new Map();

  for (const entry of entries) {
    const notBefore = parseUtc(entry.not_before);
    if (notBefore && (!firstSeen || notBefore < firstSeen)) firstSeen = notBefore;

    // name_value is a newline-separated list of every name on the certificate.
    for (const raw of String(entry.name_value || "").split(/\s+/)) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, "");
      if (!name || !name.endsWith(domain) || name === domain) continue;
      const label = name.slice(0, -(domain.length + 1));
      if (!label || label.includes(".")) continue; // one level only

      const existing = bySubdomain.get(name);
      if (!existing || (notBefore && notBefore < existing.firstSeen)) {
        bySubdomain.set(name, { host: name, label, firstSeen: notBefore || new Date() });
      }
    }
  }

  const subdomains = [...bySubdomain.values()]
    .filter((s) => INTERESTING_SUBDOMAIN.test(`${s.label}.`))
    .sort((a, b) => b.firstSeen - a.firstSeen);

  return { firstSeen, subdomains };
};
