/**
 * Run the SaaS Promoter's AI stages from an assistant session instead of an API.
 *
 * Every AI stage of the promoter pipeline — reading the product's site, drafting
 * the ICP, finding companies, writing the emails — currently returns nothing,
 * because the provider account has no credit. This script is the seam that lets
 * a person or an assistant do that work by hand and put the result in the
 * database: each `export-*` subcommand emits exactly what the model would have
 * been given, and each `import-*` subcommand takes back what the model would
 * have produced.
 *
 * Nothing that comes back in is trusted more than the model's own output would
 * have been. An imported profile's sourceUrls go through keepOnlyFetchedSources
 * against the pages we actually crawled, so a price attributed to a page nobody
 * read is stored with no source at all. An imported ICP goes through
 * normaliseIcp and still lands in ICP_REVIEW with icpApprovedAt untouched — the
 * human gate is not something a script may walk through on the operator's
 * behalf, so passing it is its own visible command. Imported companies are
 * written as AiCandidate rows and re-crawled, re-verified and re-scored by the
 * ordinary run, and one citing a page the researcher never reported opening is
 * stored REJECTED_UNCITED. Imported emails are re-checked against their lead's
 * own facts with bodyIsGrounded, and a body naming a phone number, address or
 * link the facts do not contain is rejected whoever wrote it.
 *
 * That last point is the whole design: a confident human author is exactly as
 * capable of inventing a fact as a confident model, and the guards exist for the
 * invention, not for the author.
 *
 * Usage:
 *   node scripts/promoter-assist.mjs export-pages   --product <id|url> [--out f.json] [--dry-run]
 *   node scripts/promoter-assist.mjs import-profile --file profile.json [--dry-run]
 *   node scripts/promoter-assist.mjs approve-icp    --product <id> [--dry-run]
 *   node scripts/promoter-assist.mjs export-icp     --product <id> [--out f.txt]
 *   node scripts/promoter-assist.mjs import-leads   --file candidates.json [--dry-run]
 *   node scripts/promoter-assist.mjs export-compose --run <runId> [--product <id>] [--out f.json]
 *   node scripts/promoter-assist.mjs import-drafts  --file drafts.json [--dry-run]
 *   node scripts/promoter-assist.mjs status         --product <id>
 *
 * Every import reads `--file` or `--stdin`; `--stdin` exists so a file can be
 * piped into the container over ssh without needing a writable path inside it.
 *
 * File shapes:
 *
 *   import-profile — the PRODUCT_RESEARCH_SCHEMA fields plus an ICP:
 *   {
 *     "productId": "…", "researcher": "agent:claude-fable-5",
 *     "name": "…", "summary": "…", "category": "HR management software",
 *     "features":        [{ "value": "…", "sourceUrl": "https://…" }],
 *     "pricing":         [{ "plan": "Pro", "price": "$49/mo", "capacity": "up to 50 employees", "sourceUrl": "https://…" }],
 *     "differentiators": [{ "value": "…", "sourceUrl": "https://…" }],
 *     "proofPoints":     [{ "value": "…", "sourceUrl": "https://…" }],
 *     "competitors":     [{ "value": "…", "sourceUrl": "https://…" }],
 *     "geographyCues":   [{ "value": "…", "sourceUrl": "https://…" }],
 *     "pitchAngle": "…", "proofLink": "https://…", "senderContext": "…",
 *     "icp": { … PRODUCT_ICP_SCHEMA … }
 *   }
 *
 *   import-leads — the same candidate shape import-candidates.mjs documents:
 *   {
 *     "productId": "…", "researcher": "agent:claude-fable-5",
 *     "fetchedUrls": ["https://…"],
 *     "candidates": [{
 *       "name": "…", "nameLocal": "…", "website": "https://…", "city": "Doha",
 *       "industryGuess": "travel agency", "whyMatch": "…",
 *       "matchConfidence": "HIGH|MEDIUM|LOW",
 *       "email": "…", "phone": "…", "whatsapp": "…", "addressText": "…",
 *       "sourceUrls": ["https://…"],
 *       "detailSources": { "email": "https://…", "phone": "https://…" }
 *     }]
 *   }
 *
 *   import-drafts — one email per lead exported by export-compose:
 *   {
 *     "productId": "…", "researcher": "agent:claude-fable-5", "runId": "…",
 *     "drafts": [{ "leadId": "…", "subject": "…", "body": "…",
 *                  "aboutCompany": "…", "factIdsUsed": [1, 4] }]
 *   }
 */
import { readFile, writeFile } from "node:fs/promises";
import { stdin } from "node:process";
import prisma from "../prismaClient.js";
import {
  createPromotedProduct, getPromotedProduct, approveIcp,
} from "../lib/promoter/service.js";
import {
  researchProduct, keepOnlyFetchedSources, normalizeProductUrl,
} from "../lib/promoter/productResearch.js";
import { normaliseIcp, icpIsUsable, icpToParsedQuery } from "../lib/promoter/icp.js";
import { gatherFacts, bodyIsGrounded } from "../lib/research/compose.js";
import { buildProductBlock, PROMPT_VERSION } from "../lib/research/prompts.js";
import { buildPromotePlan } from "../lib/nlquery/planner.js";
import { createDiscoveryRun, startDiscoveryRun } from "../lib/discovery/runner.js";
import { ensureSource, recordSourceRecord } from "../lib/provenance/recorder.js";
import { normalizeCompanyName } from "../utils/normalize.js";

/** VarChar limits from promoter.prisma. Writing past one is a 500, not a truncation. */
const LIMITS = {
  url: 300, name: 160, summary: 2000, category: 120,
  pitchAngle: 400, proofLink: 300, senderContext: 400,
  model: 60, promptVersion: 20,
};

/** The Json columns have no width, but a runaway string in one is still a bug. */
const JSON_VALUE = 500;

/** Same page budget the prompt builder gives the model, so the export matches it. */
const PAGE_TEXT_CHARS = 6_000;

const CLAIM_FIELDS = [
  ["email", "EMAIL", "email"],
  ["phone", "PHONE", "phone"],
  ["whatsapp", "WHATSAPP", "whatsapp"],
  ["addressText", "ADDRESS", "address"],
  ["website", "WEBSITE", "website"],
];

/** Leads that may still be written to. Matches compose.js's own filter. */
const CONTACTABLE = { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT", "DISQUALIFIED"] } };

const TERMINAL = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const cut = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed || null;
};

/** Same rule as citationsAreGrounded: every cited page must be one we opened. */
const grounded = (sourceUrls = [], fetchedUrls = []) => {
  if (!sourceUrls.length) return false;
  const seen = new Set(fetchedUrls.map((u) => String(u).replace(/\/+$/, "").toLowerCase()));
  return sourceUrls.some((u) => seen.has(String(u).replace(/\/+$/, "").toLowerCase()));
};

const awaitRun = async (runId, { pollMs = 5000, hardCapMs = 25 * 60 * 1000 } = {}) => {
  const started = Date.now();
  for (;;) {
    const run = await prisma.discoveryRun.findUnique({ where: { id: runId }, select: { status: true, stats: true } });
    if (!run) throw new Error(`run ${runId} vanished`);
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() - started > hardCapMs) return { status: `TIMEOUT_WAITING(${run.status})`, stats: run.stats };
    await sleep(pollMs);
  }
};

const readInput = async () => {
  const file = arg("file");
  const useStdin = process.argv.includes("--stdin");
  if (!file && !useStdin) throw new Error("one of --file or --stdin is required");
  const raw = useStdin
    ? await new Promise((resolve, reject) => {
        let buf = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (c) => { buf += c; });
        stdin.on("end", () => resolve(buf));
        stdin.on("error", reject);
      })
    : await readFile(file, "utf8");
  return JSON.parse(raw);
};

/** Print to the terminal, or to `--out` when the payload is meant to be edited. */
const emit = async (text) => {
  const out = arg("out");
  if (!out) {
    console.log(text);
    return;
  }
  await writeFile(out, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  console.log(`written to ${out} (${text.length} chars)`);
};

/**
 * A product by id, by URL, or newly created from a URL nobody has added yet.
 *
 * Creation goes through the service so a re-pasted URL re-opens the existing
 * product rather than splitting its runs and drafts across two rows for one
 * site — the same reason createPromotedProduct dedupes at all.
 */
const resolveProduct = async (input, { create = false } = {}) => {
  if (!input) throw new Error("--product is required (a product id or its website address)");

  const byId = await prisma.promotedProduct.findUnique({ where: { id: input } });
  if (byId) return byId;

  const origin = normalizeProductUrl(input);
  if (!origin) throw new Error(`No product has the id "${input}", and it is not a public website address either.`);

  const byUrl = await prisma.promotedProduct.findUnique({ where: { url: origin } });
  if (byUrl) return byUrl;
  if (!create) throw new Error(`No promoted product exists for ${origin}. Run export-pages against it first.`);

  const created = await createPromotedProduct({ url: origin });
  console.log(`added ${origin} as product ${created.id}`);
  return prisma.promotedProduct.findUnique({ where: { id: created.id } });
};

const requireApprovedIcp = (product) => {
  if (product.icpApprovedAt) return;
  // The same refusal launchPromoteRun makes, for the same reason: what follows
  // puts strangers into an outreach queue, and the profile choosing them has to
  // have been read by somebody.
  throw new Error(
    `The ideal customer profile for ${product.name} has not been approved yet. ` +
    "No leads can be sourced until someone reads and approves it — " +
    `approve it in the UI, or run: node scripts/promoter-assist.mjs approve-icp --product ${product.id}`,
  );
};

// ─── export-pages ─────────────────────────────────────────────────────────────

const EXPORT_PAGES_INSTRUCTIONS =
  "Read the pages below and return a product profile as JSON for `import-profile`: " +
  "productId, researcher, name, summary (one paragraph), category, and the sourced arrays " +
  "features/differentiators/proofPoints/competitors/geographyCues as [{ value, sourceUrl }] and " +
  "pricing as [{ plan, price, capacity, sourceUrl }]. State only what the pages actually say — " +
  "never invent a feature, price, customer or claim, and leave a field empty rather than padding it. " +
  "Copy prices, plan names and capacities exactly as printed. Every sourceUrl must be one of the page " +
  "URLs in this file; any other URL is discarded on import and the item is stored with no source. " +
  "Then add an `icp` object: summary, industries, companySize {min,max,note}, geographies " +
  "[{region,countryCode,reason,priority}], buyerTitles {decisionMakers,champions}, painPoints " +
  "[{pain,productAnswer}], buyingSignals [{signal,detectableVia,signalKey}], disqualifiers, " +
  "competitorsToDisplace, and 3-5 suggestedSearchQueries [{label,searchInstruction,expectedSourceTypes}] " +
  "that each target a different slice of the market. Every ICP field must be something a researcher " +
  "could actually search or filter on.";

const exportPages = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const product = await resolveProduct(arg("product"), { create: true });

  console.log(`product  : ${product.name} (${product.id})`);
  console.log(`crawling : ${product.url}`);

  const research = await researchProduct({ productId: product.id, returnPages: true, skipExtract: true });
  if (!research.ok) throw new Error(research.reason);

  const pages = (research.pages || []).map((p) => ({ url: p.url, text: String(p.text).slice(0, PAGE_TEXT_CHARS) }));
  console.log(`read     : ${pages.length} pages · ${pages.reduce((n, p) => n + p.text.length, 0)} chars`);

  // The crawled URLs are stored now rather than on import, because import-profile
  // checks every cited sourceUrl against this list. Without it, a profile written
  // from these very pages would have every one of its citations stripped.
  if (dryRun) {
    console.log(`dry run  : would record ${pages.length} researchedUrls on ${product.id}`);
  } else {
    await prisma.promotedProduct.update({
      where: { id: product.id },
      data: { researchedUrls: research.pageUrls },
    });
  }

  await emit(JSON.stringify({
    productId: product.id,
    url: product.url,
    pages,
    instructions: EXPORT_PAGES_INSTRUCTIONS,
  }, null, 2));
};

// ─── import-profile ───────────────────────────────────────────────────────────

/**
 * Sourced items with every unprovable citation blanked.
 *
 * keepOnlyFetchedSources is the guard the model's own output passes through, and
 * an assistant guesses a plausible "/pricing" exactly as readily. The count of
 * what it stripped is reported rather than swallowed, because a profile whose
 * citations were all invented is a profile worth re-doing.
 */
const sourcedList = (items, fetchedUrls, keyField = "value") => {
  const input = Array.isArray(items) ? items : [];
  const kept = keepOnlyFetchedSources(input, fetchedUrls);
  let stripped = 0;
  const out = [];
  for (const [i, item] of kept.entries()) {
    if (input[i]?.sourceUrl && !item.sourceUrl) stripped += 1;
    const value = cut(item[keyField], JSON_VALUE);
    if (!value) continue;
    out.push(keyField === "plan"
      ? { plan: value, price: cut(item.price, JSON_VALUE), capacity: cut(item.capacity, JSON_VALUE), sourceUrl: item.sourceUrl }
      : { value, sourceUrl: item.sourceUrl });
  }
  return { items: out, stripped };
};

/** The first sentence of the summary, which is the angle until a human writes one. */
const angleFromSummary = (summary) => {
  if (!summary) return null;
  return cut(String(summary).split(/(?<=[.!?])\s+/)[0] || summary, LIMITS.pitchAngle);
};

const importProfile = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const doc = await readInput();
  const product = await resolveProduct(doc.productId || arg("product"));

  const fetched = product.researchedUrls || [];
  if (!fetched.length) {
    throw new Error(
      `${product.name} has no crawled pages recorded, so every citation in this profile would be stripped. ` +
      `Run: node scripts/promoter-assist.mjs export-pages --product ${product.id}`,
    );
  }

  const lists = {
    features: sourcedList(doc.features, fetched),
    pricing: sourcedList(doc.pricing, fetched, "plan"),
    differentiators: sourcedList(doc.differentiators, fetched),
    proofPoints: sourcedList(doc.proofPoints, fetched),
    competitors: sourcedList(doc.competitors, fetched),
    geographyCues: sourcedList(doc.geographyCues, fetched),
  };

  const icp = normaliseIcp(doc.icp);
  const researcher = cut(doc.researcher, LIMITS.model) || "agent:unattributed";

  const data = {
    name: cut(doc.name, LIMITS.name) || product.name,
    summary: cut(doc.summary, LIMITS.summary),
    category: cut(doc.category, LIMITS.category),
    features: lists.features.items,
    pricing: lists.pricing.items,
    differentiators: lists.differentiators.items,
    proofPoints: lists.proofPoints.items,
    competitors: lists.competitors.items,
    geographyCues: lists.geographyCues.items,
    // Stamped with who wrote it, so a profile that came in this way is
    // distinguishable from one the extraction pipeline produced.
    model: researcher,
    promptVersion: PROMPT_VERSION.slice(0, LIMITS.promptVersion),
    // ICP_REVIEW and no icpApprovedAt: writing the profile is not approving it.
    status: "ICP_REVIEW",
  };

  // An approved ICP belongs to the human who approved it. Overwriting it here
  // would leave icpApprovedAt pointing at text nobody read.
  if (!product.icpApprovedAt) data.icp = icp;

  if (doc.pitchAngle !== undefined) data.pitchAngle = cut(doc.pitchAngle, LIMITS.pitchAngle);
  else if (!product.pitchAngle) data.pitchAngle = angleFromSummary(data.summary);
  if (doc.proofLink !== undefined) data.proofLink = doc.proofLink ? cut(doc.proofLink, LIMITS.proofLink) : null;
  if (doc.senderContext !== undefined) data.senderContext = cut(doc.senderContext, LIMITS.senderContext);
  else if (!product.senderContext) data.senderContext = cut(`Writing on behalf of ${data.name}.`, LIMITS.senderContext);

  console.log(`product  : ${data.name} (${product.id})`);
  console.log(`researcher: ${researcher}`);
  console.log(`pages read: ${fetched.length}`);
  for (const [field, { items, stripped }] of Object.entries(lists)) {
    console.log(`  ${field.padEnd(16)}: ${items.length} kept${stripped ? ` · ${stripped} source URLs stripped (never crawled)` : ""}`);
  }
  console.log(`icp      : ${icp.suggestedSearchQueries.length} search instructions · ${icp.industries.length} industries · ${icp.buyingSignals.length} signals`);
  if (!icpIsUsable(icp)) console.log("  ! this ICP has no search instructions, so it would source nothing and cannot be approved");
  if (product.icpApprovedAt) console.log("  ! the stored ICP is already approved and was left untouched");

  if (dryRun) {
    console.log("dry run  : nothing written");
    return;
  }

  await prisma.promotedProduct.update({ where: { id: product.id }, data });
  console.log(`written  : ${product.id} is now ICP_REVIEW`);
  console.log(
    "NOT APPROVED — no lead can be sourced for this product until a human reads the ICP and approves it, " +
    `in the UI or with: node scripts/promoter-assist.mjs approve-icp --product ${product.id}`,
  );
};

// ─── approve-icp ──────────────────────────────────────────────────────────────

const approveIcpCommand = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const product = await resolveProduct(arg("product"));
  const icp = normaliseIcp(product.icp);

  console.log(`product  : ${product.name} (${product.id})`);
  console.log(`icp      : ${icp.summary || "(no summary)"}`);
  for (const q of icp.suggestedSearchQueries) console.log(`  search : ${q.label || "(unlabelled)"} — ${q.searchInstruction}`);

  if (dryRun) {
    console.log(icpIsUsable(icp) ? "dry run  : would approve this ICP" : "dry run  : this ICP has no search instructions and would be refused");
    return;
  }

  const approved = await approveIcp(product.id);
  console.log(`approved : ${approved.icpApprovedAt} · status ${approved.status}`);
};

// ─── export-icp ───────────────────────────────────────────────────────────────

const exportIcp = async () => {
  const product = await resolveProduct(arg("product"));
  const icp = normaliseIcp(product.icp);
  const lines = [];

  lines.push(`PRODUCT: ${product.name} (${product.id})`);
  lines.push(`Category: ${product.category || "(not stated)"}`);
  lines.push(`Site: ${product.url}`);
  lines.push(`The angle every email leads with: ${product.pitchAngle || "(none set)"}`);
  lines.push("");
  lines.push(`IDEAL CUSTOMER: ${icp.summary || "(no summary)"}`);
  lines.push(`Industries: ${icp.industries.join(", ") || "(none)"}`);
  lines.push(`Company size: ${icp.companySize.min || "?"}–${icp.companySize.max || "?"} people${icp.companySize.note ? ` (${icp.companySize.note})` : ""}`);
  lines.push("Geographies:");
  for (const g of icp.geographies) lines.push(`  ${g.priority}. ${g.region}${g.countryCode ? ` [${g.countryCode}]` : ""} — ${g.reason || "no reason given"}`);
  lines.push(`Decision makers: ${icp.buyerTitles.decisionMakers.join(", ") || "(none)"}`);
  lines.push(`Champions: ${icp.buyerTitles.champions.join(", ") || "(none)"}`);
  lines.push("Pains this answers:");
  for (const p of icp.painPoints) lines.push(`  - ${p.pain}${p.productAnswer ? ` → ${p.productAnswer}` : ""}`);
  lines.push("Buying signals to look for:");
  for (const s of icp.buyingSignals) lines.push(`  - ${s.signal} (detectable via ${s.detectableVia}${s.signalKey ? `, ${s.signalKey}` : ""})`);
  lines.push(`Disqualifiers: ${icp.disqualifiers.join("; ") || "(none)"}`);
  lines.push(`Competitors to displace: ${icp.competitorsToDisplace.join(", ") || "(none named)"}`);
  lines.push("");
  lines.push("SEARCHES TO RUN — each targets a different slice; do not collapse them into one:");
  for (const [i, q] of icp.suggestedSearchQueries.entries()) {
    lines.push(`  ${i + 1}. ${q.label || "(unlabelled)"}`);
    lines.push(`     ${q.searchInstruction}`);
    if (q.expectedSourceTypes.length) lines.push(`     expect: ${q.expectedSourceTypes.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "Return the companies you find as an import-leads file: { productId, researcher, fetchedUrls, candidates }. " +
    "fetchedUrls is every page you actually opened, and each candidate's sourceUrls must be among them — " +
    "a candidate citing a page you did not open is stored REJECTED_UNCITED and never becomes a lead. " +
    "Every email, phone and address you supply is re-fetched from the company's own site before it is believed, " +
    "so a guess costs a crawl and gains nothing.",
  );

  if (!product.icpApprovedAt) {
    console.error(`WARNING: this ICP is NOT approved. import-leads will refuse it until someone approves it (approve-icp --product ${product.id}).`);
  }
  await emit(lines.join("\n"));
};

// ─── import-leads ─────────────────────────────────────────────────────────────

const importLeads = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const doc = await readInput();
  const product = await resolveProduct(doc.productId || arg("product"));
  requireApprovedIcp(product);

  const candidates = Array.isArray(doc.candidates) ? doc.candidates : [];
  const fetched = doc.fetchedUrls || [];
  if (!candidates.length) throw new Error("this file contains no candidates");

  console.log(`product   : ${product.name} (${product.id})`);
  console.log(`candidates: ${candidates.length} · pages opened: ${fetched.length}`);

  const ungrounded = candidates.filter((c) => !grounded(c.sourceUrls, fetched));
  console.log(`grounded  : ${candidates.length - ungrounded.length}/${candidates.length}`);
  if (ungrounded.length) console.log(`  uncited : ${ungrounded.map((c) => c.name).join(", ")}`);

  // The promote plan with the steps this file has already done removed — the
  // web search and the competitor sweep — and composition left for
  // import-drafts, with the ordinals closed up so the runner's progress is
  // consecutive.
  const full = buildPromotePlan(product);
  const steps = full.steps
    .filter((s) => s.kind !== "AI_DISCOVER" && s.kind !== "COMPETITOR_USERS" && s.kind !== "AI_COMPOSE")
    .map((s, i) => ({ ...s, ordinal: i }));
  const plan = { ...full, steps };
  console.log(`plan      : ${steps.length} steps (${full.steps.length - steps.length} AI steps removed) — ${steps.map((s) => s.kind).join(" → ")}`);

  if (dryRun) {
    console.log("dry run   : no run created, nothing quarantined");
    return;
  }

  const run = await createDiscoveryRun({ plan, trigger: "MANUAL" });
  // Linked after creation for the same reason launchPromoteRun does it: the
  // run's own constructor is shared with every other kind of run.
  await prisma.discoveryRun.update({ where: { id: run.id }, data: { promotedProductId: product.id } });

  const source = await ensureSource({
    kind: "AI_WEB_SEARCH",
    // A name of its own rather than the one import-candidates.mjs uses, so the
    // two scripts do not overwrite each other's attribution on one shared row.
    name: "Agent product promotion research".slice(0, 100),
    attribution:
      `Companies surfaced by an assistant reading public web pages (${doc.researcher || "unattributed"}) ` +
      "against an approved ideal customer profile; every claim independently re-fetched and verified by " +
      "our own crawler before use.",
  });
  const record = await recordSourceRecord({
    sourceId: source.id,
    externalId: `${run.id}:agent-promote`.slice(0, 255),
    url: null,
    payload: { productId: product.id, researcher: doc.researcher || null, fetchedUrls: fetched, candidates },
  });

  let created = 0;
  let uncited = 0;
  for (const c of candidates) {
    if (!c?.name?.trim() || !normalizeCompanyName(c.name)) continue;
    const ok = grounded(c.sourceUrls || [], fetched);
    try {
      await prisma.aiCandidate.create({
        data: {
          runId: run.id,
          sourceRecordId: record.id,
          strategyLabel: "agent promote research".slice(0, 120),
          name: c.name.slice(0, 160),
          nameLocal: c.nameLocal?.slice(0, 160) ?? null,
          claimedWebsite: c.website?.slice(0, 300) ?? null,
          claimedCity: c.city?.slice(0, 80) ?? null,
          industryGuess: c.industryGuess?.slice(0, 60) ?? null,
          whyMatch: (c.whyMatch || "").slice(0, 300),
          matchConfidence: ok ? (c.matchConfidence || "MEDIUM") : "LOW",
          uncited: !ok,
          status: ok ? "PENDING" : "REJECTED_UNCITED",
          rejectedReason: ok ? null : "Cited a source page the researcher did not report opening.",
          claims: {
            create: CLAIM_FIELDS.filter(([k]) => c[k]).map(([k, field, sk]) => ({
              field,
              value: String(c[k]).slice(0, 500),
              foundOnUrl: c.detailSources?.[sk]?.slice(0, 600) || c.sourceUrls?.[0]?.slice(0, 600) || null,
            })),
          },
          citations: {
            create: (c.sourceUrls || []).slice(0, 5).map((url) => ({
              url: String(url).slice(0, 600),
              inSources: fetched.some((f) => String(f).replace(/\/+$/, "").toLowerCase() === String(url).replace(/\/+$/, "").toLowerCase()),
            })),
          },
        },
      });
      created += 1;
      if (!ok) uncited += 1;
    } catch (err) {
      if (!String(err.message).includes("Unique constraint")) console.error(`  ! ${c.name}: ${err.message}`);
    }
  }
  console.log(`run ${run.id} · ${created} candidates quarantined (${uncited} uncited) · ${plan.steps.length} steps`);

  const t0 = Date.now();
  startDiscoveryRun(run.id, icpToParsedQuery(product.icp));
  const finished = await awaitRun(run.id);
  const secs = Math.round((Date.now() - t0) / 1000);

  const leads = await prisma.lead.count({ where: { discoveryRunId: run.id } });
  const statuses = await prisma.aiCandidate.groupBy({ by: ["status"], where: { runId: run.id }, _count: true });
  console.log(`${finished.status} in ${secs}s — ${leads} leads`);
  for (const s of statuses) console.log(`   ${s.status}: ${s._count}`);
  console.log(`next     : node scripts/promoter-assist.mjs export-compose --run ${run.id}`);
};

// ─── export-compose ───────────────────────────────────────────────────────────

const COMPOSE_INSTRUCTIONS =
  "Write one email per lead and return them as an import-drafts file: " +
  "{ productId, researcher, runId, drafts: [{ leadId, subject, body, aboutCompany, factIdsUsed }] }. " +
  "TWO SOURCES OF TRUTH: everything you say about the recipient must come from that lead's own numbered " +
  "facts, and everything you say about what is being offered must come from the shared product block. " +
  "Never let a product claim become a claim about the reader. " +
  "BODY: 25-70 words, plain text, one sentence per paragraph with a blank line between, no links or URLs " +
  "of any kind, no phone numbers or email addresses that are not already in that lead's facts — a body " +
  "that names one is rejected on import. " +
  "Open with the single strongest specific observation from their facts, never with the product. " +
  "Name exactly one capability from the product block and at most one concrete number from it. " +
  "End with exactly ONE small question a one-word reply answers; never ask for a call or a meeting. " +
  "SUBJECT: 2-5 plain lowercase words, specific to that business. " +
  "factIdsUsed lists the fact ids you actually relied on; an id that is not in that lead's list is rejected. " +
  "aboutCompany is a one-line note for the operator, not part of the email.";

const exportCompose = async () => {
  const runId = arg("run");
  if (!runId) throw new Error("--run <runId> is required");

  const run = await prisma.discoveryRun.findUnique({ where: { id: runId }, select: { id: true, promotedProductId: true } });
  if (!run) throw new Error(`No discovery run has the id "${runId}".`);

  const product = await resolveProduct(arg("product") || run.promotedProductId);
  if (run.promotedProductId && arg("product") && run.promotedProductId !== product.id) {
    // Pitching one product with another product's copy is exactly the mix-up
    // this export exists to make impossible.
    throw new Error(`Run ${runId} belongs to product ${run.promotedProductId}, not ${product.id}.`);
  }

  const leads = await prisma.lead.findMany({
    where: { discoveryRunId: runId, ...CONTACTABLE },
    select: { id: true },
    orderBy: { score: "desc" },
  });

  const out = [];
  for (const { id } of leads) {
    const g = await gatherFacts(id);
    if (!g) continue;
    out.push({
      leadId: id,
      company: { name: g.company.name, city: g.company.city, countryCode: g.company.countryCode, industry: g.company.industry },
      recipientHint: g.recipientHint,
      facts: g.facts.map(({ id: fid, text, confidenceLevel, observedAt }) => ({ id: fid, text, confidenceLevel, observedAt })),
    });
  }

  console.log(`run      : ${runId}`);
  console.log(`product  : ${product.name} (${product.id})`);
  console.log(`leads    : ${out.length} contactable of ${leads.length}`);

  await emit(JSON.stringify({
    runId,
    productId: product.id,
    // Both forms of the same block: the rendered text the model would have been
    // given, and the fields behind it for anything that would rather read JSON.
    productBlock: buildProductBlock({ product }),
    product: {
      name: product.name,
      category: product.category,
      summary: product.summary,
      pitchAngle: product.pitchAngle,
      senderContext: product.senderContext,
      features: product.features || [],
      pricing: product.pricing || [],
      differentiators: product.differentiators || [],
    },
    leads: out,
    instructions: COMPOSE_INSTRUCTIONS,
  }, null, 2));
};

// ─── import-drafts ────────────────────────────────────────────────────────────

const importDrafts = async () => {
  const dryRun = process.argv.includes("--dry-run");
  const doc = await readInput();
  const product = await resolveProduct(doc.productId || arg("product"));
  const drafts = Array.isArray(doc.drafts) ? doc.drafts : [];
  if (!drafts.length) throw new Error("this file contains no drafts");

  const researcher = cut(doc.researcher, LIMITS.model) || "agent:unattributed";
  const runId = doc.runId || arg("run") || null;

  console.log(`product  : ${product.name} (${product.id})`);
  console.log(`drafts   : ${drafts.length} · author ${researcher}`);

  let imported = 0;
  const rejected = [];
  for (const d of drafts) {
    const gathered = await gatherFacts(d.leadId);
    if (!gathered) { rejected.push({ leadId: d.leadId, reason: "no such lead" }); continue; }
    if (!d.subject?.trim() || !d.body?.trim()) { rejected.push({ leadId: d.leadId, reason: "empty subject or body" }); continue; }

    // The grounding guard is not relaxed for a human author. A body naming a
    // phone number or link the facts do not carry does the same damage whoever
    // wrote it, and that damage lands in a real stranger's inbox.
    const check = bodyIsGrounded(d.body, gathered.facts);
    if (!check.ok) { rejected.push({ leadId: d.leadId, reason: `invented "${check.offending}"` }); continue; }

    const validIds = new Set(gathered.facts.map((f) => f.id));
    const factIdsUsed = Array.isArray(d.factIdsUsed) ? d.factIdsUsed : [];
    const bogus = factIdsUsed.filter((id) => !validIds.has(id));
    if (bogus.length) { rejected.push({ leadId: d.leadId, reason: `cited fact ids that do not exist: ${bogus.join(", ")}` }); continue; }

    if (dryRun) { imported += 1; continue; }

    await prisma.leadEmailDraft.create({
      data: {
        leadId: d.leadId,
        runId,
        promotedProductId: product.id,
        subject: d.subject.slice(0, 200),
        body: d.body.slice(0, 4000),
        aboutCompany: (d.aboutCompany || "").slice(0, 1000),
        // The snapshot of what the author was allowed to know, so the email can
        // be audited against it long after the company has been re-crawled.
        groundingFacts: gathered.facts,
        factIdsUsed,
        generatedBy: "LLM",
        confidenceLevel: "AI_GENERATED",
        model: researcher,
        promptVersion: PROMPT_VERSION.slice(0, LIMITS.promptVersion),
      },
    });
    imported += 1;
  }

  console.log(`${dryRun ? "dry run  : would import" : "imported "}: ${imported} · rejected: ${rejected.length}`);
  for (const r of rejected) console.log(`   ${r.leadId}: ${r.reason}`);
};

// ─── status ───────────────────────────────────────────────────────────────────

const status = async () => {
  const resolved = await resolveProduct(arg("product"));
  const product = await getPromotedProduct(resolved.id);
  const drafts = await prisma.leadEmailDraft.count({ where: { promotedProductId: resolved.id } });

  console.log(`${product.name} — ${product.url}`);
  console.log(`id       : ${product.id}`);
  console.log(`status   : ${product.status}`);
  console.log(`icp      : ${product.icpApproved ? `approved ${product.icpApprovedAt.toISOString()}` : "NOT APPROVED — no leads can be sourced"}`);
  console.log(`profile  : ${product.features.length} features · ${product.pricing.length} plans · ${product.differentiators.length} differentiators · ${product.proofPoints.length} proof points`);
  console.log(`pages    : ${product.researchedUrls.length} crawled`);
  console.log(`searches : ${(product.icp?.suggestedSearchQueries || []).length} instructions`);
  console.log(`written by: ${product.model || "(nothing yet)"} · prompt ${product.promptVersion || "(none)"}`);
  console.log(`runs     : ${product.runs.length}`);
  for (const r of product.runs) console.log(`   ${r.runId} ${r.status.padEnd(10)} ${r.leadCount} leads · ${r.createdAt.toISOString()}`);
  console.log(`drafts   : ${drafts} written for this product`);
};

// ─── dispatch ─────────────────────────────────────────────────────────────────

const COMMANDS = {
  "export-pages": exportPages,
  "import-profile": importProfile,
  "approve-icp": approveIcpCommand,
  "export-icp": exportIcp,
  "import-leads": importLeads,
  "export-compose": exportCompose,
  "import-drafts": importDrafts,
  status,
};

const main = async () => {
  const command = process.argv[2];
  const run = COMMANDS[command];
  if (!run) {
    throw new Error(
      `Unknown subcommand "${command || "(none)"}". One of: ${Object.keys(COMMANDS).join(", ")}.\n` +
      "See the header of this file for what each one reads and writes.",
    );
  }
  await run();
};

main()
  .catch((err) => { console.error(err.message || err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
