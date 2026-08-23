import prisma from "../../prismaClient.js";
import { fetchPage } from "../crawler/fetchPage.js";
import { recordFact } from "../provenance/recorder.js";
import { normalizeCompanyName, normalizeDomain } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("domainResolver");

/**
 * Finds a company's website when the source that discovered it did not say.
 *
 * A company found through a job board arrives with a name and nothing else, and
 * a lead with no way to contact it is worthless. Guessing `<name>.com` is cheap,
 * but a guess must never be *recorded* as fact — so every candidate is fetched
 * and only accepted when the page itself proves the association by naming the
 * company. The resulting domain is stored with DETECTED confidence and the
 * matching snippet as evidence.
 */

const TLDS = [".com", ".io", ".co", ".ai", ".org", ".net"];

/** Domains that host many companies — a match there proves nothing. */
const SHARED_HOSTS = /^(?:jobs|boards|apply|careers|my|app|www)\.|(?:greenhouse|lever|ashbyhq|workable|recruitee|smartrecruiters|linkedin|facebook|notion|github)\.(?:io|com|co)$/i;

/**
 * Parked domains, brokers and for-sale pages.
 *
 * These are the resolver's worst failure mode: a short company name almost
 * always has a matching .com, and a parked page happily echoes that name in its
 * title. Left unchecked it attaches a domain broker's address to a real
 * business — which is how "Gad" in Riyadh acquired info@domainster.com.
 */
const PARKED_MARKERS = /\b(?:domainster|sedo|afternic|dan\.com|hugedomains|buydomains|namecheap parking|godaddy(?:\.com)? (?:parking|auctions)|this domain (?:is|may be) for sale|buy this domain|the domain .{0,40} is for sale|parked (?:free )?(?:domain|courtesy)|inquire about this domain)\b/i;

/**
 * A name match alone is not identification.
 *
 * "French Corner" matches a café in Riyadh, a bakery in Chicago and a shop in
 * Paris. When we know where the business actually is, the page has to show some
 * sign of the same place before we accept the domain — otherwise the resolver
 * confidently attaches a stranger's website and email to the lead.
 */
const pageCorroboratesLocation = (html, { city, countryCode, domain }) => {
  if (!city && !countryCode) return { ok: true, how: "no location known to check against" };

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (city && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
    return { ok: true, how: `the page mentions ${city}` };
  }

  // A country-code TLD is strong geographic evidence in itself.
  const ccTld = { SA: ".sa", AE: ".ae", GB: ".uk", DE: ".de", FR: ".fr", NL: ".nl", ES: ".es", IT: ".it", PT: ".pt", PK: ".pk", IN: ".in" }[countryCode];
  if (ccTld && domain.endsWith(ccTld)) return { ok: true, how: `the domain uses the ${ccTld} country suffix` };

  // Or the country named in the page text.
  const countryNames = { SA: "saudi", AE: "emirates|dubai|abu dhabi", GB: "united kingdom|england|scotland|wales",
                         DE: "germany|deutschland", FR: "france", NL: "netherlands", ES: "spain|españa",
                         IT: "italy|italia", PT: "portugal", PK: "pakistan", IN: "india" }[countryCode];
  if (countryNames && new RegExp(`\\b(?:${countryNames})\\b`, "i").test(text)) {
    return { ok: true, how: "the page names the same country" };
  }

  return { ok: false, how: null };
};

const candidateDomains = (companyName) => {
  const norm = normalizeCompanyName(companyName);
  if (!norm || norm.length < 2) return [];
  const words = norm.split(" ").filter(Boolean);
  const stems = [...new Set([words.join(""), words.slice(0, 2).join(""), words[0]])].filter((s) => s.length >= 3 && s.length <= 40);

  const out = [];
  for (const stem of stems) {
    for (const tld of TLDS) out.push(`${stem}${tld}`);
  }
  return out.slice(0, 8);
};

/**
 * Does this page actually belong to this company?
 * Requires the name in the title, an og:site_name, or a copyright line — all
 * places a site states its own identity, rather than anywhere on the page.
 */
const pageConfirmsCompany = (html, companyName) => {
  const norm = normalizeCompanyName(companyName);
  if (!norm) return null;
  const firstWord = norm.split(" ")[0];
  if (firstWord.length < 3) return null;

  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)?.[1] || "";
  const ogSite = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{0,120})["']/i.exec(html)?.[1] || "";
  const copyright = /(?:©|&copy;|copyright)[^<]{0,80}/i.exec(html)?.[0] || "";

  for (const [where, text] of [["title", title], ["og:site_name", ogSite], ["copyright notice", copyright]]) {
    const normalizedText = normalizeCompanyName(text.replace(/<[^>]+>/g, " "));
    if (normalizedText && (normalizedText.includes(norm) || normalizedText.includes(firstWord))) {
      return { where, snippet: text.replace(/\s+/g, " ").trim().slice(0, 200) };
    }
  }
  return null;
};

/**
 * @returns {Promise<{found:boolean, domain?:string, evidence?:string, checked:number}>}
 */
export const resolveCompanyDomain = async (companyId, { maxCandidates = 5 } = {}) => {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { domains: true, locations: { take: 1 } },
  });
  if (!company) throw new Error(`Company ${companyId} not found`);
  if (company.domains.length > 0) {
    return { found: true, domain: company.domains[0].domain, alreadyKnown: true, checked: 0 };
  }

  // A city is only usable for the location check when it describes the company
  // itself — a map listing or geocoded address. Companies from job boards carry
  // the *job posting's* location ("London" for a remote role at a US company),
  // and checking the homepage against that rejects the real website. That is
  // exactly how Stripe, Ripple and Anthropic ended up labelled "no website".
  const cityTrusted = Boolean(company.osmCategory || company.locations.length > 0);
  const geoContext = {
    city: cityTrusted ? company.city : null,
    countryCode: cityTrusted ? company.countryCode : null,
  };

  const candidates = candidateDomains(company.name).slice(0, maxCandidates);
  let checked = 0;

  for (const candidate of candidates) {
    if (SHARED_HOSTS.test(candidate)) continue;
    checked += 1;

    const res = await fetchPage(`https://${candidate}/`, { timeoutMs: 10_000, maxBytes: 1_500_000 });
    if (!res.ok || !res.body) continue;

    // A redirect to a different registrable domain is the site telling us its
    // real address — follow that rather than the guess.
    const finalDomain = normalizeDomain(res.finalUrl) || candidate;

    // A domain-broker page will echo any name back at us — reject before the
    // name check even runs.
    if (PARKED_MARKERS.test(res.body)) {
      logger.debug({ company: company.name, candidate }, "candidate domain is parked or for sale — rejected");
      continue;
    }

    const confirmation = pageConfirmsCompany(res.body, company.name);
    if (!confirmation) {
      logger.debug({ company: company.name, candidate }, "candidate domain did not confirm the company name");
      continue;
    }

    const geo = pageCorroboratesLocation(res.body, { ...geoContext, domain: finalDomain });
    if (!geo.ok) {
      logger.debug(
        { company: company.name, candidate, city: company.city },
        "name matched but the page shows no link to the company's location — rejected as a probable name collision",
      );
      continue;
    }

    await prisma.companyDomain.upsert({
      where: { domain: finalDomain },
      update: { httpsOk: true },
      create: { companyId, domain: finalDomain, discoveredVia: "WEBSITE_CRAWL", isPrimary: true, httpsOk: true },
    });

    await recordFact({
      companyId,
      key: "resolved_domain",
      value: finalDomain,
      // DETECTED, not VERIFIED: the association is proven by a name match on
      // the page, which is strong but still an inference from public content.
      confidenceLevel: "DETECTED",
      extractorName: "domainResolver",
      evidenceSnippet: `Resolved ${finalDomain} for "${company.name}" — the site's ${confirmation.where} reads: ${confirmation.snippet}. Location corroborated because ${geo.how}.`,
    });

    logger.info({ company: company.name, domain: finalDomain, via: confirmation.where }, "company domain resolved");
    return { found: true, domain: finalDomain, evidence: confirmation.snippet, checked };
  }

  await recordFact({
    companyId,
    key: "domain_unresolved",
    value: "true",
    confidenceLevel: "VERIFIED",
    extractorName: "domainResolver",
    evidenceSnippet: `Checked ${checked} candidate domain(s) for "${company.name}"; none confirmed the company name.`,
  });

  return { found: false, checked };
};
