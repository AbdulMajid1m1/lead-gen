# Apify as a lead source — assessment (2026-09-02)

Question: should LeadSignal connect to Apify, and would it give more or better
leads — specifically, owners' email addresses rather than `info@` or a
platform's support desk?

## What Apify is

A marketplace ("Apify Store") of hosted scrapers called Actors, with the
proxies, scheduling, datasets and API around them. You call somebody else's
scraper and pull JSON. Plans as of September 2026 (apify.com/pricing): Free
$0 with $5 credit a month, Starter $19, Scale $199, Business $999. Compute is
$0.20 per compute unit; most Store actors are pay-per-result with platform
usage included. Credits do not roll over.

## Actors that matter for this product

| Actor | Returns | Price | Note |
|---|---|---|---|
| `compass/crawler-google-places` | Maps fields: name, address, phone, website, category, hours, reviews | $1.50 / 1,000 places | Emails only via add-ons. |
| `lukaskrivka/google-maps-with-contact-details` | Maps fields plus emails, phones, socials, optional staff names | $2.10 / 1,000 places | Gets emails by crawling the business website — the same source we crawl. |
| `vdrmota/contact-info-scraper` | Emails, phones, 13 social networks from any URL list | from $1.05 / 1,000 pages | Drop-in for our own crawler. |
| `ryanclinton/google-maps-lead-enricher` | Decision-maker name, title, LinkedIn, email | $0.30 per lead ($300 / 1,000) | Email is often pattern-guessed, not observed. |
| `samstorm/restaurant-lead-scraper` | Business fields plus DNS/SMTP-verified emails | from $50 / 1,000 | Marketing says "owner contacts"; the page says it crawls contact pages and returns no owner name. |

## Will it find the owner's email?

Mostly no. Every mainstream Maps-with-emails actor reads the email off the
business's own website, which is exactly what LeadSignal already does, so it
surfaces the same `info@` and the same platform address. What Apify does add:

- Volume and breadth: $1.50–$2.10 per 1,000 businesses is far cheaper and less
  rate-limited than the Google Places API, and it beats hand-rolled Overpass
  and Nominatim for coverage in cities OSM maps thinly.
- Social pages: Facebook and Instagram "email" buttons often carry a more
  personal address than the website footer. Incremental, real.
- Owner names, not owner emails, via the enrichment actors. At 200 times the
  cost of the Maps scrape, and a restaurant on a Wix site with no team page
  has no name to anchor a pattern to.

Owner discovery for a small local business has no better source than the
business's own team or about page, its Companies House or state filing, and
its social profiles. That is the lever inside LeadSignal (owner-first ranking
in `pickEmailContact`, the team-page crawl), not a third-party feed.

## Alternatives

- Outscraper: the closest substitute, about $3 per 1,000 Maps records plus $3
  per 1,000 for emails, pay-as-you-go with no subscription. Same data.
- Hunter, Snov, Prospeo, Apollo: domain-to-employee databases built on tech
  and enterprise coverage. Near-zero coverage of a two-person salon in Dubai.
- Google Places API: dearer per record and its terms forbid retaining most
  fields beyond Place IDs.

## Legal notes

Scraping Google Maps breaches Google's terms for the operator (a contract
matter, not a criminal one); LeadSignal inherits continuity and reputation
risk, not liability. Cold email itself is the bigger exposure: UK PECR reg. 22
allows it to corporate subscribers only — sole traders and ordinary
partnerships are individual subscribers and need consent, and that describes
many of the salons and restaurants in the book. US CAN-SPAM is opt-out. UAE
and Saudi PDPL are consent-based for named individuals; role addresses sit
outside them. `lib/outreach/sendPolicy.js` already encodes this per country.

## Recommendation

Integrate Apify for discovery volume, not for owner identity.

1. Add `lukaskrivka/google-maps-with-contact-details` as a discovery adapter
   next to Overpass, at about $3–5 per 1,000 leads all-in on the $19 plan.
   One call returns the business record and its website/social contacts.
2. Keep our crawler as the control point: the platform blocklist
   (`lib/verify/hostedPlatforms.js`) and the excluded-trade rule
   (`lib/qualify/excludedCategories.js`) must run on Apify output too — the
   actors do not filter bars, casinos or Menufy addresses for us.
3. Do not buy the $300 / 1,000 enricher as a default stage. Gate it behind
   ICP fit and a confirmed first-party domain; at 5 percent of volume that is
   about $15 per 1,000 discovered leads.
4. Skip Apollo, Hunter, Snov and Clearbit for this segment.

### Integration sketch

```js
import { ApifyClient } from "apify-client";
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

// Start the run, then wait: the run-sync REST endpoint aborts at 300 s and a
// real Maps batch takes longer than that.
const run = await client.actor("lukaskrivka/google-maps-with-contact-details").call({
  searchStringsArray: ["dental clinic"],
  locationQuery: "Manchester, UK",
  maxCrawledPlacesPerSearch: 200,
});
const { items } = await client.dataset(run.defaultDatasetId).listItems();
// items[] → resolveCompany({ name, domain, phone, city, countryCode, industry, discoveredVia: "APIFY" })
//           after classifyExcludedBusiness() and hostedPlatformFor() have run on each.
```

For unattended runs use an `ACTOR.RUN.SUCCEEDED` webhook pointing at a
LeadSignal endpoint instead of polling. `SourceKind` would need an `APIFY`
value (a migration), and every record should carry the actor run ID as its
external ID for provenance.

Sources: apify.com/pricing · apify.com/compass/crawler-google-places ·
apify.com/lukaskrivka/google-maps-with-contact-details ·
apify.com/vdrmota/contact-info-scraper ·
apify.com/ryanclinton/google-maps-lead-enricher ·
apify.com/samstorm/restaurant-lead-scraper · docs.apify.com/api/client/js ·
docs.apify.com/api/v2/act-run-sync-get-dataset-items-post ·
cloud.google.com/maps-platform/terms · outscraper.com
