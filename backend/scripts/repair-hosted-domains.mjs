#!/usr/bin/env node
/**
 * One-off repair for companies whose recorded "website" is a hosted platform
 * page (lib/verify/hostedPlatforms.js) — an ordering marketplace, a booking
 * service, a social profile or a link page.
 *
 * Before the platform registry existed, an OpenStreetMap website tag such as
 * `bombay-bistro-larmar.menufy.com` was reduced to `menufy.com`, stored as the
 * company's domain, crawled, and everything on the platform's homepage was
 * recorded as fact about the business: its description, its `info@` address,
 * its social profiles, its technology stack and its "people". This undoes
 * that for every affected company and re-scores it as what it is — a
 * business with no website of its own.
 *
 *   node scripts/repair-hosted-domains.mjs            # dry run
 *   node scripts/repair-hosted-domains.mjs --apply
 *
 * Also reclassifies the inbound messages that were help-desk or receipt
 * auto-replies (kind REPLY → AUTO_REPLY) and puts their leads back to the
 * state they were in before the machine "answered".
 */
import prisma from "../prismaClient.js";
import { hostedPlatformFor, emailBelongsToPlatform } from "../lib/verify/hostedPlatforms.js";
import { classifyAutoReply } from "../lib/outreach/autoReply.js";
import { recordFact } from "../lib/provenance/recorder.js";
import { evaluateCompanySignals } from "../lib/signals/signalEngine.js";
import { scoreCompany, setStatus } from "../lib/scoring/scoreEngine.js";
import { normalizeCompanyName } from "../utils/normalize.js";

const apply = process.argv.includes("--apply");
const say = (...a) => console.log(...a);

// ─── 1. Companies whose domain is a platform ─────────────────────────────────
const domains = await prisma.companyDomain.findMany({
  include: { company: { include: { domains: true, facts: true, contacts: true, people: true, leads: { include: { threads: true } } } } },
});
// The platform itself, found as an employer through a job board, owns its
// own domain — Checkatrade at checkatrade.com is not a tradesman hosted there.
const isThePlatformItself = (company, domain) =>
  normalizeCompanyName(company.name).replace(/\s+/g, "").startsWith(domain.split(".")[0].replace(/-/g, ""));
const affected = domains.filter((d) => hostedPlatformFor(d.domain) && !isThePlatformItself(d.company, d.domain));

say(`Companies with a hosted-platform domain: ${affected.length}`);
for (const d of affected) {
  const c = d.company;
  const listing = c.facts.find((f) => f.key === "osm_website")?.value || null;
  say(`  ${d.domain.padEnd(16)} ${c.name} (${c.city ?? "?"}/${c.countryCode ?? "?"}) lead=${c.leads[0]?.status ?? "-"} listing=${listing ?? "-"} facts=${c.facts.length} contacts=${c.contacts.length} people=${c.people.length}`);
}

if (apply) {
  for (const d of affected) {
    const c = d.company;
    const platform = hostedPlatformFor(d.domain);
    const listing = c.facts.find((f) => f.key === "osm_website")?.value || `https://${d.domain}/`;

    // Everything the crawl of the platform's homepage wrote.
    const crawlSource = await prisma.source.findFirst({ where: { kind: "WEBSITE_CRAWL" } });
    const crawlRecordIds = crawlSource
      ? (await prisma.sourceRecord.findMany({ where: { sourceId: crawlSource.id, OR: [{ facts: { some: { companyId: c.id } } }, { contacts: { some: { companyId: c.id } } }] }, select: { id: true } })).map((r) => r.id)
      : [];

    await prisma.technologyDetection.deleteMany({ where: { companyId: c.id } });
    await prisma.websiteAudit.deleteMany({ where: { companyId: c.id } });
    await prisma.companyPerson.deleteMany({ where: { companyId: c.id } });
    await prisma.extractedFact.deleteMany({
      where: { companyId: c.id, OR: [{ extractorName: { in: ["websiteIngest", "domainResolver"] } }, { sourceRecordId: { in: crawlRecordIds } }, { key: { in: ["domain_identity_weak", "domain_identity_rejected", "resolved_domain"] } }] },
    });
    await prisma.contact.deleteMany({
      where: { companyId: c.id, OR: [{ sourceRecordId: { in: crawlRecordIds } }, { kind: "EMAIL", value: { endsWith: `@${d.domain}` } }, { kind: "SOCIAL", value: { contains: `/${d.domain.split(".")[0]}` } }] },
    });
    await prisma.dedupeKey.deleteMany({ where: { kind: "DOMAIN", value: d.domain, companyId: c.id } });
    await prisma.companyDomain.delete({ where: { id: d.id } });
    await prisma.company.update({ where: { id: c.id }, data: { description: null, lastCrawledAt: null } });

    // What the listing actually says: no website of its own, a page on a platform.
    const osmRecord = c.facts.find((f) => f.key === "osm_website")?.sourceRecordId ?? null;
    await recordFact({
      companyId: c.id, key: "osm_no_website_tag", value: "true", confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
      evidenceSnippet: `The OpenStreetMap listing for ${c.name} gives only a ${platform.label} on ${platform.domain} (${listing}) — no website of its own.`,
      sourceRecordId: osmRecord,
    });
    await recordFact({
      companyId: c.id, key: "hosted_listing", value: listing.slice(0, 500), valueJson: { platform: platform.domain, kind: platform.kind },
      confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
      evidenceSnippet: `OpenStreetMap's website tag points at a ${platform.label} on ${platform.domain}.`,
      sourceRecordId: osmRecord,
    });
    if (platform.kind === "SOCIAL" && /facebook|instagram/i.test(platform.domain)) {
      const network = /instagram/i.test(platform.domain) ? "INSTAGRAM" : "FACEBOOK";
      await prisma.contact.upsert({
        where: { companyId_kind_value: { companyId: c.id, kind: "SOCIAL", value: listing.slice(0, 500) } },
        update: {}, create: { companyId: c.id, kind: "SOCIAL", value: listing.slice(0, 500), roleHint: network, confidenceLevel: "DETECTED" },
      });
    }

    // Any thread that went to the platform's inbox is over.
    for (const lead of c.leads) {
      for (const t of lead.threads) {
        if (!emailBelongsToPlatform(t.recipientEmail)) continue;
        await prisma.outreachThread.update({ where: { id: t.id }, data: { status: "CLOSED", nextFollowUpAt: null } });
        await prisma.suppressionEntry.upsert({
          where: { kind_value: { kind: "EMAIL", value: t.recipientEmail.toLowerCase() } },
          create: { kind: "EMAIL", value: t.recipientEmail.toLowerCase(), reason: `Belongs to ${platform.domain}, a ${platform.label} — not the business's own address.` },
          update: {},
        });
      }
    }

    await evaluateCompanySignals(c.id);
    const scored = await scoreCompany(c.id);
    say(`  repaired ${c.name}: ${scored.skipped ? `skipped (${scored.reason})` : `re-scored ${scored.score ?? ""} ${scored.lead?.status ?? ""}`}`);
  }
}

// ─── 1b. Businesses found closed while investigating ────────────────────────
// Recorded the same way the Google Places cross-check records it, with the
// source in the evidence, so the signal engine raises BUSINESS_CLOSED and the
// scoring engine moves the lead to DO_NOT_CONTACT through the normal path.
const KNOWN_CLOSED = [
  {
    name: "Bombay Bistro", city: "Austin",
    evidence: "Yelp lists Bombay Bistro, 4200 S Lamar Blvd, Austin TX as CLOSED (listing updated August 2026) — https://www.yelp.com/biz/bombay-bistro-austin-3. Checked 2026-09-02.",
  },
];
for (const closed of KNOWN_CLOSED) {
  const company = await prisma.company.findFirst({ where: { name: closed.name, city: closed.city }, include: { leads: true } });
  if (!company) { say(`\nKnown-closed: ${closed.name} (${closed.city}) not in this database.`); continue; }
  say(`\nKnown-closed: ${closed.name} (${closed.city}) lead=${company.leads[0]?.status ?? "-"}`);
  if (!apply) continue;
  await recordFact({
    companyId: company.id, key: "business_closed_permanently", value: "CLOSED_PERMANENTLY",
    confidenceLevel: "VERIFIED", extractorName: "manualResearch", evidenceSnippet: closed.evidence.slice(0, 1000),
  });
  await evaluateCompanySignals(company.id);
  const scored = await scoreCompany(company.id);
  say(`  ${closed.name}: ${scored.skipped ? `skipped (${scored.reason})` : "scored"} — lead now ${(await prisma.lead.findUnique({ where: { companyId: company.id } }))?.status}`);
}

// ─── 2. Inbound messages that were auto-replies ─────────────────────────────
const inbound = await prisma.outreachMessage.findMany({
  where: { direction: "INBOUND", kind: "REPLY" },
  include: { thread: { include: { lead: { select: { id: true, status: true, company: { select: { name: true, countryCode: true, domains: { select: { domain: true }, take: 1 } } } } } } } },
});
const autos = inbound.map((m) => ({
  m,
  auto: classifyAutoReply({ from: m.fromAddress, subject: m.subject, body: m.body, companyDomain: m.thread.lead.company.domains[0]?.domain || null }),
})).filter((x) => x.auto.isAutoReply);

say(`\nInbound "replies" that were machine answers: ${autos.length}`);
for (const { m, auto } of autos) {
  say(`  ${m.thread.lead.company.name}: ${auto.kind} from ${m.fromAddress} — "${m.subject}" (lead ${m.thread.lead.status}, thread ${m.thread.status})`);
}

if (apply) {
  const touchedLeads = new Map();
  for (const { m, auto } of autos) {
    await prisma.outreachMessage.update({ where: { id: m.id }, data: { kind: "AUTO_REPLY", body: `[${auto.reason}]\n\n${m.body}`.slice(0, 8000) } });
    const lead = m.thread.lead;
    if (auto.platform) {
      await prisma.outreachThread.update({ where: { id: m.thread.id }, data: { status: "CLOSED", nextFollowUpAt: null } });
    } else if (m.thread.status === "REPLIED") {
      // Nobody has read it: the thread is still waiting. No follow-up is
      // rescheduled here — the human decides whether to chase.
      await prisma.outreachThread.update({ where: { id: m.thread.id }, data: { status: "AWAITING_REPLY", repliedAt: null } });
    }
    if (lead.status === "REPLIED" && !touchedLeads.has(lead.id)) {
      touchedLeads.set(lead.id, true);
      await setStatus(lead.id, "CONTACTED", `${auto.reason} The earlier "reply" was automatic — nobody at ${lead.company.name} has answered yet.`);
    }
  }
  say(`  reclassified ${autos.length} message(s), reset ${touchedLeads.size} lead(s) from REPLIED to CONTACTED.`);
}

if (!apply) say("\nDry run — nothing changed. Re-run with --apply.");
await prisma.$disconnect();
