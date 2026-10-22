/**
 * Import externally-researched companies as quarantined candidates.
 *
 * Stands in for the AI_DISCOVER step when no LLM provider has credit. The
 * researcher — a person or an agent — supplies companies it believes match a
 * query, together with the pages it actually opened. Nothing it says is
 * trusted: the rows written here are `AiCandidate` + `AiClaim`, exactly what
 * `discoverViaWebSearch` writes, so the run continues through the normal
 * RESOLVE_MERGE → CRAWL → AI_VERIFY path and every claimed email, phone and
 * WhatsApp number is re-fetched and re-read by our own crawler before it can
 * become a Contact. The existence gate still applies, so a business that
 * cannot be shown to exist never becomes a lead.
 *
 * The citation guard is preserved too: `sourceUrls` are checked against
 * `fetchedUrls` — the pages the researcher reports actually retrieving — and a
 * candidate citing a page it never opened is stored REJECTED_UNCITED, the same
 * verdict an invented link gets from the model.
 *
 * Usage:
 *   node scripts/import-candidates.mjs --file candidates.json [--dry-run]
 *   cat candidates.json | node scripts/import-candidates.mjs --stdin
 *
 * `--stdin` exists so a file can be piped into the container over ssh without
 * needing a writable path inside it.
 *
 * File shape:
 *   {
 *     "query": "travel agencies in Doha with outdated websites",
 *     "researcher": "agent:claude-opus-5",
 *     "fetchedUrls": ["https://…", …],        // every page actually opened
 *     "candidates": [{
 *       "name": "…", "nameLocal": "…", "website": "https://…", "city": "Doha",
 *       "industryGuess": "travel agency", "whyMatch": "…",
 *       "matchConfidence": "HIGH|MEDIUM|LOW",
 *       "email": "…", "phone": "…", "whatsapp": "…", "addressText": "…",
 *       "sourceUrls": ["https://…"],
 *       "detailSources": { "email": "https://…", "phone": "https://…" },
 *       "intent": {                              // optional — why now
 *         "kind": "BUYER_REQUEST" | "FUNDING_RAISED",
 *         "summary": "a mobile and web resettlement app",   // or the amount
 *         "quote": "words copied from the page",  // must appear on `url`
 *         "url": "https://…", "deadline": "2026-11-02", "date": "2026-09-25"
 *       }
 *     }]
 *   }
 *
 * An `intent` is a claim like any other. After the run, the cited page is
 * fetched by our own crawler and the quote must be found on it; only then is
 * it recorded as a fact (`buyer_request` / `funding_round`), which the signal
 * engine turns into BUYER_REQUEST / FUNDING_RAISED and the company is
 * re-scored. A request found nowhere on its page is reported and dropped.
 *
 * `--intent-only` applies the intents to companies an earlier import already
 * created, without starting a new run.
 */
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import prisma from "../prismaClient.js";
import { parseQuery, describeQuery } from "../lib/nlquery/parser.js";
import { buildResearchPlan } from "../lib/nlquery/planner.js";
import { buildBrief, saveBrief } from "../lib/research/brief.js";
import { createDiscoveryRun, startDiscoveryRun } from "../lib/discovery/runner.js";
import { ensureSource, recordSourceRecord } from "../lib/provenance/recorder.js";
import { normalizeCompanyName, normalizeCityLabel } from "../utils/normalize.js";
import { normaliseCountryCode } from "../utils/countries.js";
import { DISCOVERY_MAX_CRAWL_HOSTS } from "../configs/envConfig.js";
import { CostTracker } from "../lib/llm/responses.js";
import { fetchPage } from "../lib/crawler/fetchPage.js";
import { recordFact } from "../lib/provenance/recorder.js";
import { evaluateCompanySignals } from "../lib/signals/signalEngine.js";
import { scoreCompany } from "../lib/scoring/scoreEngine.js";

const CLAIM_FIELDS = [
  ["email", "EMAIL", "email"],
  ["phone", "PHONE", "phone"],
  ["whatsapp", "WHATSAPP", "whatsapp"],
  ["addressText", "ADDRESS", "address"],
  ["website", "WEBSITE", "website"],
];

const TERMINAL = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
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

/** Page text reduced to comparable words: tags, entities, case and punctuation gone. */
const comparable = (text) => String(text || "")
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&[a-z#0-9]+;/gi, " ")
  .toLowerCase()
  .replace(/[^a-z0-9€£$]+/g, " ")
  .trim();

/**
 * Verify each candidate's `intent` on its cited page and record it as a fact.
 * Returns one line per intent for the console.
 */
const applyIntents = async ({ candidates, runId = null, source }) => {
  const lines = [];
  for (const c of candidates) {
    const intent = c.intent;
    if (!intent?.kind || !intent?.url || !intent?.quote) continue;
    const row = await prisma.aiCandidate.findFirst({
      where: { name: c.name.slice(0, 160), companyId: { not: null }, ...(runId ? { runId } : {}) },
      orderBy: { createdAt: "desc" },
      select: { companyId: true },
    });
    if (!row) { lines.push(`  ! ${c.name}: no company was created, intent skipped`); continue; }

    const res = await fetchPage(intent.url, { timeoutMs: 15_000 });
    const found = res.ok && comparable(res.body).includes(comparable(intent.quote));
    if (!found) {
      lines.push(`  ! ${c.name}: quote not found on ${intent.url}${res.ok ? "" : ` (${res.blockReason || res.status})`} — intent dropped`);
      continue;
    }
    const record = await recordSourceRecord({
      sourceId: source.id,
      externalId: null,
      url: res.finalUrl || intent.url,
      payload: { url: res.finalUrl || intent.url, status: res.status, contentHash: res.contentHash, kind: intent.kind, quote: intent.quote },
    });
    const isRequest = intent.kind === "BUYER_REQUEST";
    await recordFact({
      companyId: row.companyId,
      key: isRequest ? "buyer_request" : "funding_round",
      value: intent.summary || null,
      valueJson: { url: res.finalUrl || intent.url, deadline: intent.deadline || null, date: intent.date || null },
      confidenceLevel: "VERIFIED",
      extractorName: "importIntent",
      evidenceSnippet: intent.quote,
      sourceRecordId: record.id,
    });
    await evaluateCompanySignals(row.companyId);
    const scored = await scoreCompany(row.companyId, { discoveryRunId: runId });
    lines.push(`  ✓ ${c.name}: ${intent.kind} verified — ${scored.skipped ? `still below the bar (${scored.reason})` : "lead scored"}`);
  }
  return lines;
};

const main = async () => {
  const file = arg("file");
  const useStdin = process.argv.includes("--stdin");
  if (!file && !useStdin) throw new Error("one of --file or --stdin is required");
  const dryRun = process.argv.includes("--dry-run");
  const raw = useStdin
    ? await new Promise((resolve, reject) => {
        let buf = "";
        stdin.setEncoding("utf8");
        stdin.on("data", (c) => { buf += c; });
        stdin.on("end", () => resolve(buf));
        stdin.on("error", reject);
      })
    : await readFile(file, "utf8");
  const doc = JSON.parse(raw);

  const q = doc.query;
  const parsed = parseQuery(q);
  const fetched = doc.fetchedUrls || [];
  console.log(`query    : ${q}`);
  console.log(`read as  : ${describeQuery(parsed)}`);
  console.log(`candidates: ${doc.candidates.length} · pages opened: ${fetched.length}`);

  const ungrounded = doc.candidates.filter((c) => !grounded(c.sourceUrls, fetched));
  console.log(`grounded : ${doc.candidates.length - ungrounded.length}/${doc.candidates.length}`);
  if (ungrounded.length) console.log(`  uncited: ${ungrounded.map((c) => c.name).join(", ")}`);
  if (dryRun) return;

  if (process.argv.includes("--intent-only")) {
    const source = await ensureSource({
      kind: "AI_WEB_SEARCH",
      name: "Agent web research (stated need)",
      attribution: "A tender, request or funding announcement cited by an assistant and re-fetched by our own crawler, which found the quoted words on the page.",
    });
    for (const line of await applyIntents({ candidates: doc.candidates, source })) console.log(line);
    return;
  }

  const tracker = new CostTracker();
  const { brief, producedBy, model } = await buildBrief({ rawQuery: q, parsed, tracker });

  const searchQuery = await prisma.searchQuery.create({
    data: {
      rawText: q.slice(0, 1000),
      parsed: { query: parsed.query, chips: parsed.chips, confidence: parsed.confidence, brief },
      parserUsed: producedBy === "LLM" ? "LLM" : "DETERMINISTIC",
    },
  });

  // The plan is the ordinary research plan with every discovery step removed —
  // this file *is* the run's discovery — and the ordinals closed up. The same
  // rule promoter-assist import-leads follows: DB_MATCH re-scored up to fifty
  // unrelated leads that merely shared the query's location, and AGGREGATOR
  // refilled the run with up to sixty job-board employers (the "Technology
  // employer" rows in the agency queues). ATS_PROBE stays: it reads the
  // researched companies' own job boards, which is corroboration.
  const DISCOVERY_STEPS = new Set(["AI_DISCOVER", "AI_COMPOSE", "DB_MATCH", "AGGREGATOR", "OVERPASS", "COMPETITOR_USERS"]);
  const full = buildResearchPlan(parsed, brief);
  const steps = full.steps
    .filter((s) => !DISCOVERY_STEPS.has(s.kind))
    .map((s, i) => ({ ...s, ordinal: i }));
  // The crawl budget follows the file, the way promoter-assist's does. A plan
  // built for an ordinary search carries a host cap sized for a search, and a
  // researched file longer than that silently loses its tail: a 35-practice
  // batch crawled 30 and left 9 companies with no website, no contacts and so
  // no lead at all — they were in the database looking imported, and were not.
  for (const step of steps) {
    if (step.kind !== "CRAWL") continue;
    step.params = {
      ...step.params,
      maxHosts: Math.min(doc.candidates.length + 10, DISCOVERY_MAX_CRAWL_HOSTS),
      maxResolve: Math.min(doc.candidates.length, 25),
    };
  }
  const plan = { ...full, steps };
  const crawlStep = steps.find((s) => s.kind === "CRAWL");
  console.log(`plan     : ${steps.map((s) => s.kind).join(" → ")}${crawlStep ? ` (crawl up to ${crawlStep.params.maxHosts} hosts)` : ""}`);

  const run = await createDiscoveryRun({ plan, trigger: "NL_QUERY", searchQueryId: searchQuery.id });
  await saveBrief({ runId: run.id, searchQueryId: searchQuery.id, brief, producedBy, model });

  const source = await ensureSource({
    kind: "AI_WEB_SEARCH",
    name: "Agent web research",
    attribution:
      `Companies surfaced by an assistant reading public web pages (${doc.researcher || "unattributed"}); ` +
      `every claim independently re-fetched and verified by our own crawler before use.`,
  });
  const record = await recordSourceRecord({
    sourceId: source.id,
    externalId: `${run.id}:agent-research`.slice(0, 255),
    url: null,
    payload: { query: q, researcher: doc.researcher || null, fetchedUrls: fetched, candidates: doc.candidates },
  });

  let created = 0;
  let uncited = 0;
  for (const c of doc.candidates) {
    if (!c?.name?.trim() || !normalizeCompanyName(c.name)) continue;
    const ok = grounded(c.sourceUrls || [], fetched);
    try {
      await prisma.aiCandidate.create({
        data: {
          runId: run.id,
          sourceRecordId: record.id,
          strategyLabel: "agent web research".slice(0, 120),
          name: c.name.slice(0, 160),
          nameLocal: c.nameLocal?.slice(0, 160) ?? null,
          claimedWebsite: c.website?.slice(0, 300) ?? null,
          claimedCity: normalizeCityLabel(c.city)?.slice(0, 80) ?? null,
          claimedCountry: normaliseCountryCode(c.countryCode),
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
  startDiscoveryRun(run.id, parsed);
  const finished = await awaitRun(run.id);
  const secs = Math.round((Date.now() - t0) / 1000);

  const leads = await prisma.lead.count({ where: { discoveryRunId: run.id } });
  const rejected = await prisma.aiCandidate.groupBy({
    by: ["status"], where: { runId: run.id }, _count: true,
  });
  console.log(`${finished.status} in ${secs}s — ${leads} leads`);
  for (const r of rejected) console.log(`   ${r.status}: ${r._count}`);

  if (doc.candidates.some((c) => c.intent)) {
    const intentSource = await ensureSource({
      kind: "AI_WEB_SEARCH",
      name: "Agent web research (stated need)",
      attribution: "A tender, request or funding announcement cited by an assistant and re-fetched by our own crawler, which found the quoted words on the page.",
    });
    for (const line of await applyIntents({ candidates: doc.candidates, runId: run.id, source: intentSource })) console.log(line);
    const after = await prisma.lead.count({ where: { discoveryRunId: run.id } });
    if (after !== leads) console.log(`leads after intents: ${after}`);
  }
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
