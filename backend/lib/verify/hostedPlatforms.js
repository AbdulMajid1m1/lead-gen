import { normalizeDomain, normalizeHostname } from "../../utils/normalize.js";

/**
 * Domains that host many businesses' pages, so a URL there never identifies
 * the business — it identifies the platform.
 *
 * This exists because of Bombay Bistro, Austin. Its OpenStreetMap listing gave
 * `bombay-bistro-larmar.menufy.com` as the website. The resolver reduced that
 * to the registrable domain `menufy.com`, the crawler fetched Menufy's own
 * homepage, and the pipeline dutifully recorded Menufy's description, Menufy's
 * `info@` address, Menufy's social profiles and a "person" called "Chargeback
 * Protection" as facts about a small Indian restaurant. The identity check
 * even said WEAK — and the email still went to Menufy's support desk, whose
 * ticketing system wrote back "your request has been received", which the
 * inbox scan then recorded as the restaurant replying.
 *
 * Every entry here is a registrable domain. Subdomains match by suffix, so
 * `*.menufy.com`, `*.wixsite.com` and `business.site` pages are all caught.
 * `kind` says what the page is, which decides what the ingest does with it:
 * an ORDERING or BOOKING page is evidence the business trades online but has
 * no site of its own; a SOCIAL page is a contact point worth keeping.
 */
const PLATFORMS = [
  // Online ordering / delivery marketplaces and white-label ordering pages
  ...["menufy.com", "toasttab.com", "grubhub.com", "seamless.com", "doordash.com", "ubereats.com",
    "postmates.com", "chownow.com", "slicelife.com", "popmenu.com", "getbento.com", "beyondmenu.com",
    "gloriafood.com", "foodbooking.com", "flipdish.com", "olo.com", "ezcater.com", "order.online",
    "ordering.app", "square.site", "squareup.com", "clover.com", "zomato.com", "talabat.com",
    "deliveroo.com", "deliveroo.co.uk", "deliveroo.ae", "just-eat.co.uk", "justeat.co.uk", "just-eat.com",
    "lieferando.de", "lieferando.at", "thuisbezorgd.nl", "takeaway.com", "foodpanda.com", "hungerstation.com",
    "careem.com", "noon.com", "glovoapp.com", "wolt.com", "menulog.com.au", "skipthedishes.com",
    "allmenus.com", "menupages.com", "zmenu.com", "sirved.com", "restaurantji.com", "untappd.com", "eatbu.com"]
    .map((domain) => ({ domain, kind: "ORDERING", label: "online ordering page" })),
  // Reservations / appointments
  ...["opentable.com", "opentable.co.uk", "resy.com", "thefork.com", "thefork.co.uk", "quandoo.de", "quandoo.co.uk",
    "quandoo.com", "sevenrooms.com", "tock.com", "booksy.com", "fresha.com", "treatwell.co.uk", "treatwell.de",
    "vagaro.com", "mindbodyonline.com", "schedulicity.com", "zocdoc.com", "doctolib.de", "doctolib.fr",
    "jameda.de", "healthgrades.com", "practo.com", "okadoc.com", "setmore.com", "calendly.com", "acuityscheduling.com",
    "booking.com", "airbnb.com", "expedia.com", "hotels.com", "agoda.com", "trivago.com"]
    .map((domain) => ({ domain, kind: "BOOKING", label: "booking page" })),
  // Directories and review sites
  ...["yelp.com", "yelp.co.uk", "yelp.de", "tripadvisor.com", "tripadvisor.co.uk", "tripadvisor.de", "google.com",
    "goo.gl", "g.page", "yell.com", "yellowpages.com", "yellowpages.ae", "192.com", "thomsonlocal.com", "foursquare.com",
    "trustpilot.com", "checkatrade.com", "bark.com", "houzz.com", "rightmove.co.uk", "zoopla.co.uk", "onthemarket.com",
    "propertyfinder.ae", "bayut.com", "dubizzle.com", "autotrader.co.uk", "autotrader.com", "mobile.de", "cars.com",
    "cargurus.com", "dealerspike.com", "gelbeseiten.de", "dasoertliche.de", "paginasamarelas.pt", "paginegialle.it",
    "pagesjaunes.fr", "nextdoor.com", "bbb.org", "manta.com", "hotfrog.com", "cylex.com", "opencorporates.com",
    "companieshouse.gov.uk", "find-and-update.company-information.service.gov.uk"]
    .map((domain) => ({ domain, kind: "DIRECTORY", label: "directory listing" })),
  // Social profiles and link pages
  ...["facebook.com", "fb.com", "fb.me", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com",
    "youtube.com", "youtu.be", "pinterest.com", "snapchat.com", "threads.net", "linktr.ee", "linktree.com", "beacons.ai",
    "bio.link", "lnk.bio", "wa.me", "whatsapp.com", "t.me", "telegram.me", "bit.ly", "tinyurl.com", "rebrand.ly"]
    .map((domain) => ({ domain, kind: "SOCIAL", label: "social profile" })),
  // Free site builders and hosted storefronts — the page is the business's
  // own, but the domain is not, so it can never anchor identity or email.
  ...["wixsite.com", "wix.com", "wixpress.com", "weebly.com", "squarespace.com", "godaddysites.com", "business.site",
    "sites.google.com", "wordpress.com", "blogspot.com", "webnode.com", "webnode.page", "jimdosite.com", "jimdofree.com",
    "jimdo.com", "strikingly.com", "carrd.co", "canva.site", "myshopify.com", "shopify.com", "bigcartel.com", "webflow.io",
    "netlify.app", "vercel.app", "github.io", "notion.site", "notion.so", "yolasite.com", "site123.me", "simplesite.com",
    "webs.com", "ueniweb.com", "mystrikingly.com", "hubspotpagebuilder.com", "godaddy.com", "one.com", "ionos.com"]
    .map((domain) => ({ domain, kind: "SITE_BUILDER", label: "hosted site-builder page" })),
  // Recruiting platforms — kept from the old identity check
  ...["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "recruitee.com", "smartrecruiters.com",
    "bamboohr.com", "indeed.com", "glassdoor.com"]
    .map((domain) => ({ domain, kind: "DIRECTORY", label: "recruiting platform" })),
];

/**
 * Help-desk platforms and mail domains of vendors' support desks. An email
 * here is answered by a ticket queue, never by the business we are writing to.
 */
const HELPDESK_DOMAINS = [
  "zendesk.com", "freshdesk.com", "helpscout.net", "helpscout.com", "intercom.io", "intercom-mail.com",
  "hubspot.com", "kayako.com", "zohodesk.com", "desk.com", "servicenow.com", "atlassian.net", "jira.com",
  "gorgias.com", "front.com", "frontapp.com", "reamaze.com", "tawk.to", "crisp.chat", "groovehq.com",
];

const byDomain = new Map(PLATFORMS.map((p) => [p.domain, p]));
const helpdesks = new Set(HELPDESK_DOMAINS);

const suffixMatch = (host, table) => {
  if (!host) return null;
  const labels = host.split(".");
  // Try the full host, then each shorter suffix: a.b.menufy.com → b.menufy.com → menufy.com
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join(".");
    const hit = table.get ? table.get(candidate) : (table.has(candidate) ? { domain: candidate } : null);
    if (hit) return hit;
  }
  return null;
};

/**
 * The platform a URL or domain belongs to, or null when it is a real
 * first-party site.
 *
 * @returns {{domain:string, kind:"ORDERING"|"BOOKING"|"DIRECTORY"|"SOCIAL"|"SITE_BUILDER", label:string, host:string}|null}
 */
export const hostedPlatformFor = (urlOrDomain) => {
  const host = normalizeHostname(urlOrDomain);
  if (!host) return null;
  const hit = suffixMatch(host, byDomain);
  return hit ? { ...hit, host } : null;
};

/** True when the registrable domain is a platform, whatever the subdomain. */
export const isHostedPlatformDomain = (urlOrDomain) => hostedPlatformFor(urlOrDomain) !== null;

/**
 * Whether an email address belongs to a platform or a help desk rather than
 * to the business that published it.
 *
 * `companyDomain` is optional: when known, an address on the company's own
 * domain is always theirs, even if that domain were somehow on the list.
 */
export const emailBelongsToPlatform = (email, companyDomain = null) => {
  const at = String(email || "").lastIndexOf("@");
  if (at < 0) return null;
  const host = String(email).slice(at + 1).toLowerCase().trim();
  if (!host) return null;
  const own = normalizeDomain(companyDomain);
  if (own && (host === own || host.endsWith(`.${own}`))) return null;
  const platform = suffixMatch(host, byDomain);
  if (platform) return { domain: platform.domain, kind: platform.kind, label: platform.label };
  const desk = suffixMatch(host, helpdesks);
  if (desk) return { domain: desk.domain, kind: "HELPDESK", label: "help-desk platform" };
  return null;
};

/** Every platform domain, for callers that build their own filters. */
export const HOSTED_PLATFORM_DOMAINS = new Set(byDomain.keys());
export const __testables = { PLATFORMS, HELPDESK_DOMAINS };
