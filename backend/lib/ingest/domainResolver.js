import prisma from "../../prismaClient.js";
import { verifyDomainIdentity } from "../verify/domainIdentity.js";
import { recordFact } from "../provenance/recorder.js";
import { normalizeCompanyName } from "../../utils/normalize.js";
import { log } from "../../utils/logger.js";

const logger = log("domainResolver");

/**
 * Finds a company's website when the source that discovered it did not say.
 *
 * A company found through a job board arrives with a name and nothing else, and
 * a lead with no way to contact it is worthless. Guessing `<name>.com` is cheap,
 * but a guess must never be *recorded* as fact.
 *
 * The judgement of whether a candidate page really belongs to the company lives
 * in lib/verify/domainIdentity.js, which every other source now shares. This
 * module's job is narrowed to what is unique to it: proposing sensible guesses
 * and stopping at the first one that survives verification. Keeping the two
 * apart is what stopped the resolver's careful checks from being the *only*
 * place they ran — OpenStreetMap tags and AI claims used to bypass them
 * entirely, which is how a closed Riyadh restaurant ended up pointing at a
 * hijacked domain serving gambling spam.
 */

const TLDS = [".com", ".io", ".co", ".ai", ".org", ".net"];

/** Country-specific suffixes worth trying for a business we can place. */
const COUNTRY_TLDS = {
  SA: [".com.sa", ".sa"], AE: [".ae", ".com.ae"], QA: [".qa", ".com.qa"],
  KW: [".com.kw"], BH: [".com.bh"], OM: [".com.om"], EG: [".com.eg"],
  GB: [".co.uk", ".uk"], DE: [".de"], FR: [".fr"], NL: [".nl"], ES: [".es"],
  IT: [".it"], PT: [".pt"], PK: [".com.pk"], IN: [".in", ".co.in"], TR: [".com.tr"],
};

/** Hosts that carry many companies — a match there proves nothing. */
const SHARED_HOSTS = /^(?:jobs|boards|apply|careers|my|app|www)\.|(?:greenhouse|lever|ashbyhq|workable|recruitee|smartrecruiters|linkedin|facebook|notion|github)\.(?:io|com|co)$/i;

/**
 * Build the guess list, most likely first.
 *
 * Local businesses in the Gulf register under the country suffix far more often
 * than under a bare .com, so when we know where a company is, those are tried
 * before the generic TLDs rather than after the candidate budget runs out.
 */
const candidateDomains = (companyName, countryCode = null) => {
  const norm = normalizeCompanyName(companyName);
  if (!norm || norm.length < 2) return [];

  const words = norm.split(" ").filter(Boolean);
  const stems = [...new Set([words.join(""), words.slice(0, 2).join(""), words[0]])]
    .filter((s) => s.length >= 3 && s.length <= 40);

  const suffixes = [...(COUNTRY_TLDS[countryCode] || []), ...TLDS];
  const out = [];
  for (const stem of stems) {
    for (const tld of suffixes) out.push(`${stem}${tld}`);
  }
  return [...new Set(out)].slice(0, 10);
};

/**
 * @returns {Promise<{found:boolean, domain?:string, evidence?:string, checked:number}>}
 */
export const resolveCompanyDomain = async (companyId, { maxCandidates = 5 } = {}) => {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    include: { domains: true, locations: { take: 1 }, aliases: true, contacts: { where: { kind: "PHONE" } } },
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
  const identityContext = {
    name: company.name,
    city: cityTrusted ? company.city : null,
    countryCode: cityTrusted ? company.countryCode : null,
    phones: company.contacts.map((c) => c.value),
    aliases: company.aliases.map((a) => a.alias),
  };

  const candidates = candidateDomains(company.name, cityTrusted ? company.countryCode : null)
    .slice(0, maxCandidates);
  let checked = 0;
  const rejections = [];

  for (const candidate of candidates) {
    if (SHARED_HOSTS.test(candidate)) continue;
    checked += 1;

    const identity = await verifyDomainIdentity(candidate, identityContext);

    if (identity.verdict !== "OWNED") {
      if (identity.verdict === "REJECTED" && identity.disqualifier !== "NO_IDENTITY") {
        rejections.push(`${candidate}: ${identity.disqualifier}`);
      }
      logger.debug({ company: company.name, candidate, verdict: identity.verdict, disqualifier: identity.disqualifier }, "candidate rejected");
      continue;
    }

    await prisma.companyDomain.upsert({
      where: { domain: identity.domain },
      update: {
        httpsOk: true,
        identityStatus: "CONFIRMED", identityScore: identity.score,
        identityReason: identity.reason.slice(0, 500), identityCheckedAt: new Date(),
      },
      create: {
        companyId, domain: identity.domain, discoveredVia: "WEBSITE_CRAWL", isPrimary: true, httpsOk: true,
        identityStatus: "CONFIRMED", identityScore: identity.score,
        identityReason: identity.reason.slice(0, 500), identityCheckedAt: new Date(),
      },
    });

    await recordFact({
      companyId,
      key: "resolved_domain",
      value: identity.domain,
      // DETECTED, not VERIFIED: the association is proven by evidence on the
      // page, which is strong but still an inference from public content.
      confidenceLevel: "DETECTED",
      extractorName: "domainResolver",
      evidenceSnippet: `${identity.reason} ${identity.evidence || ""}`.trim().slice(0, 500),
    });

    logger.info({ company: company.name, domain: identity.domain, score: identity.score }, "company domain resolved");
    return { found: true, domain: identity.domain, evidence: identity.evidence, score: identity.score, checked };
  }

  await recordFact({
    companyId,
    key: "domain_unresolved",
    value: "true",
    confidenceLevel: "VERIFIED",
    extractorName: "domainResolver",
    evidenceSnippet: `Checked ${checked} candidate domain(s) for "${company.name}"; none confirmed the company name.${rejections.length ? ` Rejected: ${rejections.join("; ")}.` : ""}`.slice(0, 500),
  });

  return { found: false, checked };
};

export const __testables = { candidateDomains, SHARED_HOSTS, COUNTRY_TLDS };
