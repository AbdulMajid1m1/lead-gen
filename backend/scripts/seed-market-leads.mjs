/**
 * Batch research runner — EU / UK / Gulf market sweep.
 *
 * Runs the same pipeline as POST /api/research, but sequentially and awaited,
 * so a long sweep can execute outside the request/response cycle without two
 * runs ever competing for the crawler on a 2-vCPU box with no swap.
 *
 * Usage (inside the api container):
 *   node scripts/seed-market-leads.mjs --list
 *   node scripts/seed-market-leads.mjs --only 1
 *   node scripts/seed-market-leads.mjs --from 2 --to 20
 *
 * Every run is idempotent at the data layer: companies, contacts, people and
 * signals all upsert on natural keys, so re-running a query refreshes evidence
 * rather than duplicating it.
 */
import prisma from "../prismaClient.js";
import { parseQuery, describeQuery } from "../lib/nlquery/parser.js";
import { buildResearchPlan } from "../lib/nlquery/planner.js";
import { buildBrief, saveBrief } from "../lib/research/brief.js";
import { createDiscoveryRun, startDiscoveryRun } from "../lib/discovery/runner.js";
import { isResearchAvailable, CostTracker } from "../lib/llm/responses.js";
import { isPlacesAvailable } from "../lib/adapters/googlePlaces.js";

/** The ranked sweep. Order matters: tier one first, so a halted run still lands the best leads. */
const QUERIES = [
  "companies hiring CRM specialists in London this month",
  "companies hiring AI engineers in London this month",
  "companies hiring AI engineers in Berlin this month",
  "companies hiring mobile developers in London this month",
  "companies hiring ecommerce manager in London this month",
  "real estate agencies in London with outdated websites",
  "hotels in Dubai with no online booking",
  "travel agencies in Dubai with no website",
  "dental clinics in London with no online booking",
  "law firms in Berlin with outdated websites",
  "medical clinics in Dubai with no online booking",
  "law firms in London with outdated websites",
  "companies hiring software developers in Munich this month",
  "accounting firms in London with outdated websites",
  "car dealerships in Birmingham with outdated websites",
  "hotels in Dubai with no website",
  "car dealerships in Dubai with no website",
  "companies hiring aggressively in Berlin this month",
  "companies hiring HR managers in London this month",
  "schools in Riyadh with no website",
];

const TERMINAL = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the run row until the runner marks it terminal. */
const awaitRun = async (runId, { pollMs = 5000, hardCapMs = 20 * 60 * 1000 } = {}) => {
  const started = Date.now();
  for (;;) {
    const run = await prisma.discoveryRun.findUnique({
      where: { id: runId },
      select: { status: true, stats: true },
    });
    if (!run) throw new Error(`run ${runId} vanished`);
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() - started > hardCapMs) {
      return { status: `TIMEOUT_WAITING(${run.status})`, stats: run.stats };
    }
    await sleep(pollMs);
  }
};

/** What this run actually produced, counted from the rows it wrote. */
const summarise = async (runId) => {
  const leads = await prisma.lead.findMany({
    where: { discoveryRunId: runId },
    select: {
      score: true,
      companyId: true,
      company: {
        select: {
          name: true,
          countryCode: true,
          people: { select: { fullName: true, title: true, seniority: true } },
          contacts: { where: { isSuppressed: false }, select: { kind: true, roleHint: true } },
        },
      },
    },
  });

  const withPerson = leads.filter((l) => (l.company?.people?.length ?? 0) > 0);
  const withEmail = leads.filter((l) =>
    (l.company?.contacts ?? []).some((c) => c.kind === "EMAIL" && c.roleHint !== "NON_OUTREACH"));
  const withPhone = leads.filter((l) => (l.company?.contacts ?? []).some((c) => c.kind === "PHONE"));
  const avg = leads.length
    ? Math.round((leads.reduce((s, l) => s + l.score, 0) / leads.length) * 10) / 10
    : 0;

  return {
    leads: leads.length,
    withPerson: withPerson.length,
    withEmail: withEmail.length,
    withPhone: withPhone.length,
    avgScore: avg,
    sample: leads
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((l) => {
        const p = l.company?.people?.[0];
        return `${l.company?.name} (${l.score})${p ? ` — ${p.fullName}${p.title ? `, ${p.title}` : ""}` : ""}`;
      }),
  };
};

/** One query, start to finish. Mirrors startResearch() in researchController.js. */
const runOne = async (q, label) => {
  const parsed = parseQuery(q);
  const tracker = new CostTracker();
  const { brief, producedBy, model } = await buildBrief({ rawQuery: q, parsed, tracker });

  const searchQuery = await prisma.searchQuery.create({
    data: {
      rawText: q.slice(0, 1000),
      parsed: { query: parsed.query, chips: parsed.chips, confidence: parsed.confidence, brief },
      parserUsed: producedBy === "LLM" ? "LLM" : "DETERMINISTIC",
    },
  });

  const plan = buildResearchPlan(parsed, brief);
  const run = await createDiscoveryRun({ plan, trigger: "NL_QUERY", searchQueryId: searchQuery.id });
  await saveBrief({ runId: run.id, searchQueryId: searchQuery.id, brief, producedBy, model });

  console.log(`${label} ${q}`);
  console.log(`     read as: ${describeQuery(parsed)}`);
  console.log(`     run ${run.id} · ${plan.steps.length} steps · brief ${producedBy}`);

  const t0 = Date.now();
  startDiscoveryRun(run.id, parsed);
  const finished = await awaitRun(run.id);
  const secs = Math.round((Date.now() - t0) / 1000);

  const s = await summarise(run.id);
  console.log(
    `     ${finished.status} in ${secs}s — ${s.leads} leads · ${s.withPerson} named person · ` +
    `${s.withEmail} email · ${s.withPhone} phone · avg score ${s.avgScore}`,
  );
  for (const line of s.sample) console.log(`       · ${line}`);
  console.log("");

  return { q, runId: run.id, status: finished.status, secs, ...s };
};

const main = async () => {
  if (hasFlag("list")) {
    QUERIES.forEach((q, i) => console.log(`${String(i + 1).padStart(2, "0")}  ${q}`));
    return;
  }

  const only = arg("only");
  const from = Number(arg("from", 1));
  const to = Number(arg("to", QUERIES.length));
  const gapMs = Number(arg("gap", 20)) * 1000;

  const selected = only
    ? [[Number(only) - 1, QUERIES[Number(only) - 1]]]
    : QUERIES.map((q, i) => [i, q]).slice(from - 1, to);

  console.log("─".repeat(72));
  console.log(`LeadSignal market sweep · ${selected.length} queries`);
  console.log(`AI brief: ${isResearchAvailable() ? "available" : "UNAVAILABLE (deterministic briefs)"}`);
  console.log(`Google Places: ${isPlacesAvailable() ? "available" : "UNAVAILABLE (no closed-business check)"}`);
  console.log("─".repeat(72) + "\n");

  const results = [];
  for (const [idx, q] of selected) {
    const label = `[${String(idx + 1).padStart(2, "0")}/${QUERIES.length}]`;
    try {
      results.push(await runOne(q, label));
    } catch (err) {
      console.error(`${label} FAILED: ${err.message}\n`);
      results.push({ q, status: "SCRIPT_ERROR", error: err.message, leads: 0, withPerson: 0 });
    }
    // Breathing room between runs: the box is shared and has no swap.
    if (gapMs > 0) await sleep(gapMs);
  }

  console.log("─".repeat(72));
  console.log("SWEEP COMPLETE");
  const totals = results.reduce((a, r) => ({
    leads: a.leads + (r.leads || 0),
    person: a.person + (r.withPerson || 0),
    email: a.email + (r.withEmail || 0),
  }), { leads: 0, person: 0, email: 0 });
  console.log(`${totals.leads} leads · ${totals.person} with a named person · ${totals.email} with an email`);
  for (const r of results) {
    console.log(`  ${String(r.status).padEnd(22)} ${String(r.leads ?? 0).padStart(4)} leads  ${r.q}`);
  }
  console.log("─".repeat(72));
};

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
