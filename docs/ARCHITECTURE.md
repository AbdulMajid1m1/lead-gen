# Architecture

## 1. Topology (Docker Compose, 5 services)

| Service | Build | Host port | Notes |
|---|---|---|---|
| `postgres` | postgres:16-alpine | **5433** → 5432 | volume `leadsignal_pgdata` |
| `redis` | redis:7-alpine | **6380** → 6379 | AOF on, `noeviction` (BullMQ requirement) |
| `api` | `backend/Dockerfile`, `node index.js` | **4100** | Express 5 API |
| `worker` | same image, `node worker.js` | **4101** | BullMQ processors + repeatable jobs; HTTP only for `/health` |
| `frontend` | `frontend/Dockerfile` (Vite → nginx) | **4180** | dev: `vite --port 4180` |

Ports 3000 / 5000 / 7000 / 7070 are already bound on the target machine and are
avoided everywhere.

## 2. Module decomposition

One codebase, two entrypoints — mirrors the TracefyHR reference layout.

```
backend/
  index.js                  # API entrypoint (helmet, cors, json, /api, errorHandler)
  worker.js                 # BullMQ workers + repeatable schedules
  configs/envConfig.js      # exported consts + production boot guard
  prismaClient.js
  middlewares/              errorHandler.js  rateLimiter.js  validate.js
  routes/RootRoute.js
  routes/subRoutes/         searchRoutes  leadRoutes  companyRoutes  discoveryRoutes
                            suppressionRoutes  statsRoutes  settingsRoutes
  controllers/subControllers/  …Controller.js (one per route file)
  lib/
    crawler/    safeFetch.js  ipGuard.js  robots.js  hostPolicy.js
                blockDetection.js  fetchPage.js  frontier.js
    adapters/   overpass  nominatim  greenhouse  lever  ashby  smartrecruiters
                workable  recruitee  arbeitnow  remotive  jobicy  hnHiring
                adzuna  crtsh  wikidata          # each: discover() → normalized + raw payload
    extract/    contacts.js  pageMeta.js  schemaOrg.js  jobTextParser.js
    analyze/    techDetect.js  fingerprints.js  websiteAudit.js
    signals/    signalEngine.js  signalCatalog.js
    scoring/    scoreEngine.js  decay.js  opportunityMap.js
    provenance/ recorder.js     # every derived write funnels through here
    nlquery/    lexicon.js  parser.js  llmParser.js  planner.js
    llm/        index.js  openaiCompatible.js  anthropic.js   # optional, feature-flagged
    jobs/       jobStatusEngine.js
  queues/       queues.js  processors/{discovery,crawl,enrich,score,verifyJobs}.js
  utils/        createError.js  logger.js  hash.js  normalize.js
  prisma/schema/*.prisma
  seeds/        ats-companies.json  cities.json  seed.js
```

## 3. Pipelines

### Ingestion

```
adapter fetch
  → SourceRecord (raw JSON + sha256, unique on (sourceId, payloadHash))
  → normalizer upserts Company via DedupeKey  (domain > phone > osmId > name+city)
  → enqueue crawl for its domain
  → CrawlResult → extractors write ExtractedFact / TechnologyDetection / WebsiteAudit
      (each row carries sourceRecordId or crawlResultId)
  → signalEngine derives Signal rows with SignalEvidence links
  → scoreEngine upserts Lead + LeadOpportunity + LeadReason + RecommendedAction
```

Every step is idempotent (upsert on a natural key), so re-runs enrich rather
than duplicate.

### NL query pipeline — the #1 acceptance path

1. `POST /api/search { q }` → **`parser.js` always runs**. Tokenizes against
   gazetteers: industries (OSM tag lexicon, "restaurants" → `amenity=restaurant`),
   locations (cached Nominatim city table, live geocode on miss), technologies,
   signal phrases ("outdated website" → `OUTDATED_WEBSITE | NO_MOBILE_VIEWPORT |
   NO_HTTPS`), service intents, timeframes ("this month" → 30d), size words.
   Output is a `StructuredQuery`.
2. If the LLM layer is enabled, `llmParser.js` gets **one** shot at producing the
   same JSON (schema-validated, 4s timeout). Invalid or slow → the deterministic
   result stands. `SearchQuery.parserUsed` records which one won.
3. `planner.js` maps `StructuredQuery` → Prisma `where` + ranking
   (`score × freshnessFactor`) and returns page 1.
4. **Live "discover now"**: when matches < `MIN_RESULTS_BEFORE_DISCOVER` (5), or
   the user asks explicitly, the planner builds a `DiscoveryRun` with ordered
   steps derived from the query (Overpass area+category → dedupe/upsert → crawl
   and audit top N → ATS probes → signals → score) and enqueues it. The response
   carries `discoveryRunId`; the frontend subscribes to
   `GET /api/discovery-runs/:id/events` (SSE) and re-queries as leads land.
   Hard caps: 150 companies, 8 minutes, then finalize.

## 4. Crawler policy

- **robots.txt** — fetched per host, parsed with `robots-parser`, cached 6h
  (30 min negative TTL). Decision stored on every crawl record. A 5xx or network
  failure on robots.txt is treated as **disallow** — a struggling site is the
  last one that should get extra traffic from us.
- **Politeness** — per-host serialized queue, ≥1.5s between requests, honoring a
  declared `Crawl-delay` when it is *longer* than ours. Different hosts run in
  parallel up to `CRAWLER_CONCURRENCY`.
- **Adaptive backoff** — 429/403/503/5xx → exponential host cooldown
  (30s × 2^failures, 30 min ceiling, ±15% jitter), `Retry-After` always wins when
  present. 5 consecutive failures pins the host at the ceiling.
- **Bot-wall detection** — Cloudflare/Akamai/Imperva/PerimeterX/DataDome
  signatures, reCAPTCHA/hCaptcha/Turnstile widgets on short pages, login walls,
  paywalls, `cf-mitigated: challenge`, 401/402/429/451. Detected → crawl
  abandoned, `blockReason` recorded, host cooled down. **Never bypassed.**
- **URL prioritization** — home 100, `/contact` 90, `/about` 80,
  `/careers|/jobs` 75, `/pricing` 70, `/shop|/store|/menu` 65, sitemap
  top-level 50, other 20. Max 12 pages/host. Dedupe by `sha256(normalizedUrl)`.
- **SSRF guard** (`ipGuard.js` + `safeFetch.js`) — enforced at *connect* time via
  a custom undici DNS lookup, which closes the DNS-rebinding window that a
  "resolve, check, then fetch" design leaves open. Blocks all of
  10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8, TEST-NETs,
  multicast/reserved, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped and 6to4
  wrappers of the above. Also: http/https only, ports 80/443/8080/8443, no
  embedded credentials, no `.local`/`.internal`/`.onion`, max 4 redirects with
  every hop re-validated, 3MB body cap enforced while streaming, 15s timeout.
- **Playwright is not used.** Every audit signal in SCORING_SPEC.md is obtainable
  from static HTML + response headers. SPA shells are detected and recorded
  (`jsRendered`) rather than rendered.

## 4b. Deep research (AI web search layer)

Optional, and additive: with no API key the platform behaves exactly as before.

```
query → AI research brief ─┬─► AI live web search  (Responses API + web_search tool)
                           ├─► OpenStreetMap Overpass
                           └─► own crawler
                                    ↓
                         merge + de-duplicate (existing DedupeKey ladder)
                                    ↓
                    ┌───────────────────────────────┐
                    │ verify every AI claim against  │
                    │ a page OUR crawler fetched     │
                    └───────────────────────────────┘
                                    ↓
             signals → score → grounded email → grid → history snapshot
```

**Quarantine model.** AI output never enters `Contact` or `ExtractedFact`
directly. It lands in `AiCandidate` / `AiClaim`, and `recorder.js` remains the
only writer of facts. A claim is promoted only when the deterministic extractor
independently finds the same normalised value on a page we fetched:

| Claim status | Meaning | Resulting confidence |
|---|---|---|
| `CONFIRMED_OWN_SITE` | observed on the company's own site | `VERIFIED` |
| `CONFIRMED_THIRD_PARTY` | observed on the cited page | `DETECTED` |
| `CONTRADICTED` | page fetched, value absent | not stored |
| `UNCHECKABLE` | robots/bot-wall blocked the check | not stored |
| `UNVERIFIED` | never observed | stays `AI_GENERATED`, flagged in UI |

**Three structural guards**, in addition to prompt discipline:

1. *Citation whitelist* — a claimed source URL must appear among the pages the
   search actually retrieved (`citationsAreGrounded`), else the candidate is
   rejected as `REJECTED_UNCITED`.
2. *Existence gate* — no fetchable site, no map record and no confirmed claim
   means the candidate never becomes a scored lead (`REJECTED_NO_EXISTENCE`).
3. *Grounded composition* — the email writer receives only verified facts and
   must cite them by id; a body containing a contact string absent from those
   facts is discarded in favour of the deterministic template.

**Cost control.** A `CostTracker` per run refuses further calls once
`AI_RUN_BUDGET_USD` is spent, and the spend is stored on `DiscoveryRun.aiUsage`.

**Timeouts.** Research runs get `RESEARCH_TIMEOUT_MS` (15 min) rather than the
discovery budget, and the deadline never skips `SIGNALS`/`SCORE`/`SNAPSHOT` —
those are local and cheap, and skipping them would throw away the entire run's
collected evidence.

## 5. API surface

Envelope is `{ success, message?, data? }` everywhere, matching the reference project.

```
POST  /api/search                     { q } → { query:{id,raw,parsed,parserUsed}, leads, total, discoveryRunId|null }
POST  /api/search/:queryId/discover   → { discoveryRunId }
GET   /api/discovery-runs/:id         → { status, steps:[{ordinal,kind,label,status,counts}], stats }
GET   /api/discovery-runs/:id/events  → SSE stream of the same
GET   /api/leads?status&service&minScore&city&industry&sort&page
GET   /api/leads/:id                  → company, contacts, score breakdown, reasons+evidence, opportunities, actions, outreach, freshness
GET   /api/leads/:id/provenance       → ordered chain Source → discovery → crawl → facts → signals → reasons → score
PATCH /api/leads/:id/status           { status, note }
GET   /api/companies/:id              → company 360
GET   /api/signals/catalog            → static catalog for the UI legend
GET   /api/suppression  POST /api/suppression  DELETE /api/suppression/:id
GET   /api/stats/dashboard
GET   /api/health

POST  /api/research                   { q } → { runId, brief, briefProducedBy, steps, aiAvailable }
GET   /api/research-runs/:id/grid     → { rows[], unverified[], brief, aiUsage, isSnapshot, steps }
GET   /api/research-history           → past runs with their saved results
GET   /api/leads/:id/email-drafts     → drafts with the facts each was grounded on
POST  /api/leads/:id/email-drafts     → rewrite
```

Rate limits: search 30/10min/IP, discover 6/hour/IP, general 300/10min/IP.

## 6. Frontend IA

React 19 + Vite + Tailwind v4 + TanStack Query + react-router v7.

Routes: `/` dashboard · `/search` · `/leads` · `/leads/:id` · `/discovery` · `/settings`.

Key components — `QueryBar` (free text plus *parsed chips* showing how the query
was understood, each chip editable), `LeadCard` (score ring, freshness badge,
three "why" bullets, contact icons), `ScoreBreakdownChart` (stacked category
bar), `ProvenanceDrawer` (vertical timeline Source → Crawl → Evidence → Signal →
Score, every node expandable to the raw matched snippet with its fetch timestamp
and confidence badge), `OutreachPanel` (channel, angle, copyable opener; an
"AI-drafted" badge appears only when the LLM actually produced it),
`DiscoveryProgress` (SSE step checklist + live counter), `SuppressButton`.

States: empty search shows three example query chips and a "Discover now" CTA;
loading shows skeleton cards; an in-progress discovery pins a progress panel
above incrementally-arriving results; errors surface as a toast plus inline
retry; a lead with no contact gets a "Find contact" enqueue button.

## 7. Confidence labelling

Four levels are carried end-to-end and rendered distinctly in the UI, so an
inference is never mistaken for a fact:

| Level | Meaning | Example |
|---|---|---|
| `VERIFIED` | Unambiguous, source-authored proof | `x-shopid` response header ⇒ Shopify |
| `DETECTED` | Strong heuristic match | `data-reactroot` in markup ⇒ React |
| `INFERRED` | Derived by our rules from other facts | WooCommerce present ⇒ WordPress |
| `AI_GENERATED` | Written by the LLM layer | outreach opening line |

The LLM never touches scores, signals, or facts — only optional query parsing and
outreach drafting, and its output is always labelled `AI_GENERATED`.

## 8. Environment

`PORT=4100`, `WORKER_HEALTH_PORT=4101`, `DATABASE_URL`, `REDIS_URL`, `APP_URL`,
`ALLOWED_ORIGINS`, `CRAWLER_USER_AGENT`, `CRAWLER_CONTACT_URL`,
`CRAWLER_MAX_PAGES_PER_HOST`, `DISCOVERY_MAX_COMPANIES=150`,
`MIN_RESULTS_BEFORE_DISCOVER=5`, `AI_ENABLED=false`, `AI_PROVIDER`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`,
`NOMINATIM_EMAIL`.

The production boot guard refuses to start without `DATABASE_URL`, a
contactable `CRAWLER_USER_AGENT`, `CRAWLER_RESPECT_ROBOTS=true`, and
`CRAWLER_ALLOW_PRIVATE_HOSTS=false`.
