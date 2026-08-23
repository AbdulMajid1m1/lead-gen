# Query Playbook — selling your own offerings through LeadSignal

The engine is offering-agnostic: a converting lead is a company showing the
**trigger event** that makes someone buy what you sell. This playbook maps two
real offerings to their trigger events and the exact queries that find them.
Add a section per new offering — if its trigger can't be expressed in signals
below, extend the lexicon/signal catalogue the way `HIRING_HR_ROLE` was added.

## DevEntia Tech — custom software / SaaS / AI agency (deventiatech.com)

A converting lead has an *active initiative and budget*, not just a bad website.

| Trigger event | Query to type | Signal behind it |
|---|---|---|
| Hiring developers right now (budget committed, delivery gap while the role is open) | `companies hiring software developers` | HIRING_TECH_ROLE, verified live against the company's own job board |
| Active AI initiative | `startups hiring AI engineers` | HIRING_AI_ROLE |
| Mobile app being built | `companies hiring mobile developers` | HIRING_MOBILE_ROLE |
| CRM rollout underway | `companies hiring CRM specialists this month` | HIRING_CRM_ROLE + freshness window |
| Dated web presence in a target geo | `restaurants in Dubai with outdated websites` · `real estate agencies in Riyadh with outdated websites` | audit score, stale copyright, legacy libs |
| No web presence at all | `hair salons in Jeddah with no website` | NO_WEBSITE from the map listing itself |
| Lost walk-in revenue | `restaurants in Riyadh with no online ordering` · `clinics in Dubai without online booking` | capability gap vs. industry norm |
| Brand-new business building out | `new businesses in Dubai` | NEW_DOMAIN via certificate transparency |

Geo tip: name a **city**, not a country — the map engine searches a radius.
DevEntia sells worldwide, so rotate cities: Dubai, Riyadh, Jeddah, Manchester,
London, Austin…

## TracefyHR — HR SaaS: payroll, leave, attendance, ATS (tracefyhr.com)

A converting lead is a company at the **HR pain threshold** — the moment HR
becomes someone's job and spreadsheets stop working.

| Trigger event | Query to type | Signal behind it |
|---|---|---|
| **Hiring their first/next HR person** (the classic buy trigger) | `companies hiring HR managers` · `companies hiring their first HR officer` | HIRING_HR_ROLE — recruiter/people-ops/payroll titles on live boards |
| Recruiting function forming | `companies hiring recruiters` | HIRING_HR_ROLE (talent-acquisition titles) |
| Headcount growing fast (payroll/leave pain compounding) | `companies hiring many roles at once` | HIRING_MANY_ROLES (≥3 live postings) |
| Expansion / new locations (multi-site attendance) | `expanding companies in Riyadh` | GROWTH_MENTION, NEW_SUBDOMAIN |
| Stated need | `growing companies that need HR software` | service = HR_SOFTWARE |
| Geo-targeted (product ships Arabic) | `companies hiring HR staff in Riyadh` · `companies hiring recruiters in Dubai` | HR signal + location |

Outreach emails for a research run pitch **the offering the query asked for**
(`brief.service`), not the lead's dominant signal — so a TracefyHR run emails
about payroll/leave/attendance even to a company whose bigger footprint is
engineering hiring.

## Adding your next offering

1. Name the trigger event (what happens at a company the week before they'd buy).
2. If it's observable in public evidence (jobs, site tech, map listings, CT
   logs), map it: lexicon phrases → signal → service, as in commit `hr_vertical`.
3. Add golden parser tests for the queries you'll actually type.
4. Re-run `npm test` and one live search before trusting it.
