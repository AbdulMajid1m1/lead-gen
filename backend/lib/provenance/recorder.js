import prisma from "../../prismaClient.js";
import { hashPayload } from "../../utils/hash.js";
import {
  normalizeCompanyName,
  normalizeDomain,
  phoneMatchKey,
} from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("provenance");

/**
 * Every write that asserts something about a company goes through this module.
 * Nothing else in the codebase is allowed to create an ExtractedFact or a
 * Company, which is how the provenance chain stays unbroken by construction.
 */

const sourceCache = new Map();

/** Get-or-create the Source row for an adapter. */
export const ensureSource = async ({ kind, name, baseUrl = null, attribution = null }) => {
  const cacheKey = `${kind}:${name}`;
  if (sourceCache.has(cacheKey)) return sourceCache.get(cacheKey);

  const source = await prisma.source.upsert({
    where: { kind_name: { kind, name } },
    update: { baseUrl, attribution },
    create: { kind, name, baseUrl, attribution },
  });
  sourceCache.set(cacheKey, source);
  return source;
};

/**
 * Store an immutable raw payload — the root of a provenance chain.
 * Re-fetching identical data returns the existing row instead of duplicating it.
 */
export const recordSourceRecord = async ({ sourceId, externalId = null, url = null, payload }) => {
  const payloadHash = hashPayload(payload);
  return prisma.sourceRecord.upsert({
    where: { sourceId_payloadHash: { sourceId, payloadHash } },
    update: { fetchedAt: new Date() },
    create: { sourceId, externalId, url, payload, payloadHash },
  });
};

/**
 * Resolve an incoming record to a Company, creating one only when no identity
 * key matches. Keys are tried strongest-first — merging two businesses on a
 * shared name would be far worse than keeping two rows for one business, so
 * NAME_CITY only matches when a city is actually known.
 *
 * @returns {Promise<{company, created:boolean, matchedOn:string|null}>}
 */
export const resolveCompany = async ({
  name,
  domain = null,
  phone = null,
  osmId = null,
  atsSlug = null,
  city = null,
  countryCode = null,
  industry = null,
  osmCategory = null,
  description = null,
  discoveredVia = "MANUAL",
}) => {
  const normalizedName = normalizeCompanyName(name);
  if (!normalizedName) throw new Error("resolveCompany requires a usable company name");

  const normDomain = normalizeDomain(domain);
  const phoneKey = phoneMatchKey(phone);

  // Strongest → weakest. A domain is near-proof; a name+city is a guess we only
  // accept because the alternative is a flood of near-duplicates.
  const candidateKeys = [
    normDomain ? { kind: "DOMAIN", value: normDomain } : null,
    osmId ? { kind: "OSM_ID", value: String(osmId) } : null,
    atsSlug ? { kind: "ATS_SLUG", value: String(atsSlug).toLowerCase() } : null,
    phoneKey ? { kind: "PHONE", value: phoneKey } : null,
    city ? { kind: "NAME_CITY", value: `${normalizedName}|${String(city).toLowerCase()}` } : null,
  ].filter(Boolean);

  let company = null;
  let matchedOn = null;
  for (const key of candidateKeys) {
    const hit = await prisma.dedupeKey.findUnique({
      where: { kind_value: { kind: key.kind, value: key.value } },
      include: { company: true },
    });
    if (hit?.company) {
      company = hit.company;
      matchedOn = key.kind;
      break;
    }
  }

  let created = false;
  if (!company) {
    company = await prisma.company.create({
      data: {
        name: String(name).trim().slice(0, 255),
        normalizedName,
        industry: industry?.slice(0, 100) ?? null,
        osmCategory: osmCategory?.slice(0, 100) ?? null,
        description: description ?? null,
        city: city?.slice(0, 120) ?? null,
        countryCode: countryCode?.slice(0, 2)?.toUpperCase() ?? null,
      },
    });
    created = true;
  } else {
    // Enrich rather than overwrite: a later source may know the city or
    // industry that the first one did not.
    const patch = {};
    if (!company.industry && industry) patch.industry = industry.slice(0, 100);
    if (!company.osmCategory && osmCategory) patch.osmCategory = osmCategory.slice(0, 100);
    if (!company.city && city) patch.city = city.slice(0, 120);
    if (!company.countryCode && countryCode) patch.countryCode = countryCode.slice(0, 2).toUpperCase();
    if (!company.description && description) patch.description = description;
    patch.lastSeenAt = new Date();
    company = await prisma.company.update({ where: { id: company.id }, data: patch });

    // Record the alternative spelling so future lookups hit on it directly.
    if (company.normalizedName !== normalizedName) {
      await prisma.companyAlias.upsert({
        where: { companyId_alias: { companyId: company.id, alias: String(name).slice(0, 255) } },
        update: {},
        create: { companyId: company.id, alias: String(name).slice(0, 255) },
      });
    }
  }

  // Claim every identity key we now know for this company. `create`-on-conflict
  // skip keeps a key pointing at whichever company claimed it first.
  for (const key of candidateKeys) {
    await prisma.dedupeKey.upsert({
      where: { kind_value: { kind: key.kind, value: key.value } },
      update: {},
      create: { companyId: company.id, kind: key.kind, value: key.value },
    });
  }

  if (normDomain) {
    await prisma.companyDomain.upsert({
      where: { domain: normDomain },
      update: {},
      create: { companyId: company.id, domain: normDomain, discoveredVia, isPrimary: true },
    });
  }

  return { company, created, matchedOn };
};

/**
 * Assert a fact about a company, attributed to the record that proves it.
 * Same (company, key, sourceRecord) → update, so re-extraction is idempotent.
 */
export const recordFact = async ({
  companyId,
  key,
  value = null,
  valueJson = null,
  confidenceLevel = "DETECTED",
  extractorName,
  extractorVersion = "1",
  evidenceSnippet = null,
  sourceRecordId = null,
  crawlResultId = null,
}) => {
  const data = {
    companyId,
    key: key.slice(0, 100),
    value: value === null || value === undefined ? null : String(value).slice(0, 2000),
    valueJson,
    confidenceLevel,
    extractorName,
    extractorVersion,
    evidenceSnippet: evidenceSnippet ? String(evidenceSnippet).slice(0, 1000) : null,
    sourceRecordId,
    crawlResultId,
    extractedAt: new Date(),
  };

  // The unique index treats NULL sourceRecordId as distinct in Postgres, so a
  // fact without a source record is looked up manually to stay idempotent.
  if (sourceRecordId) {
    return prisma.extractedFact.upsert({
      where: { companyId_key_sourceRecordId: { companyId, key: data.key, sourceRecordId } },
      update: data,
      create: data,
    });
  }

  const existing = await prisma.extractedFact.findFirst({
    where: { companyId, key: data.key, sourceRecordId: null },
  });
  return existing
    ? prisma.extractedFact.update({ where: { id: existing.id }, data })
    : prisma.extractedFact.create({ data });
};

/** Store a contact, honouring the suppression list at write time. */
export const recordContact = async ({
  companyId,
  kind,
  value,
  roleHint = null,
  confidenceLevel = "DETECTED",
  sourceRecordId = null,
}) => {
  const trimmed = String(value).slice(0, 500);
  const suppressed = await isSuppressed(kind, trimmed);
  if (suppressed) {
    logger.debug({ companyId, kind }, "contact suppressed at write time");
  }
  return prisma.contact.upsert({
    where: { companyId_kind_value: { companyId, kind, value: trimmed } },
    update: { roleHint, confidenceLevel, sourceRecordId, isSuppressed: suppressed },
    create: { companyId, kind, value: trimmed, roleHint, confidenceLevel, sourceRecordId, isSuppressed: suppressed },
  });
};

const SUPPRESSION_KIND_FOR_CONTACT = { EMAIL: "EMAIL", PHONE: "PHONE" };

export const isSuppressed = async (contactKind, value) => {
  const kind = SUPPRESSION_KIND_FOR_CONTACT[contactKind];
  if (!kind) return false;
  const hit = await prisma.suppressionEntry.findUnique({
    where: { kind_value: { kind, value: value.toLowerCase() } },
  });
  if (hit) return true;
  if (contactKind === "EMAIL") {
    const domain = value.split("@")[1];
    if (!domain) return false;
    const domainHit = await prisma.suppressionEntry.findUnique({
      where: { kind_value: { kind: "DOMAIN", value: domain.toLowerCase() } },
    });
    return Boolean(domainHit);
  }
  return false;
};

export const _clearSourceCache = () => sourceCache.clear();
