import { safeFetchJson, FetchBlockedError } from "../crawler/safeFetch.js";
import { withHostSlot } from "../crawler/hostPolicy.js";
import { normalizeJobTitle } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("ats");

/**
 * Public applicant-tracking-system board APIs.
 *
 * These matter more than any other source: a job's presence in a *current*
 * board fetch is the only evidence that justifies calling it ACTIVE. A careers
 * page that still returns 200 proves nothing.
 *
 * Every one of these endpoints is unauthenticated and published by the vendor
 * for exactly this purpose (embedding a company's own jobs).
 */

const text = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const date = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const snippet = (html, max = 1500) =>
  html
    ? String(html).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : null;

const job = (raw) => ({
  externalId: String(raw.externalId),
  title: raw.title,
  normalizedTitle: normalizeJobTitle(raw.title),
  url: raw.url ?? null,
  applyUrl: raw.applyUrl ?? null,
  location: raw.location ?? null,
  department: raw.department ?? null,
  employmentType: raw.employmentType ?? null,
  remote: Boolean(raw.remote),
  postedAt: raw.postedAt ?? null,
  updatedAtSource: raw.updatedAtSource ?? null,
  deadlineAt: raw.deadlineAt ?? null,
  descriptionSnippet: raw.descriptionSnippet ?? null,
  raw: raw.raw,
});

// ─── Provider definitions ─────────────────────────────────────────────────────

export const ATS_PROVIDERS = {
  ATS_GREENHOUSE: {
    kind: "ATS_GREENHOUSE",
    label: "Greenhouse",
    host: "boards-api.greenhouse.io",
    boardUrl: (slug) => `https://boards.greenhouse.io/${slug}`,
    apiUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    parse: (payload) => {
      if (!payload || !Array.isArray(payload.jobs)) return null;
      return {
        companyName: null,
        jobs: payload.jobs.map((j) =>
          job({
            externalId: j.id,
            title: text(j.title),
            url: j.absolute_url,
            applyUrl: j.absolute_url,
            location: text(j.location?.name),
            department: text(j.departments?.[0]?.name),
            postedAt: date(j.first_published || j.updated_at),
            updatedAtSource: date(j.updated_at),
            // Greenhouse is the only board that publishes a real deadline.
            deadlineAt: date(j.application_deadline),
            raw: j,
          }),
        ),
      };
    },
  },

  ATS_LEVER: {
    kind: "ATS_LEVER",
    label: "Lever",
    host: "api.lever.co",
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    apiUrl: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    // An empty array is a *valid* response meaning "on Lever, nothing open" —
    // which is different from "not on Lever" (404). The probe relies on this.
    parse: (payload) => {
      if (!Array.isArray(payload)) return null;
      return {
        companyName: null,
        jobs: payload.map((j) =>
          job({
            externalId: j.id,
            title: text(j.text),
            url: j.hostedUrl,
            applyUrl: j.applyUrl,
            location: text(j.categories?.location),
            department: text(j.categories?.team || j.categories?.department),
            employmentType: text(j.categories?.commitment),
            remote: /remote/i.test(j.workplaceType || j.categories?.location || ""),
            postedAt: date(j.createdAt),
            updatedAtSource: date(j.updatedAt ?? j.createdAt),
            descriptionSnippet: snippet(j.descriptionPlain || j.description),
            raw: j,
          }),
        ),
      };
    },
  },

  ATS_ASHBY: {
    kind: "ATS_ASHBY",
    label: "Ashby",
    host: "api.ashbyhq.com",
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    apiUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    parse: (payload) => {
      if (!payload || !Array.isArray(payload.jobs)) return null;
      return {
        companyName: text(payload.name),
        jobs: payload.jobs.map((j) =>
          job({
            externalId: j.id,
            title: text(j.title),
            url: j.jobUrl,
            applyUrl: j.applyUrl || j.jobUrl,
            location: text(j.location),
            department: text(j.department || j.team),
            employmentType: text(j.employmentType),
            remote: Boolean(j.isRemote),
            postedAt: date(j.publishedAt),
            updatedAtSource: date(j.updatedAt ?? j.publishedAt),
            descriptionSnippet: snippet(j.descriptionHtml || j.descriptionPlain),
            raw: j,
          }),
        ),
      };
    },
  },

  ATS_SMARTRECRUITERS: {
    kind: "ATS_SMARTRECRUITERS",
    label: "SmartRecruiters",
    host: "api.smartrecruiters.com",
    boardUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
    apiUrl: (slug) =>
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100&offset=0`,
    parse: (payload, slug) => {
      if (!payload || !Array.isArray(payload.content)) return null;
      return {
        companyName: text(payload.content?.[0]?.company?.name),
        jobs: payload.content.map((j) =>
          job({
            externalId: j.id,
            title: text(j.name),
            url: `https://careers.smartrecruiters.com/${slug}/${j.id}`,
            location: [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null,
            department: text(j.department?.label),
            employmentType: text(j.typeOfEmployment?.label),
            remote: Boolean(j.location?.remote),
            postedAt: date(j.releasedDate),
            updatedAtSource: date(j.releasedDate),
            raw: j,
          }),
        ),
      };
    },
  },

  ATS_WORKABLE: {
    kind: "ATS_WORKABLE",
    label: "Workable",
    host: "apply.workable.com",
    boardUrl: (slug) => `https://apply.workable.com/${slug}/`,
    apiUrl: (slug) =>
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
    parse: (payload, slug) => {
      if (!payload || !Array.isArray(payload.jobs)) return null;
      return {
        companyName: text(payload.name),
        jobs: payload.jobs.map((j) =>
          job({
            externalId: j.shortcode || j.id,
            title: text(j.title),
            url: j.url || j.application_url || `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
            applyUrl: j.application_url,
            location: [j.city, j.country].filter(Boolean).join(", ") || text(j.location),
            department: text(j.department),
            employmentType: text(j.employment_type),
            remote: Boolean(j.telecommuting || j.remote),
            postedAt: date(j.published_on || j.created_at),
            updatedAtSource: date(j.published_on),
            descriptionSnippet: snippet(j.description),
            raw: j,
          }),
        ),
      };
    },
  },

  ATS_RECRUITEE: {
    kind: "ATS_RECRUITEE",
    label: "Recruitee",
    host: null, // per-tenant host: {slug}.recruitee.com
    boardUrl: (slug) => `https://${slug}.recruitee.com/`,
    apiUrl: (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`,
    parse: (payload) => {
      if (!payload || !Array.isArray(payload.offers)) return null;
      return {
        companyName: null,
        jobs: payload.offers
          // Recruitee exposes drafts and closed roles too; only published ones
          // are evidence of active hiring.
          .filter((o) => !o.status || o.status === "published")
          .map((o) =>
            job({
              externalId: o.id,
              title: text(o.title),
              url: o.careers_url || o.careers_apply_url,
              applyUrl: o.careers_apply_url,
              location: [o.city, o.country_code].filter(Boolean).join(", ") || text(o.location),
              department: text(o.department),
              employmentType: text(o.employment_type_code || o.employment_type),
              remote: Boolean(o.remote),
              postedAt: date(o.published_at || o.created_at),
              updatedAtSource: date(o.updated_at || o.published_at),
              descriptionSnippet: snippet(o.description),
              raw: o,
            }),
          ),
      };
    },
  },
};

/**
 * Fetch one company's board.
 *
 * @returns {Promise<{found:boolean, jobs:Array, companyName:string|null,
 *   payload:*, url:string, reason:string|null}>}
 *   `found:false` with reason NOT_FOUND means "this slug is not on this ATS" —
 *   that is a normal, expected outcome during probing, not an error.
 */
export const fetchAtsBoard = async (providerKind, slug) => {
  const provider = ATS_PROVIDERS[providerKind];
  if (!provider) throw new Error(`Unknown ATS provider: ${providerKind}`);

  const url = provider.apiUrl(slug);
  const host = provider.host || new URL(url).host;

  try {
    const res = await withHostSlot(host, () => safeFetchJson(url, { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 }));
    const parsed = provider.parse(res.json, slug);
    if (!parsed) {
      return { found: false, jobs: [], companyName: null, payload: res.json, url, reason: "UNEXPECTED_SHAPE" };
    }
    return { found: true, jobs: parsed.jobs, companyName: parsed.companyName, payload: res.json, url, reason: null };
  } catch (err) {
    const reason =
      err instanceof FetchBlockedError && err.meta?.status === 404 ? "NOT_FOUND"
      : err instanceof FetchBlockedError ? err.reason
      : "NETWORK_ERROR";
    if (reason !== "NOT_FOUND") {
      logger.debug({ provider: providerKind, slug, reason, msg: err.message }, "ATS board fetch failed");
    }
    return { found: false, jobs: [], companyName: null, payload: null, url, reason };
  }
};

/**
 * Try a company's likely slugs across every provider until a board answers.
 * Stops at the first hit — a company is on one ATS, not six.
 */
export const probeAtsSlug = async (candidates, { providers = Object.keys(ATS_PROVIDERS) } = {}) => {
  const attempts = [];
  for (const providerKind of providers) {
    for (const slug of candidates) {
      const res = await fetchAtsBoard(providerKind, slug);
      attempts.push({ providerKind, slug, found: res.found, reason: res.reason, jobCount: res.jobs.length });
      // A board that exists but is empty still proves the account — worth
      // recording so future re-checks skip straight to the right provider.
      if (res.found) {
        return { provider: providerKind, slug, ...res, attempts };
      }
    }
  }
  return { provider: null, slug: null, found: false, jobs: [], attempts };
};
