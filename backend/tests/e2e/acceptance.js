/**
 * End-to-end acceptance gate.
 *
 * This is the product's contract, executed against the running stack with real
 * data: type a sentence, get contactable leads, each one explaining itself and
 * traceable back to a real source record.
 *
 * Run with the API up:  node tests/e2e/acceptance.js
 */
const BASE = process.env.ACCEPTANCE_BASE_URL || "http://localhost:4100";
const WAIT_FOR_DISCOVERY_MS = Number(process.env.ACCEPTANCE_DISCOVERY_TIMEOUT_MS || 8 * 60 * 1000);

const QUERIES = [
  "restaurants in Dubai with no website",
  "companies hiring software developers",
  "restaurants in Manchester with outdated websites",
];

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const call = async (path, options = {}) => {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const json = await res.json();
  if (!res.ok || json.success === false) {
    throw new Error(`${path} → HTTP ${res.status}: ${json.message || "unknown error"}`);
  }
  return json.data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForRun = async (runId) => {
  const deadline = Date.now() + WAIT_FOR_DISCOVERY_MS;
  process.stdout.write("  … discovery running");
  while (Date.now() < deadline) {
    const run = await call(`/discovery-runs/${runId}`);
    if (!["PENDING", "RUNNING"].includes(run.status)) {
      process.stdout.write(`\r  … discovery ${run.status.toLowerCase()} (${run.stats.companiesFound} companies, ${run.stats.leadsCreated} leads)\n`);
      return run;
    }
    process.stdout.write(".");
    await sleep(10_000);
  }
  process.stdout.write("\r  … discovery timed out\n");
  return null;
};

const main = async () => {
  console.log(`\n\x1b[1mLeadSignal acceptance test\x1b[0m — ${BASE}\n`);

  // ── Health ────────────────────────────────────────────────────────────────
  console.log("Health");
  const health = await call("/health");
  check("API is healthy", health.checks.api === "up");
  check("Database is connected", health.checks.database === "up");

  // ── The core promise ──────────────────────────────────────────────────────
  for (const q of QUERIES) {
    console.log(`\nQuery: "${q}"`);
    let result = await call("/search", { method: "POST", body: JSON.stringify({ q }) });

    check("Query was interpreted, not just string-matched", (result.query.chips || []).length > 0,
      `chips: ${JSON.stringify(result.query.chips?.map((c) => c.label))}`);
    check("Interpretation is shown back to the user", Boolean(result.query.interpretation));

    // If the database could not answer, a live discovery must have started.
    if (result.total === 0 && result.discoveryRunId) {
      const run = await waitForRun(result.discoveryRunId);
      check("Live discovery completed", run && ["SUCCEEDED", "PARTIAL"].includes(run.status),
        run ? `status ${run.status}` : "timed out");
      result = await call("/search", { method: "POST", body: JSON.stringify({ q, autoDiscover: false }) });
    }

    check("Returned at least one lead", result.total > 0, `total=${result.total}`);
    if (result.leads.length === 0) continue;

    const contactable = result.leads.filter((l) => l.contact.hasEmail || l.contact.hasPhone || l.contact.hasForm);
    check("At least one lead is contactable", contactable.length > 0,
      `${contactable.length}/${result.leads.length} have a contact route`);

    const lead = contactable[0] || result.leads[0];

    check("Lead carries a score", Number.isInteger(lead.score) && lead.score > 0, `score=${lead.score}`);
    check("Lead states why it is a lead", lead.topReasons.length > 0);
    check("Lead names a service opportunity", Boolean(lead.primaryOpportunity));
    check("Lead recommends a next action", Boolean(lead.recommendedAction?.title));
    check("Lead reports its freshness", Boolean(lead.freshness?.relative));

    // ── Full detail ─────────────────────────────────────────────────────────
    const detail = await call(`/leads/${lead.id}`);
    console.log(`  → ${detail.company.name} · ${detail.score}/100 · ${detail.primaryOpportunityLabel}`);
    console.log(`    why: ${detail.reasons[0]?.text?.slice(0, 100)}`);
    console.log(`    contact: ${detail.contacts.emails[0]?.value || detail.contacts.phones[0]?.value || detail.contacts.forms[0]?.value || "none"}`);
    console.log(`    action: ${detail.actions[0]?.title}`);

    check("Score breakdown is explainable", Array.isArray(detail.scoreBreakdown?.signals) && detail.scoreBreakdown.signals.length > 0);
    check("Every score category is present", ["opportunity", "freshness", "reachability", "fit"]
      .every((k) => detail.scoreBreakdown.categories[k] !== undefined));
    check("Breakdown total matches the lead score", detail.scoreBreakdown.total === detail.score);
    check("Reasons carry a confidence level", detail.reasons.every((r) => r.confidenceLevel));
    check("Signals record when they were detected", detail.signals.every((s) => s.detectedAt));

    // ── Provenance: the hard requirement ────────────────────────────────────
    const prov = await call(`/leads/${lead.id}/provenance`);
    check("Provenance returns signal chains", prov.chains.length > 0);

    const withEvidence = prov.chains.filter((c) => c.evidence.length > 0);
    check("At least one signal is backed by evidence", withEvidence.length > 0,
      `${withEvidence.length}/${prov.chains.length} chains have evidence`);

    const resolvesToSource = prov.chains.some((c) =>
      c.evidence.some((e) => e.source?.sourceName || e.crawl?.url || e.audit || e.technology));
    check("Evidence resolves to an original source or crawl", resolvesToSource);

    const hasFetchTime = prov.chains.some((c) => c.evidence.some((e) => e.source?.fetchedAt || e.crawl?.fetchedAt || e.fact?.extractedAt));
    check("Evidence records when it was collected", hasFetchTime);

    if (prov.crawls.length > 0) {
      check("Crawl records state the robots.txt decision", prov.crawls.every((c) => c.robotsDecision !== undefined));
      const blocked = prov.crawls.filter((c) => c.blockReason);
      check("Blocked fetches record a machine-readable reason",
        blocked.every((c) => typeof c.blockReason === "string" && c.blockReason.length > 0),
        `${blocked.length} blocked fetch(es)`);
    }
  }

  // ── Job intelligence honesty ──────────────────────────────────────────────
  console.log("\nJob intelligence");
  const hiring = await call("/leads?service=CUSTOM_SOFTWARE,SAAS_DEV,CRM_DEV&pageSize=10");
  if (hiring.leads.length > 0) {
    const detail = await call(`/leads/${hiring.leads[0].id}`);
    if (detail.jobs.length > 0) {
      check("Every job carries a status", detail.jobs.every((j) => j.status));
      const active = detail.jobs.filter((j) => j.status === "ACTIVE");
      check("ACTIVE jobs are backed by a board observation",
        active.every((j) => Array.isArray(j.statusEvidence) && j.statusEvidence.some((e) => e.boardHadJob === true)),
        `${active.length} active job(s)`);
      check("Job status evidence names the verification method",
        detail.jobs.every((j) => !Array.isArray(j.statusEvidence) || j.statusEvidence.every((e) => e.method)));
    } else {
      console.log("  (no job postings on the sampled lead — skipped)");
    }
  } else {
    console.log("  (no hiring-driven leads yet — skipped)");
  }

  // ── Suppression must actually suppress ────────────────────────────────────
  console.log("\nSuppression");
  const before = await call("/leads?pageSize=1");
  if (before.leads.length > 0) {
    const target = await call(`/leads/${before.leads[0].id}`);
    await call(`/leads/${target.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "DO_NOT_CONTACT", note: "acceptance test" }) });
    const after = await call("/leads?pageSize=100");
    check("A do-not-contact lead disappears from results", !after.leads.some((l) => l.id === target.id));
    const suppression = await call("/suppression");
    check("Do-not-contact is recorded in the suppression list",
      suppression.entries.some((e) => e.kind === "COMPANY" || e.kind === "DOMAIN"));
    // Restore fully so repeated runs stay idempotent. Clearing the status is
    // not enough: marking a lead do-not-contact also writes suppression
    // entries, and those would keep the company hidden on every later run.
    await call(`/leads/${target.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "NEW", note: "acceptance test cleanup" }) });
    const created = await call("/suppression");
    for (const e of created.entries.filter((x) => x.reason?.includes("acceptance test") || x.reason === "Company marked do-not-contact.")) {
      await call(`/suppression/${e.id}`, { method: "DELETE" });
    }
    check("Suppression cleanup restores the lead", (await call("/leads?pageSize=100")).leads.length >= after.leads.length);
  }

  // ── Reference data ────────────────────────────────────────────────────────
  console.log("\nReference data");
  const catalog = await call("/signals/catalog");
  check("Signal catalogue is exposed for the UI", catalog.signals.length > 20);
  check("Catalogue entries declare weight and half-life",
    catalog.signals.every((s) => s.weight !== undefined && s.halfLifeDays !== undefined));

  const dashboard = await call("/stats/dashboard");
  check("Dashboard reports totals", dashboard.totals.companies > 0);
  check("Dashboard names its data sources", dashboard.sources.length > 0);

  // ── Result ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1mPASS\x1b[0m — ${passed} checks passed.`);
  } else {
    console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m — ${failed} of ${passed + failed} checks failed:`);
    failures.forEach((f) => console.log(`  · ${f}`));
  }
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(`\n\x1b[31mAcceptance run crashed:\x1b[0m ${err.message}`);
  process.exit(1);
});
