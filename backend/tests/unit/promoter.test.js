import { describe, it, expect } from "vitest";
import { normalizeProductUrl, htmlToText, keepOnlyFetchedSources } from "../../lib/promoter/productResearch.js";
import { normaliseIcp, icpIsUsable, icpToParsedQuery, icpToSearchStrategies } from "../../lib/promoter/icp.js";
import { buildPromotePlan } from "../../lib/nlquery/planner.js";
import { productInitialTemplate } from "../../lib/research/templates.js";
import { buildPromoteComposeUser, buildProductBlock, PROMOTE_COMPOSE_SCHEMA } from "../../lib/research/prompts.js";

/**
 * The SaaS promoter.
 *
 * Two invariants carry most of the risk in this feature and are what these
 * tests exist to hold down:
 *
 *   1. Nothing is sourced against an ICP nobody approved. The gate is enforced
 *      in the planner as well as the API, because the consequence of skipping
 *      it is real email to real strangers chosen by a profile nobody read.
 *   2. Product copy and recipient facts never merge. The model may state
 *      anything about the product and nothing about the reader that is not in
 *      that reader's own numbered facts.
 */

// A realistic worked example throughout: the HR platform this was built for.
const TRACEFY_ICP = {
  summary: "HR or ops lead at a 10-250 person company still running payroll on spreadsheets",
  industries: ["Software agencies", "Outsourcing firms", "restaurant"],
  companySize: { min: 10, max: 250, note: "Flat-rate plans cap at 250 employees." },
  geographies: [
    { region: "United Arab Emirates", countryCode: "AE", reason: "Arabic UI and AED payroll", priority: 1 },
    { region: "Saudi Arabia", countryCode: "SA", reason: "Arabic UI", priority: 2 },
  ],
  buyerTitles: { decisionMakers: ["HR Manager", "Founder"], champions: ["Office Manager"] },
  painPoints: [{ pain: "Payroll lives in spreadsheets", productAnswer: "Automated multi-currency payroll" }],
  buyingSignals: [
    { signal: "Hiring an HR manager", detectableVia: "JOB_POSTING", signalKey: "HIRING_HR_ROLE" },
    { signal: "Recently founded", detectableVia: "COMPANY_AGE", signalKey: "NEW_DOMAIN" },
  ],
  disqualifiers: ["HR software vendors"],
  competitorsToDisplace: ["BambooHR", "Rippling"],
  suggestedSearchQueries: [
    { label: "Hiring HR roles", searchInstruction: "Find UAE companies advertising a first HR hire.", expectedSourceTypes: ["JOB_BOARD"] },
    { label: "Agency directories", searchInstruction: "Find Dubai agency directories listing 10-250 person firms.", expectedSourceTypes: ["DIRECTORY"] },
  ],
};

const approvedProduct = (icp = TRACEFY_ICP) => ({
  id: "p1",
  name: "TracefyHR",
  url: "https://tracefyhr.com",
  icp,
  icpApprovedAt: new Date(),
});

// ─── URL normalisation ────────────────────────────────────────────────────────

describe("normalizeProductUrl", () => {
  it("reduces every way of writing one site to a single key", () => {
    // The dedupe key for PromotedProduct.url. If these disagreed, pasting the
    // pricing page would create a second product with its own runs and drafts.
    for (const input of [
      "tracefyhr.com", "www.tracefyhr.com", "https://tracefyhr.com/",
      "HTTPS://TraceFyHR.com/pricing?utm_source=x", "  http://www.tracefyhr.com/features  ",
    ]) {
      expect(normalizeProductUrl(input), input).toBe("https://tracefyhr.com");
    }
  });

  it("refuses anything that is not a public website", () => {
    for (const input of [
      "", "   ", "not a url", "javascript:alert(1)", "file:///etc/passwd",
      "localhost", "http://localhost:3000", "http://127.0.0.1", "http://192.168.1.10",
      "ftp://example.com", null, undefined, 42,
    ]) {
      expect(normalizeProductUrl(input), String(input)).toBeNull();
    }
  });
});

// ─── Page text ────────────────────────────────────────────────────────────────

describe("htmlToText", () => {
  it("drops code and markup but keeps the words a reader would see", () => {
    const text = htmlToText(`
      <html><head><style>.a{color:red}</style><script>var x = "pricing";</script></head>
      <body><!-- hidden --><h1>Run HR in 15 minutes a week</h1>
      <p>Starter is $20&nbsp;/month for up&nbsp;to 50 employees.</p>
      <svg><path d="M0 0"/></svg></body></html>`);

    expect(text).toContain("Run HR in 15 minutes a week");
    expect(text).toContain("$20");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
    expect(text).not.toContain("hidden");
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toContain("&nbsp;");
  });

  it("survives empty and malformed input rather than throwing", () => {
    for (const input of ["", null, undefined, "<p>unclosed", "<<>>"]) {
      expect(() => htmlToText(input)).not.toThrow();
    }
  });
});

describe("keepOnlyFetchedSources", () => {
  it("strips a source URL the crawl never actually retrieved", () => {
    // The same citation guard the AI research layer uses. A model that cites a
    // plausible page it never read is the failure this catches.
    const fetched = ["https://tracefyhr.com", "https://tracefyhr.com/pricing"];
    const kept = keepOnlyFetchedSources(
      [
        { value: "Flat-rate pricing", sourceUrl: "https://tracefyhr.com/pricing" },
        { value: "Used by 10,000 companies", sourceUrl: "https://tracefyhr.com/invented-case-study" },
      ],
      fetched,
    );

    expect(kept[0].sourceUrl).toBe("https://tracefyhr.com/pricing");
    expect(kept[1].sourceUrl).toBeNull();
    // The claim itself survives — only its unearned provenance is removed.
    expect(kept).toHaveLength(2);
  });
});

// ─── The ICP ──────────────────────────────────────────────────────────────────

describe("normaliseIcp", () => {
  it("never throws on a hand-edited profile, however broken", () => {
    for (const input of [null, undefined, {}, [], "text", 7, { industries: "not an array" }, { geographies: [null, 3] }]) {
      expect(() => normaliseIcp(input), JSON.stringify(input)).not.toThrow();
      const out = normaliseIcp(input);
      expect(Array.isArray(out.industries)).toBe(true);
      expect(Array.isArray(out.suggestedSearchQueries)).toBe(true);
    }
  });

  it("caps every list, because this JSON is interpolated into prompt text", () => {
    const out = normaliseIcp({
      industries: Array.from({ length: 40 }, (_, i) => `industry ${i}`),
      suggestedSearchQueries: Array.from({ length: 40 }, (_, i) => ({ label: `l${i}`, searchInstruction: `find ${i}` })),
    });
    expect(out.industries.length).toBeLessThanOrEqual(8);
    expect(out.suggestedSearchQueries.length).toBeLessThanOrEqual(5);
  });

  it("puts a reversed headcount range back in order", () => {
    const out = normaliseIcp({ companySize: { min: 250, max: 10 } });
    expect(out.companySize.min).toBeLessThanOrEqual(out.companySize.max);
  });
});

describe("icpIsUsable", () => {
  it("refuses a profile that would search for nothing", () => {
    expect(icpIsUsable(TRACEFY_ICP)).toBe(true);
    expect(icpIsUsable({ ...TRACEFY_ICP, suggestedSearchQueries: [] })).toBe(false);
    expect(icpIsUsable(null)).toBe(false);
  });
});

describe("icpToParsedQuery", () => {
  const parsed = icpToParsedQuery(TRACEFY_ICP);

  it("produces the shape every downstream step already reads", () => {
    for (const key of ["industries", "location", "signals", "technologies", "excludeTechnologies",
                       "service", "jobTitleContains", "postedWithinDays", "freeText"]) {
      expect(parsed.query, key).toHaveProperty(key);
    }
    expect(parsed.confidence).toBe(1);
  });

  it("marks the run as promoting a product", () => {
    expect(parsed.query.service).toBe("SAAS_PRODUCT");
  });

  it("takes the highest-priority geography and carries its country", () => {
    expect(parsed.query.location?.name).toBe("United Arab Emirates");
    expect(parsed.query.location?.countryCode).toBe("AE");
  });

  it("keeps only vocabulary the engine actually holds", () => {
    // "Software agencies" and "Outsourcing firms" are free text a human typed;
    // "restaurant" is a real OSM category key. Passing the free text through
    // would filter every company out and report an empty run.
    expect(parsed.query.industries).toContain("restaurant");
    expect(parsed.query.industries).not.toContain("Software agencies");

    const invented = icpToParsedQuery({
      ...TRACEFY_ICP,
      buyingSignals: [{ signal: "x", detectableVia: "SIGNAL_CATALOG", signalKey: "NOT_A_REAL_SIGNAL" }],
    });
    expect(invented.query.signals).toEqual([]);
  });

  it("turns a hiring signal into job titles the database can match", () => {
    expect(parsed.query.jobTitleContains.length).toBeGreaterThan(0);
    expect(parsed.query.jobTitleContains.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it("never turns the prose of a signal into a job-title needle", () => {
    // A buying signal is a sentence describing an event, not a title. Splitting
    // one into words produced needles like "advertising", "first" and "role" —
    // and because the filter does a `contains` against the title, the first of
    // those matched every Advertising Manager vacancy in the market.
    const wordy = icpToParsedQuery({
      ...TRACEFY_ICP,
      buyerTitles: { decisionMakers: [], champions: [] },
      buyingSignals: [
        { signal: "Advertising a first or additional HR, payroll or admin role", detectableVia: "JOB_POSTING", signalKey: "HIRING_HR_ROLE" },
      ],
    }).query.jobTitleContains;

    for (const junk of ["advertising", "first", "additional", "role"]) {
      expect(wordy, junk).not.toContain(junk);
    }
    // What it should keep is the role the sentence actually names.
    expect(wordy.some((n) => n.trim() === "hr" || n === "payroll")).toBe(true);
  });

  it("contributes nothing from a signal sentence that names no known role", () => {
    const vague = icpToParsedQuery({
      ...TRACEFY_ICP,
      buyerTitles: { decisionMakers: [], champions: [] },
      buyingSignals: [
        { signal: "Growing quickly and opening a second location", detectableVia: "JOB_POSTING", signalKey: null },
      ],
    }).query.jobTitleContains;
    expect(vague).toEqual([]);
  });
});

describe("icpToSearchStrategies", () => {
  it("maps approved searches onto the strategy shape discovery already uses", () => {
    const strategies = icpToSearchStrategies(TRACEFY_ICP);
    expect(strategies.length).toBe(2);
    for (const s of strategies) {
      expect(s).toHaveProperty("label");
      expect(s).toHaveProperty("searchInstruction");
      expect(Array.isArray(s.expectedSourceTypes)).toBe(true);
    }
  });
});

// ─── The plan ─────────────────────────────────────────────────────────────────

const kinds = (plan) => plan.steps.map((s) => s.kind);

describe("buildPromotePlan", () => {
  it("refuses to plan anything for an unapproved profile", () => {
    // The gate, at the layer that decides what work happens. A run launched
    // from a stale browser tab or a script must hit it exactly as a button does.
    expect(() => buildPromotePlan({ ...approvedProduct(), icpApprovedAt: null })).toThrow();
    expect(() => buildPromotePlan(null)).toThrow();
  });

  it("starts from what the database already knows", () => {
    expect(kinds(buildPromotePlan(approvedProduct()))[0]).toBe("DB_MATCH");
  });

  it("marks itself as a promote run so the runner gives it the long deadline", () => {
    expect(buildPromotePlan(approvedProduct()).mode).toBe("PROMOTE");
  });

  it("runs the hiring engines when the ICP names a job posting as evidence", () => {
    // Hiring is the strongest publicly detectable buying signal for most B2B
    // SaaS, and it is the one this codebase ingests best.
    const k = kinds(buildPromotePlan(approvedProduct()));
    expect(k).toContain("AGGREGATOR");
    expect(k).toContain("ATS_PROBE");
  });

  it("leaves the hiring engines out when the ICP does not ask for them", () => {
    const k = kinds(buildPromotePlan(approvedProduct({
      ...TRACEFY_ICP,
      buyingSignals: [{ signal: "Uses Shopify", detectableVia: "TECH_STACK", signalKey: null }],
    })));
    expect(k).not.toContain("AGGREGATOR");
  });

  it("skips the map engine rather than sampling unrelated businesses", () => {
    // buildResearchPlan falls back to restaurants and clothes shops when a query
    // names no industry. For a promote run that is worse than nothing: it would
    // pitch HR software to whatever happened to be on the map.
    const k = kinds(buildPromotePlan(approvedProduct({ ...TRACEFY_ICP, industries: ["Software agencies"] })));
    expect(k).not.toContain("OVERPASS");
  });

  it("verifies before it scores, and composes last", () => {
    // A business discovered to be closed after SCORE would arrive too late to
    // stop the lead being ranked and drafted for outreach.
    const k = kinds(buildPromotePlan(approvedProduct()));
    expect(k.slice(-6)).toEqual(["AI_VERIFY", "PLACES_VERIFY", "SIGNALS", "SCORE", "AI_COMPOSE", "SNAPSHOT"]);
  });

  it("keeps at least one discovery engine that survives an AI outage", () => {
    const k = kinds(buildPromotePlan(approvedProduct()));
    expect(k.filter((x) => ["DB_MATCH", "AGGREGATOR", "ATS_PROBE", "OVERPASS"].includes(x)).length).toBeGreaterThanOrEqual(2);
  });

  it("numbers its steps consecutively from zero", () => {
    // createDiscoveryRun stores steps by ordinal and the runner matches plan
    // params back to them by that number; a gap silently drops a step's params.
    const plan = buildPromotePlan(approvedProduct());
    expect(plan.steps.map((s) => s.ordinal)).toEqual(plan.steps.map((_, i) => i));
  });
});

// ─── Composition ──────────────────────────────────────────────────────────────

const PRODUCT = {
  id: "p1",
  name: "TracefyHR",
  summary: "An all-in-one HR platform covering payroll, leave and hiring.",
  pitchAngle: "Run HR in 15 minutes a week instead of across five tools.",
  features: [{ value: "Multi-currency payroll" }, { value: "Leave tracking" }],
  pricing: [{ plan: "Starter", price: "$20/month", capacity: "up to 50 employees" }],
  differentiators: [{ value: "Flat-rate pricing, not per seat" }],
  senderContext: "Writing on behalf of TracefyHR.",
};

const FACTS = [
  { id: 1, text: "Balfour Beta Ltd is a staffing agency in Dubai.", confidenceLevel: "VERIFIED", observedAt: "2 days ago" },
  { id: 2, text: "It is currently hiring: HR Manager.", confidenceLevel: "VERIFIED", observedAt: "yesterday" },
];

describe("buildPromoteComposeUser", () => {
  const user = buildPromoteComposeUser({
    product: PRODUCT,
    leads: [{ index: 1, companyName: "Balfour Beta Ltd", recipientHint: "role account — do not address a named person", facts: FACTS, city: "Dubai", countryCode: "AE" }],
  });

  it("hands the model the product and the recipient as separate blocks", () => {
    // The one failure mode specific to promoting: a product claim leaking into
    // a sentence about the reader ("your payroll takes 15 minutes").
    expect(user).toContain("PRODUCT");
    expect(user.indexOf("PRODUCT")).toBeLessThan(user.indexOf("COMPANIES TO WRITE TO"));
    expect(user).toContain("Balfour Beta Ltd");
    expect(user).toContain("[2] It is currently hiring: HR Manager.");
  });

  it("carries the pitch angle and a real price rather than the whole feature list", () => {
    const block = buildProductBlock({ product: PRODUCT });
    expect(block).toContain("Run HR in 15 minutes a week");
    expect(block).toContain("$20/month");
  });

  it("keeps the batch schema the compose pipeline already validates against", () => {
    expect(PROMOTE_COMPOSE_SCHEMA.properties.emails.items.required).toContain("factIdsUsed");
    expect(PROMOTE_COMPOSE_SCHEMA.properties.emails.items.required).toContain("leadIndex");
  });
});

describe("productInitialTemplate", () => {
  const draft = productInitialTemplate({
    company: { name: "Balfour Beta Ltd", city: "Dubai", countryCode: "AE" },
    facts: FACTS,
    product: PRODUCT,
  });

  it("writes a subject and a body from the lead's own facts", () => {
    expect(draft.subject.length).toBeGreaterThan(0);
    expect(draft.body.length).toBeGreaterThan(0);
    expect(draft.factIdsUsed.every((id) => FACTS.some((f) => f.id === id))).toBe(true);
  });

  it("never puts a link in a first email", () => {
    // Links in cold first contact measurably hurt deliverability, and Gmail now
    // rejects rather than filters what it distrusts. Proof belongs in follow-up.
    expect(draft.body).not.toMatch(/https?:\/\//);
    expect(draft.body).not.toMatch(/www\./);
  });

  it("invents no contact detail", () => {
    expect(draft.body).not.toMatch(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  });

  it("stays short enough to answer on a phone", () => {
    const words = draft.body.split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(120);
  });

  it("does not assert anything about the recipient that the facts do not say", () => {
    // The product may claim "15 minutes a week". The email may not turn that
    // into a claim that this company currently spends longer.
    expect(draft.body).not.toMatch(/your (payroll|HR) (takes|costs|is)/i);
  });
});
