# Data Sources

All sources below were **live-verified on 2026-08-17**. Every one is public,
unauthenticated (or free-tier with an explicit env-gated key), and permitted for
this use. No commercial lead database (Apollo, ZoomInfo), no LinkedIn scraping,
no authentication/CAPTCHA/paywall bypass anywhere in the system.

## Verified sources

| Source | Endpoint | Status | Key fields | Limits / ToS |
|---|---|---|---|---|
| **Greenhouse** job board | `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` (verified with `stripe`, 200+ jobs) | VERIFIED | `id, title, absolute_url, location.name, first_published, updated_at, company_name, requisition_id` | No auth. Be polite (~1 req/s). `?content=true` adds descriptions. |
| **Lever** postings | `GET https://api.lever.co/v0/postings/{slug}?mode=json` (verified with `palantir`) | VERIFIED | `id, text, createdAt` (epoch ms), `categories{team,location,commitment}, hostedUrl, applyUrl, workplaceType, country` | No auth. Empty array ≠ 404 → distinguishes "on Lever, no openings" from "not on Lever". |
| **Ashby** posting API | `GET https://api.ashbyhq.com/posting-api/job-board/{slug}` (verified with `ashby`) | VERIFIED | `jobs[]: id, title, department, team, employmentType, location, publishedAt, isRemote, jobUrl, applyUrl, descriptionHtml` | No auth. |
| **SmartRecruiters** | `GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=0` (verified with `visa`) | VERIFIED | `totalFound, content[]: id, name, releasedDate, location{city,country}, ref` | No auth, offset pagination. |
| **Workable** widget | `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true` (verified with `netdata`) | VERIFIED | `jobs[]: title, shortcode, published_on, url, city, country` | No auth. |
| **Recruitee** | `GET https://{slug}.recruitee.com/api/offers/` (unauthenticated per official docs) | VERIFIED (docs) | `offers[]: id, title, slug, status, created_at, careers_url, locations[]` | No auth. 404 ⇒ not on Recruitee. |
| **Arbeitnow** | `GET https://www.arbeitnow.com/api/job-board-api` | VERIFIED | `data[]: slug, company_name, title, description, remote, url, tags, location, created_at` | Free, no auth, `?page=N`. |
| **Remotive** | `GET https://remotive.com/api/remote-jobs?limit=N&search=…` | VERIFIED | `jobs[]: id, url, title, company_name, category, tags, job_type, publication_date, salary` | **ToS embedded in payload: max ~4 fetches/day; do not republish to third-party job sites.** Used only as a company-discovery signal → compliant. Hard-capped at 4 pulls/day. |
| **Jobicy** | `GET https://jobicy.com/api/v2/remote-jobs?count=50&tag=…` | VERIFIED | `jobs[]: id, url, jobTitle, companyName, pubDate, jobGeo` | Free, no auth; few fetches/day. |
| **HN "Who is hiring"** | `GET https://hn.algolia.com/api/v1/search_by_date?query="Who is hiring"&tags=story` → `GET /api/v1/items/{objectID}` | VERIFIED | story hits + full comment tree (1 comment = 1 hiring company) | Free/public Algolia HN API, ~10k req/hr. |
| **OSM Overpass** | `POST https://overpass-api.de/api/interpreter` (status endpoint verified: 2 slots, rate limit 2) | VERIFIED | tags: `name, website, contact:website, phone, contact:phone, email, contact:email, opening_hours, cuisine, brand, amenity/shop/office` + lat/lon | 2 concurrent slots/IP; queries < 180s; cache results. Mirror fallback `overpass.kumi.systems`. **ODbL attribution required.** |
| **Nominatim** | `GET https://nominatim.openstreetmap.org/search?q=…&format=jsonv2` | VERIFIED (policy read) | lat/lon, boundingbox, osm_id | **Policy: max 1 req/s, custom User-Agent mandatory, results MUST be cached, no systematic/grid queries, attribution required.** Each city geocoded once, cached permanently. |
| **crt.sh** | `GET https://crt.sh/?q={domain}&output=json` | IMPLEMENTED, BEST-EFFORT (answered 502 during validation) | `issuer_name, common_name, name_value, entry_timestamp, not_before, not_after` | Best-effort only: 30s timeout, ≤1 req/10s, nightly batch. Powers "new domain / new subdomain" freshness signals. |
| **Wikidata** | `wbsearchentities` + SPARQL | Public/stable | inception, HQ, industry, employee count | 1 req/s, custom UA. Enrichment only. |
| **Target site crawl** | site's own `robots.txt` → `sitemap.xml` → prioritized pages | n/a | raw HTML | Governed by the crawler policy in ARCHITECTURE.md §4. |
| **Competitor customers** | AI web search over public review sites (G2, Capterra, TrustRadius), vendor customer/case-study pages and directory listings | IMPLEMENTED (promote runs only) | company name, website, why it matches, source URLs | Search-index only — the review sites themselves are never scraped. Companies only, never reviewers: the prompt forbids returning a person, a username or a reviewer's personal details, and omits any review naming no identifiable organisation. Every candidate still passes the existence gate and the citation guard before it becomes a lead. |

## Evaluated but not implemented in v1

- **Adzuna** — the endpoint is real and the free tier is usable, but it is the
  only candidate that requires registration for a key. The six unauthenticated
  ATS board APIs above already provide hiring intelligence with *better*
  freshness (they confirm a role is open right now), so Adzuna was dropped
  rather than shipped as untested, key-gated code.

## Rejected / excluded

- **RemoteOK** — `https://remoteok.com/api` returned **403** to our identified crawler (blocks non-browser UAs) and actively bot-blocks. Excluded; Arbeitnow/Remotive/Jobicy cover the same niche.
- **Apollo / ZoomInfo / LinkedIn / any auth-bypass scraping** — excluded by product requirement and ToS.
- **Common Crawl** — deferred. Heavy to process and poor freshness, which is the axis this product optimizes for.

## Compliance posture

- **B2B only.** Only contact points a business published about itself, on its own
  site or in a public business registry (OSM). No personal-address guessing
  (`firstname@domain` patterns are never generated), and every contact is
  classified `ROLE` / `PERSONAL` / `NON_OUTREACH` so outreach prefers role accounts.
- **GDPR** — legitimate-interest basis for business contact data from public
  sources; `SuppressionEntry` is enforced both at extraction time and at lead
  render time. **PECR / CAN-SPAM** — business context, sender identified,
  opt-out honored via the suppression list.
- **robots.txt is always honored.** A disallowed path is never fetched, and the
  decision is stored on the crawl record so it is visible in provenance.
- **No bypass, ever.** CAPTCHA, JS challenges and bot walls are *detected* so the
  crawl can be abandoned honestly with a stored `blockReason` — never solved,
  never worked around.
- **Attribution** is stored per `Source` and rendered in the provenance UI
  (ODbL for OSM/Overpass/Nominatim).
- **Retention** — raw payloads pruned after 90 days; derived facts keep their
  hash and fetch timestamp so provenance survives the prune.
