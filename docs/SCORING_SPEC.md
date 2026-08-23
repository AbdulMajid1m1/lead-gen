# Scoring & Signal Specification

Scoring is a **capped, decayed, category-based weighted sum**. No black box, no
LLM input. Every point in a lead's score traces to a `Signal`, and every signal
traces to evidence. The breakdown JSON stored on the lead is exactly what the UI
renders.

## 1. Signal catalogue

`strength` is a 0–1 detection-quality multiplier computed per signal.

| SignalType | Weight | Half-life (d) | Deterministic detection rule |
|---|---|---|---|
| `NO_WEBSITE` | 30 | — | OSM element has name + phone/address but no `website`/`contact:website` tag, and no domain found by enrichment |
| `OUTDATED_WEBSITE` | 25 | 365 | `WebsiteAudit.overallScore < 40`; strength = (40 − score)/40 |
| `NO_HTTPS` | 15 | 365 | http:// only, or https fails / invalid certificate |
| `NO_MOBILE_VIEWPORT` | 12 | 365 | no `<meta name="viewport">` on the home page |
| `SLOW_SITE` | 8 | 180 | TTFB > 1500ms or HTML > 2MB; strength scaled |
| `OLD_COPYRIGHT` | 8 | 365 | footer copyright year ≤ currentYear − 2; strength = min(yearsBehind/5, 1) |
| `LEGACY_JS_LIB` | 8 | 365 | jQuery < 3 or Bootstrap < 4 detected |
| `WORDPRESS_DETECTED` | 6 | 365 | meta generator / `wp-content` paths |
| `WOOCOMMERCE_DETECTED` | 12 | 365 | WooCommerce assets/cookies |
| `SHOPIFY_DETECTED` | 8 | 365 | `cdn.shopify.com` / `x-shopid` header |
| `WIX_SQUARESPACE` | 10 | 365 | builder generator meta / vendor CDN assets |
| `MAGENTO_LEGACY` | 12 | 365 | Magento 1.x fingerprints |
| `NO_ONLINE_ORDERING` | 12 | 365 | restaurant/retail category **and** no order/menu/delivery/cart links or known widgets |
| `NO_BOOKING_SYSTEM` | 10 | 365 | appointment-based business **and** no booking widget or link |
| `NO_SCHEMA_ORG` | 5 | 365 | no JSON-LD or microdata on the home page |
| `NO_ANALYTICS` | 5 | 365 | no GA4/GTM/analytics script |
| `HIRING_TECH_ROLE` | 25 | 14 | ACTIVE job whose title/skills match the tech lexicon |
| `HIRING_CRM_ROLE` | 28 | 14 | CRM lexicon (salesforce, hubspot, dynamics, "CRM") |
| `HIRING_ECOM_ROLE` | 26 | 14 | e-commerce lexicon (shopify, magento, "e-commerce manager") |
| `HIRING_MOBILE_ROLE` | 26 | 14 | mobile lexicon (ios, android, react native, flutter) |
| `HIRING_AI_ROLE` | 26 | 14 | AI/automation lexicon |
| `HIRING_MANY_ROLES` | 10 | 21 | ≥3 ACTIVE postings |
| `NEW_DOMAIN` | 15 | 30 | first CT certificate `not_before` < 60 days ago |
| `NEW_SUBDOMAIN` | 12 | 30 | new `shop.` / `app.` / `booking.` / `store.` subdomain in CT within 60d |
| `CAREERS_PAGE_ACTIVE` | 6 | 60 | `/careers` or `/jobs` exists with openings text |
| `GROWTH_MENTION` | 8 | 60 | "we're expanding" / "now open" / "second location" on site or HN post |
| `MANUAL_PROCESS_HINT` | 10 | 180 | "call to order", "email us your CV", PDF-only menus/forms |
| `CONTACT_EMAIL_FOUND` / `CONTACT_PHONE_FOUND` / `CONTACT_FORM_FOUND` | — | — | reachability inputs, not opportunity points |

A signal is deactivated (`active = false`) when re-checked evidence contradicts
it — e.g. the site now ships a viewport meta tag. Deactivation is an update, not
a delete, so history survives.

## 2. Freshness decay

```
decay(signal) = signal.halfLifeDays ? 0.5 ** (ageDays / signal.halfLifeDays) : 1
ageDays       = now − signal.detectedAt
```

A hiring signal (14-day half-life) is worth half its weight after two weeks and
~6% after two months. A structural tech-debt signal (365 days) barely moves.
This is what stops a lead discovered eight months ago from looking fresh.

## 3. Score (0–100)

```
opportunityPoints = Σ over active opportunity signals of (weight × strength × decay)   capped at 50
freshnessScore    = 25 × max(decay of the newest 3 signals)                             capped at 25
reachability      = 15 email · 10 phone-only · 6 form-only · 0 none                     capped at 15
fit               = +5 industry in target lexicon, +3 size MICRO/SMALL/MEDIUM,
                    +2 country in configured markets                                    capped at 10

score = clamp(round(opportunity + freshness + reachability + fit), 0, 100)
```

A lead scoring < 20, or with no active signals, is not created (and an existing
one is marked `STALE`).

## 4. Opportunity mapping

The primary opportunity is the highest-scoring bucket:

| Service | Contributing signals |
|---|---|
| `WEBSITE_DEV` | NO_WEBSITE, OUTDATED_WEBSITE, NO_HTTPS, NO_MOBILE_VIEWPORT, OLD_COPYRIGHT, LEGACY_JS_LIB, WIX_SQUARESPACE, SLOW_SITE, NO_SCHEMA_ORG |
| `ECOMMERCE_DEV` | NO_ONLINE_ORDERING, MAGENTO_LEGACY, WOOCOMMERCE_DETECTED (low audit), HIRING_ECOM_ROLE, NEW_SUBDOMAIN (`shop.`) |
| `MOBILE_APP` | WOOCOMMERCE/SHOPIFY_DETECTED with no app links, HIRING_MOBILE_ROLE, NO_ONLINE_ORDERING (restaurant) |
| `CRM_DEV` | HIRING_CRM_ROLE, MANUAL_PROCESS_HINT, HIRING_MANY_ROLES (sales-heavy) |
| `AI_AUTOMATION` | HIRING_AI_ROLE, MANUAL_PROCESS_HINT, NO_BOOKING_SYSTEM |
| `SAAS_DEV` / `CUSTOM_SOFTWARE` | HIRING_TECH_ROLE, NEW_DOMAIN, CAREERS_PAGE_ACTIVE, GROWTH_MENTION |

`LeadType`: hiring signals dominant → `HIRING_INTENT`; NEW_DOMAIN/NEW_SUBDOMAIN
dominant → `NEW_BUSINESS`; NO_WEBSITE → `DIGITAL_GAP`; otherwise `TECH_DEBT`.

## 5. `scoreBreakdown` JSON

Stored on `Lead`, rendered directly by the UI:

```json
{
  "version": 2,
  "categories": { "opportunity": 41, "freshness": 21, "reachability": 15, "fit": 8 },
  "signals": [
    { "type": "HIRING_CRM_ROLE", "raw": 28, "strength": 1, "decay": 0.81, "points": 22.7, "signalId": "…" }
  ],
  "caps": { "opportunity": 50, "freshness": 25, "reachability": 15, "fit": 10 },
  "total": 85,
  "scoredAt": "2026-08-17T…"
}
```

## 6. Job activity determination

The hardest correctness problem in the product: an old job page that still
returns 200 is **not** an active hiring signal.

Classification on each observation:

1. Job present in the current board fetch (Greenhouse/Lever/Ashby/SmartRecruiters/
   Workable/Recruitee) → **ACTIVE**. Sets `lastSeenActiveAt = now`, evidence
   `{ method: "board_refetch", boardHadJob: true }`. This is the only source of
   ACTIVE truth.
2. Previously ACTIVE, absent from a *successful* board fetch → **RECENTLY_ACTIVE**,
   `disappearedAt = now`. Still absent 14 days later → **EXPIRED**.
3. `deadlineAt` in the past → **EXPIRED** regardless of anything else.
4. Aggregator-sourced job with no probeable board: direct URL check. 404/410 or a
   redirect to the board root → **CLOSED**. 200 containing "no longer accepting" /
   "position filled" → **CLOSED**.
5. Aggregator-only, `postedAt` older than 45 days, no probeable ATS → **UNKNOWN**.

**UNKNOWN and EXPIRED/CLOSED never generate `HIRING_*` signals or points.**

Re-verification cadence (BullMQ repeatable jobs): companies with ACTIVE jobs are
re-fetched every 24h (one board call re-verifies all of that company's jobs);
RECENTLY_ACTIVE every 48h until resolved; UNKNOWN-with-URL weekly; EXPIRED/CLOSED
never. Every check stamps `lastVerifiedAt` and appends to `statusEvidence`.
