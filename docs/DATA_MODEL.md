# Data Model

The **source of truth is `backend/prisma/schema/*.prisma`** — this document
explains the shape and the reasoning. 31 tables, split by domain:

| File | Models |
|---|---|
| `enums.prisma` | all enums (ConfidenceLevel, ServiceType, SourceKind, JobStatus, SignalType, LeadStatus, …) |
| `company.prisma` | `Company`, `CompanyDomain`, `CompanyAlias`, `Contact`, `Location`, `AtsAccount`, `GeoPlace` |
| `source.prisma` | `Source`, `SourceRecord` |
| `crawl.prisma` | `CrawlRequest`, `CrawlResult`, `RobotsCache`, `HostCrawlState` |
| `facts.prisma` | `ExtractedFact`, `TechnologyDetection`, `WebsiteAudit` |
| `jobs.prisma` | `JobPosting`, `JobSkill` |
| `signals.prisma` | `Signal`, `SignalEvidence` |
| `leads.prisma` | `Lead`, `LeadOpportunity`, `LeadReason`, `RecommendedAction`, `OutreachRecommendation`, `LeadStatusHistory` |
| `query.prisma` | `SearchQuery`, `DiscoveryRun`, `DiscoveryRunStep` |
| `ops.prisma` | `SuppressionEntry`, `DedupeKey` |

## The provenance chain

This is the requirement the schema is built around. Opening a lead resolves a
pure relation walk — no free-text "source" column anywhere:

```
Lead
 └─ LeadReason            "why this is a lead", human sentence
     └─ Signal            interpreted observation (type, strength, weight, decay)
         └─ SignalEvidence
             ├─ ExtractedFact        key/value + the literal snippet that proves it
             ├─ TechnologyDetection  what matched, and whether via header/HTML/asset
             ├─ WebsiteAudit         subscores + findings
             └─ JobPosting           title, status, statusEvidence
                 └─ SourceRecord     immutable raw payload + sha256 + fetchedAt
                     └─ Source       kind, name, attribution
   ... and for crawled data:
             ExtractedFact → CrawlResult (status, blockReason, timings, jsRendered)
                              └─ CrawlRequest (url, robotsDecision, priority, attempts)
```

Every derived row carries `confidenceLevel`, so the UI can render a verified
header match differently from an AI-written sentence.

## Deduplication

`DedupeKey` is the identity index. The resolver tries kinds strongest-first:

`DOMAIN` → `OSM_ID` → `ATS_SLUG` → `PHONE` → `NAME_CITY`

A hit merges the incoming record into the existing `Company` (adding a
`CompanyAlias`/`CompanyDomain` as needed) rather than creating a second one.
`Lead.companyId` is unique, so a company can only ever have one lead — repeat
discovery enriches it and refreshes its score.

## Idempotency constraints

These are what make re-running the pipeline safe:

| Table | Constraint | Effect |
|---|---|---|
| `SourceRecord` | `@@unique([sourceId, payloadHash])` | re-fetching unchanged data is a no-op |
| `CrawlRequest` | `@@unique([urlHash])` | a URL is never crawled twice |
| `ExtractedFact` | `@@unique([companyId, key, sourceRecordId])` | one fact per key per source |
| `TechnologyDetection` | `@@unique([companyId, techSlug])` | detections update, not accumulate |
| `JobPosting` | `@@unique([sourceId, externalId])` | board re-fetch updates status in place |
| `Signal` | `@@unique([companyId, type, dedupeKey])` | one signal per underlying instance |
| `Lead` | `@@unique([companyId])` | one lead per company |
| `DedupeKey` | `@@unique([kind, value])` | an identity belongs to exactly one company |
| `PromotedProduct` | `@@unique([url])` | re-pasting a product's URL re-opens it instead of splitting its runs across two rows |

## Notable design choices

- **`Signal.weight` and `halfLifeDays` are copied onto the row at detection time.**
  Re-tuning the catalogue later must not silently rewrite the history of why a
  lead scored what it scored.
- **Signals are deactivated, never deleted** (`active`, `deactivatedAt`,
  `deactivatedReason`) — "the site fixed its viewport tag" is itself information.
- **`JobPosting.statusEvidence`** is an append-only JSON array of observations
  (`{ method, boardHadJob, httpStatus, at }`). ACTIVE is only ever asserted from
  a live board re-fetch, never from a page that merely still returns 200.
- **`CrawlResult.blockReason` is never null on failure.** A robots refusal, a
  Cloudflare wall and an SSRF block are all distinguishable after the fact.
- **`GeoPlace`** exists because Nominatim's usage policy *requires* caching —
  it is a compliance artefact, not just a performance one.
- **`PromotedProduct.icpApprovedAt` is the SaaS promoter's gate.** A run cannot
  be planned or launched while it is null, and editing the ICP clears it — an
  approval timestamp sitting over text that changed after it was read is the one
  state the gate exists to make impossible. The researched fields around it
  carry the page each claim came from, like every other derived row here.
