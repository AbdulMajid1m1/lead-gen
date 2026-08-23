# Build Plan

**Status: complete.** 118 unit tests and a 70-check end-to-end acceptance gate
pass against the running Docker stack with live data. Items left deliberately
out of v1 are called out at the bottom.

Ordered and dependency-aware. Dependency rule of thumb:
`0 → 1 → {2,3} → 4 → 5 → 6 → 7`, with 7 startable early against the API
contract; 8 last.

## Phase 0 — Skeleton
- [x] Repo layout `backend/`, `frontend/`, `docs/`, `docker-compose.yml`
- [x] Compose: postgres:16 (5433), redis:7 (6380) — both verified healthy
- [x] Backend boot plumbing: `envConfig` (+ production guard), `errorHandler`,
      `createError`, `logger`, `prismaClient`
- [x] Full Prisma schema → `migrate dev` → 31 tables live

## Phase 1 — Crawl core (blocks everything downstream)
- [x] `safeFetch.js` + `ipGuard.js` — SSRF guard at connect time, byte/time caps,
      per-hop redirect re-validation
- [x] `robots.js` — parse, cache, crawl-delay, fail-closed on 5xx
- [x] `hostPolicy.js` — per-host serialization, adaptive exponential backoff
- [x] `blockDetection.js` — bot-wall / CAPTCHA / JS-challenge detection (detect,
      never bypass)
- [x] `fetchPage.js` — orchestrates the above into one uniform outcome record
- [x] Crawl records written on every fetch (`CrawlRequest`/`CrawlResult`), including refusals
- [x] URL prioritisation and per-host page cap (in `websiteIngest`)

## Phase 2 — Sources
- [x] ATS adapters: greenhouse, lever, ashby, smartrecruiters, workable, recruitee
- [x] `probeAtsSlug()` + `domainResolver` (evidence-checked website resolution)
- [x] Aggregators: arbeitnow, jobicy, remotive (4 pulls/day cap enforced in code)
- [x] `overpass.js` (3 mirrors + narrowing retry) + `nominatim.js` (1 rps, permanent cache)
- [x] `crtsh.js` (best-effort, nightly, UTC-safe parsing, fixture-tested)

## Phase 3 — Extraction & analysis
- [x] `fingerprints.js` + `techDetect.js` — ~55 hand-curated fingerprints
- [x] `contacts.js` — mailto/tel/regex + de-obfuscation, role classification
- [x] `websiteAudit.js` — six subscores + evidence-carrying findings
- [x] `pageMeta.js` (incl. schema.org), `jobTextParser.js` (skills + role lexicon)

## Phase 4 — Intelligence
- [x] `signalCatalog.js` + `signalEngine.js` — idempotent, self-correcting, evidence-linked
- [x] `jobStatusEngine.js` + re-verification cadence in the worker
- [x] `scoreEngine.js` + `decay.js` + `recommend.js` → lead, opportunities, reasons, actions, outreach

## Phase 5 — NL query engine
- [x] `lexicon.js` — industries↔OSM tags, tech, signal phrases, service intents, timeframes
- [x] `parser.js` — deterministic, 24 golden tests incl. the acceptance queries
- [x] `planner.js` — Prisma where + reachability-aware ranking + discovery-plan builder
- [x] `llm/` abstraction + `llmParser.js` (closed vocabulary, validated, timeout, fallback)

## Phase 6 — API
- [x] All routes/controllers, Zod validation, tiered rate limits, SSE progress stream

## Phase 7 — Frontend
- [x] Shell: router, layout, light/dark theme, TanStack Query, envelope-aware client
- [x] Search → Leads → Lead detail → Provenance drawer → Dashboard → Discovery → Settings

## Phase 8 — Seed & acceptance
- [x] `seeds/seed.js` — 3 cities × 2 categories, 9 ATS boards, aggregator pull. Zero paid APIs.
- [x] 118 unit tests: SSRF CIDRs, fingerprints, audit scorer, decay, job status, parser, CT parsing
- [x] Covered by the acceptance gate (search → discover → detail → provenance)
- [x] **E2E acceptance gate — 70 checks, passing** against the Docker stack with live data
- [x] Retention pruning (90d) + README runbook

## Deliberately out of scope for v1

- **Adzuna** — the only candidate source needing registration; the six
  unauthenticated ATS boards cover hiring intelligence with better freshness.
- **Wikidata enrichment** — would add firmographics (inception, headcount) but
  no signal the scoring model currently uses.
- **HN "Who is hiring"** — the Algolia API is verified and free, but each comment
  is unstructured free text, so extraction quality would be materially below the
  structured ATS path.
- **Common Crawl** — heavy to process and poor on freshness, the axis this
  product optimises for.
- **Headless rendering** — every audit signal is obtainable from static HTML;
  SPA shells are detected and recorded (`jsRendered`) rather than rendered.
