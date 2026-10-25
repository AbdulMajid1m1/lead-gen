import prisma from "../../prismaClient.js";
import {
  ensureSource, recordSourceRecord, resolveCompany, recordContact, recordFact,
} from "../provenance/recorder.js";
import { normalizeCompanyName, normalizeDomain, normalizeCityLabel } from "../../utils/normalize.js";
import { normaliseCountryCode, COUNTRY_NAMES } from "../../utils/countries.js";
import { classifySeniority } from "../extract/people.js";
import { isRoleAddress } from "../outreach/sendPolicy.js";
import { classifyExcludedBusiness, exclusionNote } from "../qualify/excludedCategories.js";
import { toActor } from "../outreach/attribution.js";
import { log } from "../../utils/logger.js";

const logger = log("lead-import");

/**
 * Leads a person brings in themselves — a spreadsheet of companies they met,
 * were referred to, or researched by hand.
 *
 * They pass through the same provenance path as everything the crawlers find
 * (one immutable SourceRecord per row, companies resolved on their identity
 * keys so an upload enriches a company already in the book instead of
 * duplicating it), and the same hard stops: an excluded trade or a suppressed
 * company is refused here exactly as it would be at discovery.
 *
 * What differs is ownership. An uploaded lead is IMPORTED — the scoring engine
 * leaves it alone — and normally MANUAL, so nothing is sent to it
 * automatically until the person who uploaded it says so.
 */

export const IMPORT_MAX_ROWS = 500;
const SCORE_VERSION = "import-1";
const UPLOAD_SOURCE = { kind: "MANUAL", name: "Lead upload", attribution: "Uploaded by a LeadSignal user." };
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

const COUNTRY_ALIASES = {
  UAE: "AE", "U.A.E": "AE", "U.A.E.": "AE", EMIRATES: "AE", DUBAI: "AE", "ABU DHABI": "AE",
  KSA: "SA", UK: "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB", BRITAIN: "GB",
  USA: "US", "U.S.": "US", "U.S.A.": "US", "UNITED STATES OF AMERICA": "US", AMERICA: "US",
  TURKEY: "TR",
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(COUNTRY_NAMES).map(([code, name]) => [name.toUpperCase(), code]));

/** "AE", "uae", "United Arab Emirates" → "AE"; anything unrecognised → null. */
export const countryCodeFromInput = (value) => {
  // Aliases first: "UK" has the shape of a code but is not the ISO one (GB).
  const key = String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return COUNTRY_ALIASES[key] || NAME_TO_CODE[key] || normaliseCountryCode(value);
};

/**
 * "20-50", "11–50 staff", "about 120", "200+" → a size bucket, read from the
 * middle of a range. EU thresholds, the same ones the rest of the book uses.
 */
export const sizeBucketFromInput = (value) => {
  const numbers = String(value ?? "").replace(/,/g, "").match(/\d+/g)?.map(Number) || [];
  if (!numbers.length) return null;
  const n = numbers.length > 1 ? (numbers[0] + numbers[1]) / 2 : numbers[0];
  if (n < 10) return "MICRO";
  if (n < 50) return "SMALL";
  if (n < 250) return "MEDIUM";
  return "LARGE";
};

/** Every address in a cell: "a@x.com; b@x.com" or "Jane <jane@x.com>". */
export const emailsFromInput = (value) => [...new Set(
  String(value ?? "")
    .split(/[;,\s]+/)
    .map((s) => s.replace(/^.*</, "").replace(/>.*$/, "").replace(/^mailto:/i, "").trim().toLowerCase())
    .filter((e) => EMAIL_RE.test(e)),
)];

/** Every number in a cell, separated by ";", "/" or a comma before a "+". */
export const phonesFromInput = (value) => [...new Set(
  String(value ?? "")
    .split(/[;/]|,(?=\s*\+)/)
    .map((s) => s.trim())
    .filter((p) => p.replace(/\D/g, "").length >= 7),
)];

const text = (value, max) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Validate and tidy one uploaded row. Pure, so the rules are unit-tested.
 * Only the company name is required; every other column is optional.
 *
 * @returns {{ ok: true, row: object, warnings: string[] } | { ok: false, reason: string }}
 */
export const normalizeImportRow = (raw = {}) => {
  const company = text(raw.company, 255);
  if (!company || company.length < 2 || !normalizeCompanyName(company)) {
    return { ok: false, reason: "No company name." };
  }
  const warnings = [];

  const website = text(raw.website, 300);
  const domain = website ? normalizeDomain(website) : null;
  if (website && !domain) warnings.push(`"${website}" is not a website address, so it was left out.`);

  const emails = emailsFromInput(raw.email);
  if (text(raw.email, 500) && !emails.length) warnings.push(`"${text(raw.email, 80)}" is not an email address.`);

  const countryInput = text(raw.country, 80);
  const countryCode = countryInput ? countryCodeFromInput(countryInput) : null;
  if (countryInput && !countryCode) warnings.push(`Country "${countryInput}" was not recognised.`);

  return {
    ok: true,
    warnings,
    row: {
      company,
      website: domain ? website : null,
      domain,
      emails,
      phones: phonesFromInput(raw.phone),
      contactName: text(raw.contactName, 200),
      contactTitle: text(raw.contactTitle, 200),
      city: normalizeCityLabel(text(raw.city, 120)) || null,
      countryCode,
      industry: text(raw.industry, 100),
      sizeBucket: sizeBucketFromInput(raw.size),
      notes: text(raw.notes, 2000),
      hook: text(raw.hook, 500),
      sourceUrl: text(raw.sourceUrl, 1000),
    },
  };
};

/** Two rows in one file that name the same company. */
const rowKey = (row) => row.domain || `${normalizeCompanyName(row.company)}|${(row.city || "").toLowerCase()}`;

const appendNote = (existing, note) => {
  if (!note) return existing ?? null;
  if (existing?.includes(note)) return existing;
  return (existing ? `${existing}\n${note}` : note).slice(-2000);
};

const isSuppressedCompany = async (row) => {
  const hit = await prisma.suppressionEntry.findFirst({
    where: {
      OR: [
        { kind: "COMPANY", value: normalizeCompanyName(row.company) },
        ...(row.domain ? [{ kind: "DOMAIN", value: row.domain }] : []),
      ],
    },
  });
  return hit ? `${row.company} is on the suppression list (${hit.reason || hit.kind.toLowerCase()}).` : null;
};

/**
 * Bring a set of rows into the book.
 *
 * @param {object} input
 * @param {object[]} input.rows      raw rows: company, website, email, phone,
 *   contactName, contactTitle, city, country, industry, size, notes, hook, sourceUrl
 * @param {"MANUAL"|"AUTO"} [input.sendMode]  MANUAL by default — see the file header
 * @param {string|null} [input.productId]     the SaaS Promoter product these leads are for
 * @param {string|null} [input.service]       agency service when no product is given
 * @param {string|null} [input.label]         a name for this upload, shown on the run
 * @param {object|null} [input.actor]         the console user doing the upload
 */
export const importLeads = async ({
  rows, sendMode = "MANUAL", productId = null, service = null, label = null, actor = null,
}) => {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Nothing to import.");
  if (rows.length > IMPORT_MAX_ROWS) throw new Error(`An upload is capped at ${IMPORT_MAX_ROWS} rows.`);

  const who = toActor(actor)?.name || "a LeadSignal user";
  if (productId) {
    const product = await prisma.promotedProduct.findUnique({ where: { id: productId }, select: { status: true } });
    if (!product || product.status === "ARCHIVED") throw new Error("That product does not exist or is archived.");
  }

  const source = await ensureSource(UPLOAD_SOURCE);
  // The upload is a run of its own: it ties the leads to the product they are
  // for (the same way a discovery run does) and keeps a record of who brought
  // them in and when.
  const run = await prisma.discoveryRun.create({
    data: {
      trigger: "MANUAL", status: "RUNNING", promotedProductId: productId,
      plan: { kind: "IMPORT", label, rows: rows.length, sendMode, uploadedBy: who },
      startedAt: new Date(),
    },
  });

  const results = [];
  const seen = new Set();
  const opportunity = productId ? "SAAS_PRODUCT" : (service || "WEBSITE_DEV");
  const uploadedNote = `Uploaded by ${who}${sendMode === "MANUAL" ? " and set to Manual: nothing is sent to it automatically." : "."}`;

  for (const [index, raw] of rows.entries()) {
    const line = index + 1;
    const parsed = normalizeImportRow(raw);
    if (!parsed.ok) { results.push({ line, company: text(raw?.company, 120), outcome: "SKIPPED", reason: parsed.reason }); continue; }
    const { row, warnings } = parsed;

    const key = rowKey(row);
    if (seen.has(key)) { results.push({ line, company: row.company, outcome: "SKIPPED", reason: "Same company as an earlier row in this upload." }); continue; }
    seen.add(key);

    const excluded = classifyExcludedBusiness({ name: row.company, industry: row.industry });
    if (excluded) { results.push({ line, company: row.company, outcome: "SKIPPED", reason: exclusionNote(excluded) }); continue; }
    const suppressed = await isSuppressedCompany(row);
    if (suppressed) { results.push({ line, company: row.company, outcome: "SKIPPED", reason: suppressed }); continue; }

    try {
      const record = await recordSourceRecord({
        sourceId: source.id,
        url: row.sourceUrl || (row.domain ? `https://${row.domain}` : null),
        payload: { row, uploadedBy: who },
      });
      const { company } = await resolveCompany({
        name: row.company, domain: row.domain, phone: row.phones[0] || null,
        city: row.city, countryCode: row.countryCode, industry: row.industry, discoveredVia: "MANUAL",
      });
      if (row.sizeBucket && company.sizeBucket === "UNKNOWN") {
        await prisma.company.update({ where: { id: company.id }, data: { sizeBucket: row.sizeBucket } });
      }

      for (const email of row.emails) {
        await recordContact({
          companyId: company.id, kind: "EMAIL", value: email,
          roleHint: isRoleAddress({ value: email }) ? "ROLE" : "PERSONAL",
          confidenceLevel: "DETECTED", sourceRecordId: record.id,
        });
      }
      for (const phone of row.phones) {
        await recordContact({ companyId: company.id, kind: "PHONE", value: phone, confidenceLevel: "DETECTED", sourceRecordId: record.id });
      }
      if (row.contactName) {
        // The person's own address only when the row gives exactly one email
        // and it is not a shared inbox — a name pinned to info@ is a greeting
        // nobody reads.
        const personal = row.emails.length === 1 && !isRoleAddress({ value: row.emails[0] }) ? row.emails[0] : null;
        const person = {
          title: row.contactTitle, seniority: classifySeniority(row.contactTitle),
          email: personal, observedOnUrl: row.sourceUrl, confidenceLevel: "DETECTED", sourceRecordId: record.id,
        };
        await prisma.companyPerson.upsert({
          where: { companyId_fullName: { companyId: company.id, fullName: row.contactName } },
          update: person,
          create: { companyId: company.id, fullName: row.contactName, ...person },
        });
      }
      if (row.hook) {
        await recordFact({
          companyId: company.id, key: "upload_hook", value: row.hook, evidenceSnippet: row.sourceUrl,
          confidenceLevel: "DETECTED", extractorName: "lead-upload", sourceRecordId: record.id,
        });
      }

      const existing = await prisma.lead.findUnique({ where: { companyId: company.id } });
      if (existing) {
        const data = { notes: appendNote(existing.notes, row.notes) };
        // An upload can take a lead over but never hands one back: switching a
        // MANUAL lead to AUTO is a decision made on the lead, not in bulk.
        if (sendMode === "MANUAL" && existing.sendMode !== "MANUAL") data.sendMode = "MANUAL";
        if (!existing.discoveryRunId) data.discoveryRunId = run.id;
        // ARCHIVED is the engine's own "below the bar"; a person uploading the
        // company has just overruled it. Human verdicts (do not contact,
        // disqualified, not interested) are kept and reported back.
        if (existing.status === "ARCHIVED") data.status = "NEW";
        await prisma.lead.update({ where: { id: existing.id }, data });
        await prisma.leadStatusHistory.create({
          data: {
            leadId: existing.id, fromStatus: existing.status, toStatus: data.status || existing.status,
            note: `Uploaded again by ${who}${data.sendMode ? " and set to Manual." : "."}`,
          },
        });
        const kept = ["DO_NOT_CONTACT", "DISQUALIFIED", "NOT_INTERESTED"].includes(existing.status);
        results.push({
          line, company: row.company, leadId: existing.id, outcome: "UPDATED",
          warnings: kept ? [...warnings, `Already in the book as ${existing.status.toLowerCase().replace(/_/g, " ")} — kept that way.`] : warnings,
        });
        continue;
      }

      const reachability = row.emails.length ? 15 : row.phones.length ? 10 : 0;
      const base = 40;
      const fit = row.hook ? 5 : 0;
      const score = Math.min(100, base + reachability + fit);
      const lead = await prisma.lead.create({
        data: {
          companyId: company.id,
          type: productId ? "DIGITAL_GAP" : "NEW_BUSINESS",
          primaryOpportunity: opportunity,
          score,
          scoreBreakdown: {
            version: SCORE_VERSION,
            categories: { opportunity: base, freshness: 0, reachability, fit },
            caps: { opportunity: 50, freshness: 25, reachability: 15, fit: 10 },
            signals: [],
            uploaded: { by: who, at: new Date().toISOString() },
            total: score,
            scoredAt: new Date().toISOString(),
          },
          freshnessScore: 0,
          newestEvidenceAt: new Date(),
          status: "NEW",
          sendMode,
          origin: "IMPORTED",
          notes: row.notes,
          discoveryRunId: run.id,
        },
      });
      await prisma.leadOpportunity.create({
        data: { leadId: lead.id, service: opportunity, points: base, rank: 1, rationale: "Uploaded by a person who chose to pursue this company." },
      });
      await prisma.leadReason.createMany({
        data: [
          ...(row.hook ? [{ text: row.hook, confidenceLevel: "DETECTED" }] : []),
          { text: uploadedNote, confidenceLevel: "VERIFIED" },
        ].map((r, i) => ({ leadId: lead.id, rank: i + 1, text: r.text.slice(0, 500), confidenceLevel: r.confidenceLevel })),
      });
      await prisma.leadStatusHistory.create({ data: { leadId: lead.id, toStatus: "NEW", note: uploadedNote } });
      results.push({ line, company: row.company, leadId: lead.id, outcome: "CREATED", warnings });
    } catch (err) {
      logger.warn({ line, err: err.message }, "upload row could not be saved");
      results.push({ line, company: row.company, outcome: "SKIPPED", reason: `Could not be saved: ${err.message.slice(0, 200)}` });
    }
  }

  const created = results.filter((r) => r.outcome === "CREATED").length;
  const updated = results.filter((r) => r.outcome === "UPDATED").length;
  const skipped = results.filter((r) => r.outcome === "SKIPPED").length;
  await prisma.discoveryRun.update({
    where: { id: run.id },
    data: {
      status: created + updated > 0 ? "SUCCEEDED" : "PARTIAL",
      finishedAt: new Date(),
      stats: { companiesFound: created + updated, leadsCreated: created, updated, skipped, errors: 0 },
    },
  });
  logger.info({ runId: run.id, created, updated, skipped, by: who }, "lead upload finished");
  return { runId: run.id, created, updated, skipped, results };
};
