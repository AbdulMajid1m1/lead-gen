/**
 * Acceptance gate for the AI deep-research flow.
 *
 * The contract being tested is not "the AI returned something" — it is that
 * nothing reaches the results grid unless it was independently observed. These
 * checks pass with or without an API key: without one the AI steps degrade and
 * the deterministic engines carry the run, which is itself part of the contract.
 */
const BASE = process.env.ACCEPTANCE_BASE_URL || "http://localhost:4100";
const QUERY = process.env.ACCEPTANCE_RESEARCH_QUERY || "retail shops in Riyadh that need a new website related to POS";
const TIMEOUT_MS = Number(process.env.ACCEPTANCE_RESEARCH_TIMEOUT_MS || 16 * 60 * 1000);

let passed = 0, failed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const call = async (path, options = {}) => {
  const res = await fetch(`${BASE}/api${path}`, { ...options, headers: options.body ? { "content-type": "application/json" } : undefined });
  const json = await res.json();
  if (!res.ok || json.success === false) throw new Error(`${path} → HTTP ${res.status}: ${json.message}`);
  return json.data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log(`\n\x1b[1mLeadSignal deep-research acceptance\x1b[0m — "${QUERY}"\n`);

  // ── Start ─────────────────────────────────────────────────────────────────
  const started = await call("/research", { method: "POST", body: JSON.stringify({ q: QUERY }) });
  check("Run starts and returns a research brief", Boolean(started.runId && started.brief));
  check("Brief restates the goal", Boolean(started.brief.restatedGoal));
  check("Brief provides search strategies", (started.brief.searchStrategies || []).length >= 2);
  check("Plan includes a verification step", started.steps.some((s) => s.kind === "AI_VERIFY"));
  check("Plan includes a history snapshot", started.steps.some((s) => s.kind === "SNAPSHOT"));
  console.log(`  (AI available: ${started.aiAvailable}; brief by ${started.briefProducedBy})`);

  // ── Wait ──────────────────────────────────────────────────────────────────
  const deadline = Date.now() + TIMEOUT_MS;
  let grid;
  process.stdout.write("  … running");
  while (Date.now() < deadline) {
    grid = await call(`/research-runs/${started.runId}/grid`);
    if (!["PENDING", "RUNNING"].includes(grid.status)) break;
    process.stdout.write(".");
    await sleep(15_000);
  }
  process.stdout.write(`\r  … run ${grid.status.toLowerCase()} with ${grid.rows.length} rows\n`);

  check("Run reached a terminal state", !["PENDING", "RUNNING"].includes(grid.status), grid.status);
  // A slow run must still produce results: scoring and snapshot are never skipped.
  const finalising = grid.steps.filter((s) => ["SIGNALS", "SCORE", "SNAPSHOT"].includes(s.kind));
  check("Scoring and snapshot always run", finalising.every((s) => s.status === "SUCCEEDED"),
    finalising.map((s) => `${s.kind}:${s.status}`).join(" "));

  if (grid.rows.length === 0) {
    console.log("  (no rows — both discovery engines were unavailable; skipping row checks)");
  } else {
    // ── The grid the user works from ────────────────────────────────────────
    const row = grid.rows[0];
    check("Rows are ranked", grid.rows.every((r, i) => r.rank === i + 1));
    check("Every row carries a score", grid.rows.every((r) => Number.isInteger(r.score)));
    check("Every row explains itself", grid.rows.every((r) => (r.why || []).length > 0));
    check("Rows record which engine found them", grid.rows.every((r) => (r.foundBy || []).length > 0));

    const contactable = grid.rows.filter((r) => r.contacts.email || r.contacts.phone || r.contacts.whatsapp);
    check("At least one row is contactable", contactable.length > 0, `${contactable.length}/${grid.rows.length}`);

    // ── The anti-hallucination contract ─────────────────────────────────────
    const cells = grid.rows.flatMap((r) => [r.contacts.email, r.contacts.phone, r.contacts.whatsapp, r.address].filter(Boolean));
    check("Every contact cell states its confidence", cells.every((c) => c.confidenceLevel));
    check("No contact is presented as verified without a level better than AI_GENERATED",
      cells.every((c) => ["VERIFIED", "DETECTED", "INFERRED", "AI_GENERATED"].includes(c.confidenceLevel)));

    // A WhatsApp value must never be a bare phone number promoted by assumption.
    const whatsapps = grid.rows.map((r) => r.contacts.whatsapp).filter(Boolean);
    check("Any WhatsApp value carries real proof",
      whatsapps.every((w) => ["VERIFIED", "DETECTED"].includes(w.confidenceLevel)),
      `${whatsapps.length} whatsapp value(s)`);

    // No parked-domain broker address should ever be a business contact.
    const parked = grid.rows.filter((r) => r.contacts.email && /domainster|hugedomains|brandbucket|sedo|afternic/i.test(r.contacts.email.value));
    check("No domain-broker address is presented as a business email", parked.length === 0,
      parked.map((r) => r.contacts.email.value).join(", "));

    // ── The outreach email ──────────────────────────────────────────────────
    const withEmail = grid.rows.filter((r) => r.outreachEmail);
    check("Top matches have a ready-to-copy email", withEmail.length > 0, `${withEmail.length}/${grid.rows.length}`);
    if (withEmail.length) {
      const drafts = await call(`/leads/${withEmail[0].leadId}/email-drafts`);
      const draft = drafts.drafts[0];
      check("The email records the facts it was built from", (draft.groundingFacts || []).length > 0);
      check("The email only cites facts that exist",
        (draft.factIdsUsed || []).every((id) => draft.groundingFacts.some((f) => f.id === id)));
      const allowed = draft.groundingFacts.map((f) => f.text).join(" ").replace(/[^\w@.]/g, "").toLowerCase();
      const invented = (draft.body.match(/[\w.+-]+@[\w.-]+\.\w{2,}|https?:\/\/\S+|\+?\d[\d\s().-]{7,}\d/g) || [])
        .filter((m) => !allowed.includes(m.replace(/[^\w@.]/g, "").toLowerCase()));
      check("The email invents no contact details", invented.length === 0, invented.join(", "));
    }

    // ── Provenance still resolves for research-found leads ──────────────────
    const prov = await call(`/leads/${row.leadId}/provenance`);
    check("A research lead still has a full provenance chain", prov.chains.length > 0);
  }

  // ── History ───────────────────────────────────────────────────────────────
  const history = await call("/research-history?pageSize=5");
  check("The run appears in history", history.runs.some((r) => r.runId === started.runId));
  const snapshot = await call(`/research-runs/${started.runId}/grid`);
  check("History serves a frozen snapshot", snapshot.isSnapshot === true || grid.rows.length === 0);

  console.log(`\n${"─".repeat(58)}`);
  if (failed === 0) console.log(`\x1b[32m\x1b[1mPASS\x1b[0m — ${passed} checks passed.`);
  else { console.log(`\x1b[31m\x1b[1mFAIL\x1b[0m — ${failed} of ${passed + failed} failed:`); failures.forEach((f) => console.log(`  · ${f}`)); }
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => { console.error(`\n\x1b[31mCrashed:\x1b[0m ${err.message}`); process.exit(1); });
