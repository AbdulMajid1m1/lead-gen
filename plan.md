# SaaS Promoter — Feature Plan

**Status:** BUILT. Phase 1 implemented and shipped 2026-08-28. See §11 for what was actually built and how the open questions were resolved.
**Date:** 2026-08-28
**Worked example:** https://tracefyhr.com/ (all-in-one HR platform, flat-rate pricing, 5–250 employee companies, Arabic/multi-currency support)

---

## 1. What this feature is

A new mode in LeadSignal: the user pastes a SaaS product URL into a search bar. The system then:

1. **Researches the product** — crawls the site, extracts what it does, pricing, positioning, proof points.
2. **Derives the ICP** (Ideal Customer Profile) — who buys this, their titles, company size, industries, geography, pain points. **User reviews and edits the ICP before anything else runs.**
3. **Sources authentic leads** matching the ICP — companies + named decision-makers with verified contact info, through the existing provenance/verification pipeline (no purchased lists, no unverified AI claims).
4. **Composes personalized outreach** — product-pitch emails grounded in verified facts about each lead, referencing why *this* product solves *their* problem. **User reviews drafts before send.**
5. **Sends via the existing campaign engine** — same legal gate (`sendPolicy.js`), same pacing, caps, suppression, and follow-up machinery.

This is a generalization of what the codebase already anticipates: `enums.prisma` added `HR_SOFTWARE` as a `ServiceType` specifically so "a SaaS like TracefyHR can be sold through the same engine." SaaS Promoter turns that one-off into a first-class mode where *any* product URL becomes a promotable offering.

---

## 2. Research findings that shape this plan

Summary of deep research (Reddit/r/coldemail practitioner reports, Hunter's State of Cold Email 2025, provider benchmarks, 11x AI-SDR case study, Meta/legal docs):

### What works
- **Small, hyper-segmented lists beat volume.** Campaigns ≤50 recipients get ~5.8% reply rates vs 2.1% for 1,000+ blasts. Our existing 500-recipient campaign cap and pacing are already aligned.
- **Relevance beats flattery.** "I noticed you're hiring 3 recruiters" (a reason to email *now*) works; AI-generated "love what you're building!" is instantly recognized and ignored. Personalization must come from a verified, specific signal.
- **Intent signals are the highest-value lead source:** companies hiring for roles the product serves (we already have ATS + job aggregator ingestion — a huge advantage), competitor-review activity, and expressed pain in communities.
- **2–3 follow-ups, then stop** (replies 3.0% → 4.9%; unsubscribes spike after 3). Plain text, no links in email #1, no open-tracking pixels (they correlate with *lower* replies).
- **Human review gates** after ICP generation and before send are where every serious pipeline (11x, n8n community stacks) puts humans. Cheapest places to fix errors.

### What does NOT work / must be avoided
- **Single-source lead databases are junk raw.** Independent tests: Apollo "verified" exports bounce 32–38%, Hunter/Snov 28–35%. Anything above ~3% bounce degrades domain reputation; above 5% it's serious damage. **Never send an unverified email.** Our existing rule — AI claims are quarantined (`AiClaim`) until independently observed — is exactly the right instinct; this plan keeps it.
- **LinkedIn scraping/automation:** ToS-prohibited, account bans up ~340% for automation tools; hiQ v. LinkedIn did *not* make it safe (LinkedIn won on breach of contract). Not building on it.
- **Cold WhatsApp:** Meta's Business Messaging Policy requires prior opt-in; template messages to cold lists → quality-rating drop → ban. **WhatsApp stays a secondary channel governed by the existing `PHONE_RULES` legal gate, low volume, with the existing caps — and the plan does not expand it.** Long-term it should trend toward an opt-in follow-up channel (prospect replies by email first).
- **Cold SMS:** TCPA requires prior express written consent, no B2B exemption, $500–$1,500/text. Not building it.

### Sourcing strategy chosen (authenticity-first)
LeadSignal's existing philosophy — contacts come only from what a business publishes about itself, with provenance FKs back to `SourceRecord` — is *stricter* than the commercial waterfall stacks (Apollo → Prospeo → verify), and it's a genuine differentiator ("authentic leads, legally sourced"). The plan therefore:

- **Phase 1 (no new vendors):** reuse existing sources — AI web-search discovery, ATS/job-board intent signals, Overpass/Places existence checks, own crawler + contact/people extraction, MX hygiene. This already yields authentic, self-published contacts.
- **Phase 2 (optional, env-gated):** add two API integrations that fit the philosophy:
  - **Email verification API** (MillionVerifier ~$39/10k non-expiring credits, or Reoon ~$0.0007/email) — SMTP-level verification before send, on top of the existing MX check. This is the single highest-ROI addition; it protects domain reputation.
  - **Exa API** (semantic company search, 50M+ companies) as an additional *discovery* source — it finds companies matching a fuzzy ICP; every candidate still goes through the existing `verifier.js` existence gate and crawl before any contact is used.
- **Not adding:** Apollo/Hunter/PDL contact databases. If ever needed, they'd be a Phase 3 behind the same quarantine gate (a purchased email would still need independent observation or SMTP verification before becoming a `Contact`).

---

## 3. Architecture — how it fits the existing system

**Principle: SaaS Promoter is a new discovery-run mode, not a parallel stack.**

```
User pastes URL
      │
      ▼
[1] PRODUCT RESEARCH        lib/promoter/productResearch.js  (new)
    crawl product site via lib/ingest/websiteIngest.js + crawler/
    LLM extract → PromotedProduct row (facts + citations)
      │
      ▼
[2] ICP BRIEF               lib/promoter/icp.js  (new)
    LLM → structured ICP stored on PromotedProduct
    ══ HUMAN GATE #1: user reviews/edits ICP in UI ══
      │
      ▼
[3] DISCOVERY RUN           lib/nlquery/planner.js + lib/discovery/runner.js  (extended)
    plan.mode = "PROMOTE": ICP → search terms → existing steps
    (AI_DISCOVER, ATS_PROBE, AGGREGATOR, OVERPASS, crawl, cross-check)
    + optional EXA_DISCOVER step (Phase 2)
      │
      ▼
[4] VERIFY & SCORE          existing verifier.js, domainIdentity.js,
    existence gate, contact extraction, hygiene.js
    + ICP-fit scoring signal (new signal in signalCatalog)
    + SMTP verification step (Phase 2)
      │
      ▼
[5] COMPOSE                 lib/research/compose.js + prompts.js  (extended)
    product-pitch prompt variant; grounded in verified facts only;
    drafts saved as LeadEmailDraft (existing audit trail)
    ══ HUMAN GATE #2: user reviews drafts (existing EmailComposer UI) ══
      │
      ▼
[6] CAMPAIGN                lib/outreach/campaigns.js  (unchanged)
    sendPolicy.js legal gate at selection — UNCHANGED, NOT BYPASSED
    pacing, caps, windows, follow-ups, suppression — all inherited
```

Steps 3–6 are ~80% existing code. The genuinely new pieces are the `PromotedProduct` model, the two new LLM steps (product research, ICP), the `PROMOTE` plan mode, product-scoped compose templates, and one new frontend page.

---

## 4. Data model changes (Prisma)

New file `backend/prisma/schema/promoter.prisma`:

```prisma
model PromotedProduct {
  id             String   @id @default(cuid())
  url            String   @unique          // normalized product URL
  name           String                    // "TracefyHR"
  status         PromotedProductStatus @default(RESEARCHING)

  // [1] product research output (LLM-extracted, citation-backed)
  summary        String?                   // what it is, one paragraph
  category       String?                   // "HR management software"
  features       Json?                     // [{name, detail}]
  pricing        Json?                     // [{plan, price, capacity}]
  differentiators Json?                    // ["flat-rate pricing", "Forge AI", ...]
  proofPoints    Json?                     // testimonials, customer names, claims w/ source URLs
  competitors    Json?                     // ["BambooHR", "Rippling"]

  // [2] ICP (LLM-drafted, USER-EDITED — user edits are authoritative)
  icp            Json?                     // full ICP object, see §6 schema
  icpApprovedAt  DateTime?                 // gate #1 timestamp — discovery refuses to run without it

  // compose assets (product-scoped equivalent of templates.js PORTFOLIO)
  pitchAngle     String?                   // core value prop line for emails
  proofLink      String?                   // ONE link used in follow-ups (never email #1)
  senderContext  String?                   // who is sending & their relationship to product

  model          String?                   // audit: which LLM produced research/ICP
  promptVersion  String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  runs           ResearchBrief[]           // discovery runs launched for this product
}

enum PromotedProductStatus {
  RESEARCHING     // step 1-2 in progress
  ICP_REVIEW      // waiting on human gate #1
  READY           // ICP approved, can launch discovery runs
  ARCHIVED
}
```

Small extensions to existing models:
- `ResearchBrief`: nullable `promotedProductId` FK — a discovery run can belong to a product.
- `Lead`: nothing needed — `primaryOpportunity` already supports product-type `ServiceType`s. Add a generic `SAAS_PRODUCT` value to `ServiceType` (or reuse per-category values like `HR_SOFTWARE`; decide at implementation — `SAAS_PRODUCT` + the FK is cleaner than growing the enum per product).
- `LeadEmailDraft`: nullable `promotedProductId` FK so drafts are auditable per product.
- New signal in `signalCatalog.js`: `ICP_FIT` (contributes to `scoreBreakdown`).

---

## 5. Backend work plan (file-by-file)

### New: `backend/lib/promoter/`
| File | Responsibility |
|---|---|
| `productResearch.js` | Normalize URL → crawl product site (reuse `websiteIngest.js`: homepage, /pricing, /features, /customers, /about — respecting robots, SSRF guard, host policy) → `parseStructured()` against `PRODUCT_RESEARCH_SCHEMA` → upsert `PromotedProduct`. Uses `CostTracker`; degrades gracefully when `AI_ENABLED=false` (store crawl, mark research unavailable). |
| `icp.js` | Take product research + (optionally) AI web search for competitor/review context → `PRODUCT_ICP_SCHEMA` → store draft ICP, status `ICP_REVIEW`. Separate `approveIcp(id, editedIcp)` sets `icpApprovedAt`. |
| `service.js` | CRUD + orchestration: `createPromotedProduct(url)`, `getProduct`, `listProducts`, `approveIcp`, `launchPromoteRun(productId, options)` (builds a `PROMOTE` plan and hands it to `startDiscoveryRun`), `archiveProduct`. |

### Extended
| File | Change |
|---|---|
| `lib/research/prompts.js` | Add `PRODUCT_RESEARCH_*`, `PRODUCT_ICP_*`, `PROMOTE_DISCOVER_*`, `PROMOTE_COMPOSE_*` triples (system / user-builder / schema). Bump `PROMPT_VERSION`. Full prompt plan in §6. |
| `lib/nlquery/planner.js` | New `buildPromotePlan(product, options)`: translates the approved ICP into the existing step plan — ICP industries/geo → `AI_DISCOVER` queries; ICP hiring-signal roles → `ATS_PROBE`/`AGGREGATOR` filters; ICP geo → `OVERPASS` where applicable (e.g., TracefyHR: "HR consultancies in Riyadh" is Overpass-able). |
| `lib/discovery/runner.js` | Recognize `PROMOTE` plans (mostly pass-through; new step kind `EXA_DISCOVER` in Phase 2). Compose step uses promote prompt variant. |
| `lib/research/compose.js` | `gatherFacts` gains product context: when the run has a `promotedProductId`, inject the product's pitch angle/differentiators as a **separate labeled block** from lead facts (never mixed — lead facts stay the only personalization source). |
| `lib/research/templates.js` | Deterministic fallback templates parameterized by product (today's `PORTFOLIO`/pain-point maps are hardcoded per agency `ServiceType`; add a product-scoped path reading from `PromotedProduct.pitchAngle`/`proofLink`). |
| `lib/outreach/hygiene.js` | Phase 2: `verifyEmailSmtp(address)` via MillionVerifier/Reoon API; results cached on `Contact` (`verifiedAt`, `verifyResult`: VALID / INVALID / CATCH_ALL / ROLE / UNKNOWN). Policy: INVALID → suppress; CATCH_ALL → allowed but flagged, counts double against daily cap (conservative). Env-gated: no key → skip, existing MX-only behavior. |
| `configs/envConfig.js` | New: `EMAIL_VERIFY_PROVIDER` / `EMAIL_VERIFY_API_KEY` (Phase 2), `EXA_API_KEY` (Phase 2), `PROMOTER_MAX_LEADS_PER_RUN` (default 50 — small-batch finding), `PROMOTER_RUN_BUDGET_USD` (default 1.00, product research + ICP + discovery are 3 LLM stages). |
| `routes/RootRoute.js` + new `controllers/subControllers/promoterController.js` | Endpoints below, zod schemas exported alongside, `discoveryLimiter` on run-launching routes, `writeLimiter` on mutations. |

### API surface
```
POST   /api/promoter/products              { url }            → create + start research (SSE progress reuses run-event pattern)
GET    /api/promoter/products                                 → list
GET    /api/promoter/products/:id                             → detail (research + ICP + runs)
PUT    /api/promoter/products/:id/icp      { icp }            → save edited ICP + approve (gate #1)
POST   /api/promoter/products/:id/runs     { options }        → launch PROMOTE discovery run (403 unless icpApprovedAt)
POST   /api/promoter/products/:id/archive
```
Downstream (grid, compose, campaign creation) reuses existing endpoints — a PROMOTE run is a normal run.

### Worker
No new queues. Discovery stays in-process with SSE (a user is watching, same as today). Phase 2 SMTP verification of a batch happens inside the run's verify step with `pLimit` and the cost tracker; campaign ticks are untouched.

---

## 6. The AI prompt plan (run for every product)

These are the reusable prompt templates, following the existing `*_SYSTEM` / `build*User()` / `*_SCHEMA` convention in `prompts.js`. All outputs are JSON-schema-constrained via `parseStructured`/`searchAndParse`; citations required wherever the model asserts facts; everything lands in quarantine (`AiClaim`/`AiCandidate`) until verified, per the existing rule.

### Prompt 1 — PRODUCT_RESEARCH (fast model, input = crawled pages)
```
SYSTEM:
You are a product analyst. You will receive pages crawled from one SaaS
product's own website. Extract only what the pages actually say. Never
invent features, prices, customers, or claims. Every extracted item must
carry the URL of the page it came from. If a field is not evidenced on
the pages, return null for it. Output must match the JSON schema exactly.

USER (built):
Product URL: {url}
Crawled pages (markdown, with source URLs):
{pages}

Extract: name, one-paragraph summary, category, features[], pricing[],
differentiators[], proofPoints[] (each with sourceUrl), namedCustomers[],
competitorsMentioned[], geographyCues[] (languages, currencies, regions),
targetSizeCues[] (any stated team-size ranges).
```
Schema: `PRODUCT_RESEARCH_SCHEMA` — mirrors the `PromotedProduct` research fields, every array item `{ value, sourceUrl }`.

### Prompt 2 — PRODUCT_ICP (search model, may use web search for category/competitor context)
```
SYSTEM:
You are a B2B go-to-market analyst. Derive the ideal customer profile for
a SaaS product from its verified product research. Ground every element in
the evidence provided or in cited web sources (competitor positioning,
category review sites). Prioritize, in order: named customers and case
studies; pricing structure (what budget/size it implies); homepage
language (who it speaks to); integrations; geography cues. Be specific
and falsifiable — "HR manager or founder at a 10–100 employee company
currently running payroll in spreadsheets" not "businesses that need HR".
Include disqualifiers. Include observable buying signals that public data
can detect (job postings for specific roles, tech in use, review-site
activity, company age/size markers). This ICP will drive automated
prospecting, so every field must be machine-actionable.

USER (built):
Verified product research: {productResearchJson}
Known competitors: {competitors}

Produce the ICP per schema.
```
Schema: `PRODUCT_ICP_SCHEMA`:
```json
{
  "industries": ["..."],
  "companySize": { "min": 5, "max": 250 },
  "geographies": [{ "region": "...", "reason": "...", "priority": 1 }],
  "buyerTitles": { "decisionMakers": ["..."], "champions": ["..."] },
  "painPoints": [{ "pain": "...", "productAnswer": "..." }],
  "buyingSignals": [{ "signal": "...", "detectableVia": "JOB_POSTING|TECH_STACK|COMPANY_AGE|REVIEW_ACTIVITY|OTHER" }],
  "disqualifiers": ["..."],
  "competitorsToDisplace": ["..."],
  "suggestedSearchQueries": ["..."]
}
```
**This draft is shown to the user for edit/approval (gate #1). The stored, user-edited version is what all later prompts receive — never the raw draft.**

### Prompt 3 — PROMOTE_DISCOVER (search model; a variant of the existing DISCOVER prompt)
```
SYSTEM:
You are a company-discovery researcher. Find real, currently-operating
companies matching the ICP below. Only report companies you can support
with citations to live web pages (their own site, a jobs board, a
directory with a working website link). Report the company website domain,
country, and the specific evidence of ICP fit. Never report a company you
cannot cite. Never invent contact details — contact discovery happens
elsewhere from the company's own published pages.

USER (built):
Product being promoted: {name} — {summary}
ICP (user-approved): {icpJson}
Focus this search on: {oneOf icp.suggestedSearchQueries or planner-chosen segment}
Exclude: {already-known domains, competitors themselves, disqualifiers}
Return up to {AI_MAX_CANDIDATES} candidates per schema.
```
Reuses `DISCOVER_SCHEMA` shape (candidates → `AiCandidate` quarantine → existing existence gate/crawl/verification — unchanged).

### Prompt 4 — PROMOTE_COMPOSE (fast model, batched like BATCH_COMPOSE)
```
SYSTEM:
You write short, plain-text B2B introduction emails promoting a specific
SaaS product. Hard rules:
- Use ONLY the numbered verified facts provided per lead. Never invent
  or embellish facts about the recipient's company.
- The first sentence must state a specific, verifiable reason this
  company was contacted NOW (a hiring signal, growth marker, tooling
  gap) drawn from its facts — never generic flattery, never "I love
  what you're doing".
- Then one or two sentences connecting exactly one of their likely pains
  to the product, in concrete terms (name real capability + real number
  from the product block, e.g. price, time saved).
- One low-friction call to action (a question, not a meeting demand).
- Under 120 words. No links. No images. No bullet lists. No superlatives.
- Write in the recipient's likely business language if the facts
  indicate one; otherwise English.
- Use a personal name ONLY if recipientHint permits; otherwise address
  the company.
- Output subject + body per schema. Subject: specific and plain,
  5–8 words, no clickbait, no "quick question".

USER (built):
PRODUCT (the thing being promoted — you may state these facts about it):
{pitchAngle, top differentiators, one pricing fact, senderContext}

LEADS (for each: numbered verified facts + recipientHint + country):
{batch of up to BATCH_SIZE leads, existing gatherFacts output}
```
Output → `LeadEmailDraft` with `groundingFacts`, `factIdsUsed`, `promotedProductId`, `model`, `promptVersion` — fully auditable, exactly like today. Follow-up templates (2 follow-ups max for promote mode, spaced by existing `followUpDays`): follow-up #1 adds the single `proofLink`; follow-up #2 is a short close-out ("should I stop reaching out?" pattern).

### Worked example — expected outputs for TracefyHR
- **Research:** HR management platform; payroll (20+ currencies), leave, ATS, org charts, "Forge AI" custom-feature builder; $20–$199 flat-rate plans; "80% cheaper than BambooHR/Rippling"; Arabic UI; customers incl. SS Support Network, Balfour Beta Ltd.
- **ICP draft:** industries: agencies, outsourcing/support firms, tech startups, multi-country SMBs; size 5–250; geos: Gulf states + remote-first companies (Arabic + multi-currency evidence); decision-makers: founder/CEO (≤50 staff), HR manager/head of ops (50–250); pains: juggling separate payroll/leave/ATS tools, per-seat pricing pain, spreadsheet payroll; buying signals: **job postings for HR/recruiter roles** (detectable via existing ATS/aggregator ingestion!), multi-country job postings (multi-currency payroll pain), company age 1–5 yrs; disqualifiers: enterprises with Workday/SAP, single-person companies.
- **Note the fit:** the Gulf-state geography routes through `sendPolicy.js`'s existing `GDPR_ONLY_RESTRICTIONS` handling (role addresses allowed), and the hiring-signal detection is LeadSignal's existing core strength.

---

## 7. Frontend work plan

New page `frontend/src/pages/PromoterPage.jsx` + one `NAV` entry + one `<Route>` (pattern: `ResearchPage.jsx`).

1. **Products list / entry** — URL input bar ("Paste your SaaS product URL") + product cards (name, status chip, lead count, last run).
2. **Research view** — SSE progress while crawling/researching (reuse `DiscoveryProgress`), then the extracted product profile with source links.
3. **ICP review (gate #1)** — the draft ICP rendered as editable sections (industries, sizes, geos, titles, pains, signals, disqualifiers). Approve button → `PUT /icp`. Nothing runs until approved.
4. **Run + results** — "Find leads" launches a PROMOTE run; results reuse the existing research grid, `ConfidenceCell`, `ProvenanceDrawer`.
5. **Compose & campaign (gate #2)** — existing `EmailComposer` / draft-all / `BulkSendSheet` flow, unchanged; drafts show the product badge.

API methods added to `frontend/src/lib/api.js` following the flat-object pattern.

---

## 8. Compliance position (unchanged, load-bearing)

- `sendPolicy.js` runs at campaign selection for every promote lead exactly as today: DE/AT/IT/ES/NL blocked for email, GB/FR/IE/BE/US allowed, CA/CH/Gulf restricted with the role-address carve-out, unknown country → RESTRICTED. **No bypass, no new code path around it.**
- WhatsApp: existing `PHONE_RULES` + `DAILY_WA_CAP` only; this feature adds no new WhatsApp sourcing. Documented recommendation: use it as a reply/opt-in follow-up channel.
- No SMS. No LinkedIn automation. No purchased contact lists.
- Every email keeps the existing suppression/unsubscribe handling; drafts remain auditable (`groundingFacts`).
- Phase 2 SMTP verification is a *deliverability* protection (bounce <2% target) and also a compliance aid (stops mailing addresses that don't exist).

---

## 9. Phases & estimates

| Phase | Scope | Est. |
|---|---|---|
| **1 — Core pipeline** | `PromotedProduct` model + migration; `lib/promoter/` (research, ICP, service); 4 prompt triples; `buildPromotePlan`; runner PROMOTE mode; compose/templates product path; controller + routes; `PromoterPage` with gates 1–2; unit tests (planner mapping, ICP gate refusal, compose grounding) | 4–6 days |
| **2 — Quality & scale** | SMTP verification integration (MillionVerifier or Reoon, env-gated) + `Contact.verifyResult`; `EXA_DISCOVER` step (env-gated); `ICP_FIT` scoring signal; catch-all policy; per-product outreach stats on `OutreachPage` | 2–3 days |
| **3 — Later (not now)** | Competitor-review mining source; multi-product A/B pitch angles; reply-classification feedback into ICP; opt-in WhatsApp follow-up flow | — |

**New running costs (Phase 2, optional):** verification ~$39/10k emails (non-expiring); Exa usage-based; LLM cost already governed by `CostTracker` (`PROMOTER_RUN_BUDGET_USD`).

### Test plan
- Unit (vitest): URL normalization; ICP→plan mapping; gate #1 refusal (run launch 403 without `icpApprovedAt`); compose uses only provided facts (assert `factIdsUsed ⊆ groundingFacts`); sendPolicy still blocks DE lead in a promote campaign; verification result → suppression.
- E2E script: tracefyhr.com end-to-end against `AI_ENABLED=false` (deterministic fallback path) and `=true`.
- **No live sends to real leads in tests** (existing rule): campaign tests use the Resend test-mode account only.

---

## 10. Open questions — how they were resolved

1. **ServiceType strategy** → generic `SAAS_PRODUCT` enum value plus a `promotedProductId` FK on `DiscoveryRun` and `LeadEmailDraft`. Promoting a second product is now a row, not a migration.
2. **Phase 2 vendors** → not bought. Phase 1 shipped vendor-free. MillionVerifier/Reoon and Exa are still the right Phase 2 additions but need a purchasing decision from you; nothing in the code assumes them.
3. **Sender identity** → unchanged. Promote runs use the existing `EmailAccount` mailboxes and the existing campaign engine. Separate sending domains remain the recommendation before any real volume (§2), but that is a mailbox and DNS decision rather than a code change.
4. **Sender persona** → made per-product and editable: `PromotedProduct.senderContext` (defaulting to *"Writing on behalf of {name}."*), alongside `pitchAngle` and `proofLink`. The copy adapts per product instead of being hardcoded.

---

## 11. As built (2026-08-28)

### Shipped
- **Schema:** `PromotedProduct` + `PromotedProductStatus` (migration `20260828193220_saas_promoter`, purely additive, per the repo's rollback policy); `promotedProductId` on `DiscoveryRun` and `LeadEmailDraft`; `SAAS_PRODUCT` on `ServiceType`.
- **`backend/lib/promoter/`** — `productResearch.js` (URL normalisation that doubles as the first SSRF gate, page discovery and ranking, `htmlToText`, the fetched-source citation guard), `icp.js` (draft, normalise, `icpToParsedQuery`, `icpToSearchStrategies`), `service.js` (persistence, both gates, run launch).
- **Prompts:** four new contracts in `lib/research/prompts.js` (`PRODUCT_RESEARCH`, `PRODUCT_ICP`, `PROMOTE_DISCOVER`, `PROMOTE_COMPOSE`); `PROMPT_VERSION` → `1.2.0`.
- **Pipeline:** `buildPromotePlan` in `planner.js`; `PROMOTE` mode in `runner.js` (long deadline, product loaded once per run, promote-specific `AI_DISCOVER`, ICP-derived exclusions and country in `RESOLVE_MERGE`); product-aware `composeForRun`; `productInitialTemplate` in `templates.js`.
- **API:** eight endpoints under `/api/promoter/products`, all behind the session gate, with a strict length-capped zod schema for the hand-editable ICP.
- **UI:** `PromoterPage.jsx` plus one nav entry.
- **Tests:** `tests/unit/promoter.test.js`, 32 tests. Suite total 367, all passing.

### Verified end to end
Against the live local stack: the crawler read 5 real pages of tracefyhr.com and correctly skipped a 404; unauthenticated access returns 401; `javascript:` and `http://169.254.169.254/…` are rejected at validation; launching a run without an approved ICP returns 403; approving an empty ICP returns 422; an approved ICP launched a 12-step PROMOTE run in which 11 steps succeeded.

### Two departures from the plan
- **No `ICP_FIT` scoring signal.** Adding a `SignalType` would have meant touching `signalCatalog` and `scoreEngine`, which every existing lead's score depends on. Targeting is carried by the plan and the ICP-derived query instead, and existing scoring is untouched.
- **Promote web search lives in `runner.js` rather than reusing `discoverViaWebSearch`.** That function hardcodes `DISCOVER_SYSTEM` and takes a `ResearchBrief`. Reusing it would have lost the two rules that matter most when promoting: never return the product's own competitors as buyers, and justify each match against the ICP. The new function mirrors its persistence exactly, so candidates still land in the same `AiCandidate` quarantine and pass the same verification and existence gates.

### Known blocker — not a code defect
**The OpenAI account has no credits.** The key is valid (the models endpoint answers) but completions return `429 You have no credits remaining`. The circuit breaker handles this exactly as designed: product research falls back to "write the ICP by hand", and a promote run's `AI_DISCOVER` step fails while the other 11 steps still complete. But **AI web search is the primary discovery engine for a promote run**, so until credits are added a promote run will find little or nothing. Add credits at platform.openai.com → billing; no redeploy is needed, and the breaker clears itself after 10 minutes.

### Recommended next steps
1. Add OpenAI credits — everything else is gated behind this.
2. Run the first real promotion for tracefyhr.com and read the drafted ICP critically. It is the input that determines every lead the system then finds.
3. Before any real sending volume: set up a separate sending domain and warm it (§2), and add email verification (§2, Phase 2). Bounce rate is what protects the domain.
