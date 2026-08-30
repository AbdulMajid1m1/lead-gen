import prisma from "../../prismaClient.js";
import { fetchAtsBoard, probeAtsSlug, ATS_PROVIDERS } from "../adapters/ats.js";
import { ensureSource, recordSourceRecord, resolveCompany, recordFact } from "../provenance/recorder.js";
import { reconcileBoardJobs, initialStatusFor } from "../jobs/jobStatusEngine.js";
import { parseJobText } from "../extract/jobTextParser.js";
import { atsSlugCandidates, normalizeJobTitle } from "../../utils/normalize.js";
import { COUNTRY_NAMES } from "../../utils/countries.js";
import { log } from "../../utils/logger.js";

const logger = log("atsIngest");

/**
 * Pull a company's public job board into the database, with provenance, and
 * reconcile the status of everything we previously knew about.
 */
export const ingestAtsBoard = async ({ provider, slug, companyId = null, companyName = null }) => {
  const def = ATS_PROVIDERS[provider];
  if (!def) throw new Error(`Unknown ATS provider ${provider}`);

  const source = await ensureSource({
    kind: provider,
    name: def.label,
    baseUrl: def.boardUrl(slug),
    attribution: `Public ${def.label} job board API`,
  });

  const board = await fetchAtsBoard(provider, slug);
  if (!board.found) {
    return { ok: false, reason: board.reason, jobsIngested: 0, companyId };
  }

  // The board's own company name beats a guessed one.
  const resolvedName = board.companyName || companyName || slug;
  let company;
  if (companyId) {
    company = await prisma.company.findUnique({ where: { id: companyId } });
  }
  if (!company) {
    const resolved = await resolveCompany({
      name: resolvedName,
      atsSlug: `${provider}:${slug}`,
      discoveredVia: provider,
    });
    company = resolved.company;
  }

  await prisma.atsAccount.upsert({
    where: { provider_slug: { provider, slug } },
    update: { companyId: company.id, lastFetchedAt: new Date(), lastJobCount: board.jobs.length, consecutiveFails: 0, isActive: true, boardUrl: def.boardUrl(slug) },
    create: { companyId: company.id, provider, slug, boardUrl: def.boardUrl(slug), lastFetchedAt: new Date(), lastJobCount: board.jobs.length },
  });

  // One SourceRecord per job keeps each posting's provenance independent — a
  // job's evidence chain must not depend on the whole board payload.
  let ingested = 0;
  for (const job of board.jobs) {
    const record = await recordSourceRecord({
      sourceId: source.id,
      externalId: String(job.externalId),
      url: job.url,
      payload: job.raw,
    });

    const status = initialStatusFor({ fromBoard: true, postedAt: job.postedAt, deadlineAt: job.deadlineAt });

    const stored = await prisma.jobPosting.upsert({
      where: { sourceId_externalId: { sourceId: source.id, externalId: String(job.externalId) } },
      update: {
        companyId: company.id,
        title: job.title?.slice(0, 300) || "(untitled)",
        normalizedTitle: normalizeJobTitle(job.title).slice(0, 300),
        url: job.url,
        applyUrl: job.applyUrl,
        location: job.location?.slice(0, 255) ?? null,
        department: job.department?.slice(0, 160) ?? null,
        employmentType: job.employmentType?.slice(0, 60) ?? null,
        remote: job.remote,
        postedAt: job.postedAt,
        updatedAtSource: job.updatedAtSource,
        deadlineAt: job.deadlineAt,
        descriptionSnippet: job.descriptionSnippet?.slice(0, 2000) ?? null,
      },
      create: {
        companyId: company.id,
        sourceId: source.id,
        externalId: String(job.externalId),
        title: job.title?.slice(0, 300) || "(untitled)",
        normalizedTitle: normalizeJobTitle(job.title).slice(0, 300),
        url: job.url,
        applyUrl: job.applyUrl,
        location: job.location?.slice(0, 255) ?? null,
        department: job.department?.slice(0, 160) ?? null,
        employmentType: job.employmentType?.slice(0, 60) ?? null,
        remote: job.remote,
        postedAt: job.postedAt,
        updatedAtSource: job.updatedAtSource,
        deadlineAt: job.deadlineAt,
        descriptionSnippet: job.descriptionSnippet?.slice(0, 2000) ?? null,
        status,
      },
    });

    // Skills are facts about the posting, useful for both search and evidence.
    const parsed = parseJobText(job);
    for (const s of parsed.skills.slice(0, 40)) {
      await prisma.jobSkill.upsert({
        where: { jobPostingId_skill: { jobPostingId: stored.id, skill: s.skill } },
        update: {},
        create: { jobPostingId: stored.id, skill: s.skill, kind: s.kind },
      });
    }

    // Link the raw payload to the company so the provenance walk can reach it.
    await recordFact({
      companyId: company.id,
      key: `job_posting:${stored.id}`,
      value: job.title?.slice(0, 300),
      valueJson: { jobId: stored.id, status, roleCategory: parsed.primary?.signal || null },
      confidenceLevel: "VERIFIED",
      extractorName: "atsIngest",
      evidenceSnippet: `Listed on the company's ${def.label} board as "${job.title}"${job.location ? ` (${job.location})` : ""}.`,
      sourceRecordId: record.id,
    });

    ingested += 1;
  }

  const reconciliation = await reconcileBoardJobs({
    companyId: company.id,
    sourceId: source.id,
    boardJobs: board.jobs,
    boardFetchOk: true,
  });

  if (board.jobs.length > 0) {
    await recordFact({
      companyId: company.id,
      key: "careers_page_active",
      value: "true",
      confidenceLevel: "VERIFIED",
      extractorName: "atsIngest",
      evidenceSnippet: `${board.jobs.length} positions currently listed on ${def.boardUrl(slug)}.`,
    });
  }

  await prisma.company.update({ where: { id: company.id }, data: { lastEnrichedAt: new Date() } });

  logger.info({ provider, slug, company: company.name, ingested, ...reconciliation }, "ATS board ingested");
  return { ok: true, companyId: company.id, companyName: company.name, jobsIngested: ingested, reconciliation };
};

/**
 * Find and ingest a company's board when we only know its name.
 * Returns `{ found:false }` quietly — most companies are not on a public ATS,
 * and that is normal rather than an error.
 */
export const discoverAndIngestAts = async ({ companyId, companyName, providers }) => {
  const existing = companyId
    ? await prisma.atsAccount.findFirst({ where: { companyId, isActive: true } })
    : null;

  // Once a company's board is known, go straight to it.
  if (existing) {
    return ingestAtsBoard({ provider: existing.provider, slug: existing.slug, companyId, companyName });
  }

  const candidates = atsSlugCandidates(companyName);
  if (!candidates.length) return { ok: false, reason: "NO_SLUG_CANDIDATES", found: false };

  const probe = await probeAtsSlug(candidates, providers ? { providers } : {});
  if (!probe.found) return { ok: false, reason: "NO_ATS_ACCOUNT", found: false, attempts: probe.attempts.length };

  // A slug that exists is not proof it is *this* company's board. "haus" is
  // a Berlin beer hall and a US fintech; the probe found the fintech's
  // Greenhouse board and a restaurant was scored as hiring ML engineers in
  // Seattle. The board's own evidence — where its jobs are — has to be
  // consistent with where the company is before a single job is attributed.
  const company = companyId
    ? await prisma.company.findUnique({ where: { id: companyId }, select: { countryCode: true, city: true } })
    : null;
  const fit = boardFitsCompany(probe, company);
  if (!fit.ok) {
    logger.info({ company: companyName, provider: probe.provider, slug: probe.slug, reason: fit.reason }, "ATS board rejected — not this company's");
    if (companyId) {
      await recordFact({
        companyId, key: "ats_board_rejected", value: `${probe.provider}:${probe.slug}`, confidenceLevel: "VERIFIED",
        extractorName: "atsIngest", evidenceSnippet: fit.reason.slice(0, 500),
      });
    }
    return { ok: false, reason: "ATS_BOARD_MISMATCH", found: false, attempts: probe.attempts.length };
  }

  return ingestAtsBoard({ provider: probe.provider, slug: probe.slug, companyId, companyName });
};

/**
 * Words a job location uses for a country that COUNTRY_NAMES does not: the
 * local-language name, the common abbreviation, and the cities that stand in
 * for the country on most boards.
 */
const COUNTRY_ALIASES = {
  DE: ["Deutschland", "Berlin", "München", "Munich", "Hamburg", "Frankfurt", "Köln", "Cologne", "Stuttgart", "Düsseldorf"],
  GB: ["UK", "U.K.", "United Kingdom", "England", "Scotland", "Wales", "London", "Manchester", "Birmingham", "Edinburgh", "Leeds", "Glasgow"],
  US: ["USA", "U.S.", "United States", "New York", "San Francisco", "Seattle", "Austin", "Chicago", "Los Angeles", "Boston", "Denver", "Remote - US"],
  AE: ["UAE", "U.A.E.", "Emirates", "Dubai", "Abu Dhabi", "Sharjah"],
  SA: ["KSA", "Saudi", "Riyadh", "Jeddah", "Dammam", "Khobar"],
  PT: ["Lisboa", "Lisbon", "Porto"],
  QA: ["Doha"], KW: ["Kuwait City"], BH: ["Manama"], OM: ["Muscat"], EG: ["Cairo"],
  FR: ["Paris"], ES: ["España", "Madrid", "Barcelona"], IT: ["Italia", "Milan", "Milano", "Rome", "Roma"],
  NL: ["Nederland", "Amsterdam", "Rotterdam"], IE: ["Dublin"], CH: ["Zürich", "Zurich", "Geneva"], AT: ["Österreich", "Wien", "Vienna"],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a probed board could belong to this company, judged on where its
 * jobs are. Fail-open where there is nothing to judge on: a company with no
 * country, or a board whose jobs carry no locations, is accepted as before.
 * Rejected only when every located job is somewhere else and none is remote.
 */
export const boardFitsCompany = (board, company) => {
  const cc = company?.countryCode?.toUpperCase();
  const located = (board?.jobs || []).filter((j) => j.location);
  if (!cc || located.length === 0) return { ok: true, reason: "no location evidence" };

  const terms = [COUNTRY_NAMES[cc], cc, ...(COUNTRY_ALIASES[cc] || []), company.city].filter(Boolean).map(escapeRe);
  const local = new RegExp(`(?:^|[\\s,(/-])(?:${terms.join("|")})(?:$|[\\s,)/.-])`, "i");
  // A remote posting is only "possibly local" when it names no place. Ashby
  // flags hybrid roles remote while their location still says "Bay Area
  // (Palo Alto)", and one such row let a Berlin beer hall keep a US fintech's
  // board; "Remote - APAC" names a region the company is not in.
  const placeless = (j) => !j.remote ? false
    : !j.location.trim() || (/^(?:remote|anywhere|worldwide|global|hybrid|flexible)\s*$/i.test(j.location.trim()));
  const matches = located.filter((j) => placeless(j) || local.test(j.location));
  if (matches.length > 0) return { ok: true, reason: `${matches.length} of ${located.length} jobs located in ${COUNTRY_NAMES[cc] || cc}` };

  const sample = [...new Set(located.map((j) => j.location))].slice(0, 4).join("; ");
  return {
    ok: false,
    reason: `Board "${board.slug || ""}" lists ${located.length} located jobs and none in ${COUNTRY_NAMES[cc] || cc} (${sample}) — almost certainly a different company with a similar name.`,
  };
};
