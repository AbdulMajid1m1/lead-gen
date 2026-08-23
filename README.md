# LeadSignal

**AI Lead Intelligence & Prospect Discovery Platform**

Type what kind of customer you want. LeadSignal searches public business
records, company websites and live job boards, then hands back companies that
show real signals of needing a technology partner — each one explaining *why*,
showing the evidence, naming the opportunity, and telling you what to do next.

> “restaurants in Dubai with no website” → **Stefano's · 72/100 · website development**
> *Listed as an operating business with contact details but no website at all.*
> 📞 04 340 6401 · **Contact now — website development opportunity is live**

This is not a contact database. Every lead is built from freshly observed
evidence and can be traced back, click by click, to the source record it came
from.

---

## Quick start

```bash
# 1. Data services
docker compose up -d postgres redis

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run migrate            # creates the 31-table schema
npm run seed               # pulls real leads from live public sources (~10 min)
npm run dev                # API on http://localhost:4100

# 3. Frontend (separate terminal)
cd frontend
npm install
npm run dev                # UI on http://localhost:4180
```

Or run everything in containers:

```bash
docker compose up -d       # UI on http://localhost:4180
docker compose exec api npm run seed
```

**Ports** — API `4100`, worker health `4101`, UI `4180`, Postgres `5433`,
Redis `6380`. (3000/5000/7000 are avoided; they are commonly taken.)

### Verifying it works

```bash
cd backend
npm test              # 140 unit tests — SSRF guard, parser, extractors, scoring,
                      # job status, CT parsing, claim verification, domain guards
npm run test:e2e      # 70-check acceptance gate against the running stack
npm run test:research # deep-research gate: verification, grounding, history
```

---

## What makes a lead

The system looks for businesses whose *own public footprint* shows a technology
gap or an active technology initiative.

| Evidence it finds | Example conclusion |
|---|---|
| Listed in OpenStreetMap with a phone but no website | Website development — the clearest possible gap |
| Website audit scores below 40 | Website development, with the specific findings attached |
| Footer copyright reads 2018 | Nobody has maintained this site for years |
| Restaurant with no ordering path, or “call us to order” | E-commerce / AI automation |
| Clinic or salon with no booking widget | Booking system opportunity |
| WooCommerce store with no app | Mobile app opportunity |
| A CRM role open on the company's own job board *right now* | CRM development, budget already moving |
| Domain first seen in certificate logs 3 weeks ago | New business still building out |

Signals are scored, decayed by age, and rolled into a 0–100 score. Nothing is
asserted without a row to point at.

---

## Architecture

```
                    ┌───────────── discovery ─────────────┐
  natural-language  │  OpenStreetMap (Overpass)           │
  query ──► parser ─┤  Public ATS boards ×6               ├─► Company
            │       │  Job aggregators ×3                 │      │
            │       │  Company websites (own crawler)     │      │
            │       └─────────────────────────────────────┘      │
            │                                                    ▼
            │   SourceRecord (raw payload + sha256) ──► ExtractedFact
            │                                          TechnologyDetection
            │                                          WebsiteAudit
            │                                          JobPosting
            │                                                    │
            │                                                    ▼
            └──────────────────────────────────────────►  Signal + evidence
                                                                 │
                                                                 ▼
                                             Lead · score · reasons · action
```

- **API** (`backend/index.js`) — Express 5, ESM JavaScript, Prisma, PostgreSQL.
- **Worker** (`backend/worker.js`) — BullMQ schedules that keep data honest:
  job-board re-verification, website re-audits, re-scoring for decay,
  certificate-transparency domain dating, payload pruning.
- **Frontend** — React 19, Vite, Tailwind v4, TanStack Query, Recharts.

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md),
[`docs/SCORING_SPEC.md`](docs/SCORING_SPEC.md),
[`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).

---

## Provenance

The hardest requirement, and the one the schema is built around. Opening a lead
and clicking **“Where did this come from?”** walks a real relation chain:

```
Lead → LeadReason → Signal → SignalEvidence
                                 ├─ ExtractedFact  (key, value, the literal snippet)
                                 ├─ TechnologyDetection (what matched: header / HTML / asset)
                                 ├─ WebsiteAudit   (subscores + findings)
                                 └─ JobPosting     (status + how it was verified)
                                        └─ SourceRecord (raw payload, sha256, fetchedAt)
                                               └─ Source (name, attribution)
```

Crawl records are part of it too — including the refusals. A page blocked by
robots.txt or a Cloudflare wall is stored with its reason, so “we have nothing
for this company” is always explainable.

### Four levels of certainty

Carried end-to-end and rendered distinctly, so an inference never reads as a fact:

| Level | Meaning |
|---|---|
| `VERIFIED` | Source-authored proof (a vendor response header, a `mailto:` link, a live board listing) |
| `DETECTED` | Strong heuristic match |
| `INFERRED` | Derived by our rules — including conclusions drawn from *absence* of evidence |
| `AI_GENERATED` | Written by the optional LLM layer |

---

## Job intelligence

The rule that drives the design: **a job page that still returns 200 proves
nothing.** Careers pages serve filled roles for years.

`ACTIVE` is only ever asserted from a job's presence in a *current* fetch of the
company's own applicant-tracking board. Everything else is graded down:

| Status | Meaning | Scores? |
|---|---|---|
| `ACTIVE` | Present in a board fetch right now | full weight |
| `RECENTLY_ACTIVE` | Was on the board, now absent (< 14 days) | half weight |
| `EXPIRED` / `CLOSED` | Gone for 14+ days, deadline passed, or the page says so | never |
| `UNKNOWN` | Aggregator listing with no board to confirm it | never |

Every status change appends to `statusEvidence` — `{ method, boardHadJob,
httpStatus, at }` — which the UI shows verbatim.

Supported boards: **Greenhouse, Lever, Ashby, SmartRecruiters, Workable,
Recruitee** (all public, unauthenticated APIs).

---

## Crawling policy

The crawler is built to be a good citizen and to be safe against the untrusted
URLs it is inevitably handed.

- **robots.txt is always honoured.** Unreachable robots.txt is treated as
  *disallow* — a struggling site is the last one that should get more traffic.
- **Identifies itself** with a contactable User-Agent (required in production).
- **Per-host politeness**: serialised requests, ≥1.5 s apart, honouring a longer
  declared `Crawl-delay`.
- **Adaptive backoff** on 429/403/5xx — exponential with jitter, 30-minute
  ceiling, `Retry-After` always wins.
- **Bot walls are detected, never bypassed.** Cloudflare, Akamai, Imperva,
  PerimeterX, DataDome, reCAPTCHA, hCaptcha, Turnstile, login walls and paywalls
  are recognised so the crawl is *abandoned honestly* with a stored reason.
- **Targeted, not exhaustive**: home, `/contact`, `/about`, `/careers`,
  `/pricing`, `/shop` — capped per host, deduplicated by canonical URL.
- **SSRF-hardened.** The private-address guard runs inside the DNS lookup at
  *connect* time, closing the DNS-rebinding window a "resolve, check, then
  fetch" design leaves open. Blocks RFC1918, loopback, link-local (including
  `169.254.169.254`), CGNAT, TEST-NETs, ULA, and IPv4-mapped/6to4 wrappers of
  all of them. Plus: http/https only, no embedded credentials, redirect hops
  re-validated individually, 3 MB streaming cap, decompression-bomb guard.

No headless browser is used — every audit signal is derivable from static HTML
and response headers.

---

## Deep research (AI web search)

`/research` runs two engines against one question and merges the results:

```
your query
   │
   ├─► AI research brief        what to look for, where, and what to EXCLUDE
   │
   ├─► AI live web search  ─┐   finds businesses no map query would surface
   ├─► OpenStreetMap       ─┤   proves a business exists at an address
   └─► our crawler         ─┘   reads what each site actually publishes
                            │
                     merge + de-duplicate
                            │
                  ┌─────────▼──────────┐
                  │  VERIFY EVERY AI   │  every claimed email/phone/WhatsApp is
                  │  CLAIM AGAINST A   │  re-fetched and re-read by our crawler
                  │  REAL FETCHED PAGE │  before it is shown as confirmed
                  └─────────┬──────────┘
                            │
              score → personalised email → results grid → history
```

**The rule that makes it trustworthy: the model may point, only observation may
assert.** An AI-claimed contact detail lands in a quarantine table (`AiClaim`),
never in `Contact`. It is promoted only when our own crawler fetches a page and
sees that exact value:

| Verdict | What happened | Shown as |
|---|---|---|
| `CONFIRMED_OWN_SITE` | we saw it on the company's own website | **Verified** |
| `CONFIRMED_THIRD_PARTY` | we saw it on the page the model cited | **Detected** |
| `CONTRADICTED` | we fetched the cited page; the value was not there | hidden |
| `UNCHECKABLE` | robots.txt or a bot wall blocked the check | flagged, never promoted |
| `UNVERIFIED` | never independently observed | **AI-generated**, badge shown |

Four further guards:

- **Citation whitelist** — a claimed source URL must appear in the pages the
  search actually retrieved. Invented links are rejected at ingest.
- **Existence gate** — an AI-only company with no fetchable site, no map record
  and no confirmed detail never becomes a scored lead. Hallucinated businesses
  are structurally incapable of reaching the grid; they sit in a visible
  "unconfirmed candidates" tray instead.
- **Grounded emails** — the email writer sees a numbered list of verified facts
  and nothing else. A draft mentioning a phone, email or URL not in those facts
  is rejected and the deterministic template runs instead.
- **Cost governor** — a per-run budget (`AI_RUN_BUDGET_USD`, default $0.75)
  refuses further calls once spent. Typical run: **~$0.21**.

Confidence is rendered **per cell**, not per row — a phone we verified ourselves
sits beside an email the AI merely claimed, and the table says so.

Every run is saved to `/research/history` as an immutable snapshot, so
re-opening last week's search shows the results you acted on, not what the
leads have since been re-scored to.

## The optional AI layer

**The product is fully functional with `AI_ENABLED=false`, which is the default.**
Crawling, extraction, technology detection, scoring, signal derivation and
provenance are entirely deterministic.

When enabled, the LLM may do exactly two things:

1. **Reinterpret an ambiguous search phrase** — and only by choosing from the
   same closed vocabularies the deterministic parser uses. It cannot invent a
   signal type or an industry, its output is schema-validated, and the
   deterministic parse always runs first and wins on anything it recognised.
2. **Reword outreach copy** from talking points that were already verified.

It never sees raw pages, never touches a score, and its output is always
labelled `AI_GENERATED`.

---

## Compliance

- **Business contact data only**, from sources the business itself published.
  No personal-address guessing (`firstname@domain` patterns are never generated);
  every address is classified `ROLE` / `PERSONAL` / `NON_OUTREACH` so outreach
  prefers role accounts.
- **Suppression list** enforced twice — at extraction *and* at render — and
  applied retroactively when you add an entry.
- **Attribution** stored per source and shown in the UI (OpenStreetMap data is
  © OpenStreetMap contributors, ODbL).
- **Source terms respected** — Remotive's four-fetches-per-day limit is enforced
  in code; Nominatim results are cached permanently because its policy requires it.
- **Retention** — raw payloads pruned after 90 days; derived facts keep their
  hash and timestamp so provenance survives.
- Excluded by design: Apollo, ZoomInfo, LinkedIn scraping, and anything
  requiring an authentication, CAPTCHA or paywall bypass.

---

## Configuration

Everything lives in `backend/.env` (see `.env.example`). The production boot
guard refuses to start without a contactable `CRAWLER_USER_AGENT`, with
`CRAWLER_RESPECT_ROBOTS` disabled, or with the SSRF guard turned off.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection (required) |
| `REDIS_URL` | `redis://127.0.0.1:6380` | BullMQ queue |
| `CRAWLER_USER_AGENT` | LeadSignalBot/1.0 (+contact URL) | Must be contactable in production |
| `CRAWLER_DEFAULT_DELAY_MS` | `1500` | Politeness floor between requests to one host |
| `CRAWLER_MAX_PAGES_PER_HOST` | `12` | Crawl budget per site |
| `DISCOVERY_MAX_COMPANIES` | `150` | Cap on a single live discovery run |
| `MIN_RESULTS_BEFORE_DISCOVER` | `5` | Below this, a search triggers live discovery |
| `AI_ENABLED` | `false` | Optional LLM + deep-research layer |
| `AI_SEARCH_MODEL` | `gpt-5.6-terra` | Model used for live web search |
| `AI_FAST_MODEL` | `gpt-5.6-luna` | Briefing, extraction, email drafting |
| `AI_RUN_BUDGET_USD` | `0.75` | Hard spend ceiling per research run |
| `AI_MAX_SEARCH_CALLS` | `3` | Web searches per run |
| `RESEARCH_TIMEOUT_MS` | `900000` | Research runs get longer than discovery |
| `OVERPASS_URL` | kumi.systems mirror | The main instance is frequently saturated |

---

## Project layout

```
backend/
  index.js worker.js            API and scheduled-maintenance entrypoints
  configs/ middlewares/ routes/ controllers/
  lib/
    crawler/    safeFetch ipGuard robots hostPolicy blockDetection fetchPage
    adapters/   overpass nominatim ats
    ingest/     overpassIngest websiteIngest atsIngest aggregatorIngest domainResolver
    extract/    contacts pageMeta jobTextParser
    analyze/    techDetect fingerprints websiteAudit
    signals/    signalCatalog signalEngine
    scoring/    scoreEngine decay recommend
    nlquery/    lexicon parser llmParser planner
    discovery/  runner
    provenance/ recorder
    llm/        optional, feature-flagged
  prisma/schema/*.prisma        31 tables, split by domain
  seeds/ tests/
frontend/src/
  pages/       Dashboard Search Leads LeadDetail Discovery Settings
  components/  LeadCard ProvenanceDrawer DiscoveryProgress ui
docs/          ARCHITECTURE DATA_MODEL SCORING_SPEC DATA_SOURCES BUILD_PLAN
```

---

## Known limits

- **Overpass availability.** The public OpenStreetMap query API is frequently
  saturated and answers 504. The adapter fails over across three mirrors and
  retries with a narrower radius, but a discovery run can still come back empty
  when every mirror is busy. It reports that honestly rather than silently
  returning nothing.
- **Domain resolution is best-effort.** A company found by name on a job board
  gets its website resolved by testing candidate domains and requiring the page
  to name the company. Companies whose domain does not follow from their name
  (`ashby` → `ashbyhq.com`) are recorded as unresolved rather than guessed at.
- **Coverage follows OpenStreetMap density.** Business coverage is excellent in
  dense urban areas and thinner in rural ones.
- Discovery runs execute in the API process (bounded concurrency, durable step
  records). Horizontal scaling would mean moving them onto the existing queue
  and partitioning crawl hosts across workers.
