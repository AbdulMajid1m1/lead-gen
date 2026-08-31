import prisma from "../../prismaClient.js";
import { parseStructured, isResearchAvailable, CostTracker } from "../llm/responses.js";
import {
  COMPOSE_SYSTEM, buildComposeUser, COMPOSE_SCHEMA,
  BATCH_COMPOSE_SYSTEM, buildBatchComposeUser, BATCH_COMPOSE_SCHEMA,
  PROMOTE_COMPOSE_SYSTEM, buildPromoteComposeUser, PROMOTE_COMPOSE_SCHEMA,
  PROMPT_VERSION,
} from "./prompts.js";
import { initialTemplate, productInitialTemplate } from "./templates.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { AI_FAST_MODEL, AI_COMPOSE_MAX_LEADS, PROMOTER_MAX_LEADS_PER_RUN } from "../../configs/envConfig.js";
import { relativeAge } from "../scoring/decay.js";
import { emailMatchesName, isGreetableName, looksLikeJobTitle } from "../extract/people.js";
import { log } from "../../utils/logger.js";

/** Leads per AI call. The system prompt is paid once per chunk, not per lead. */
const BATCH_SIZE = 8;

const logger = log("research:compose");

/**
 * Writes the ready-to-copy outreach email for a lead.
 *
 * The model sees a numbered list of *verified facts only* — never the raw site,
 * never an unverified AI claim. That is what stops the most damaging failure
 * mode in this product: a confident, personalised email built on something that
 * was never true, which the user pastes into a real conversation.
 */

/**
 * Signals that only mean something when the thing being sold is the website.
 *
 * These are the agency's diagnostics: the site is slow, it is on WooCommerce,
 * it takes no bookings. Sound reasons to pitch web work, and actively harmful
 * when the offering is a product that has nothing to do with the site. Left in,
 * they produced a real email telling a Dubai school that "the store runs on
 * WooCommerce and commonly needs checkout work" and then offering it payroll
 * software — two unrelated thoughts in one paragraph, from a sender who plainly
 * had not looked at the business.
 *
 * Everything not listed here describes the company's own situation — it is
 * hiring, it is expanding, it published a named manager — and travels with any
 * offering, so a promote run keeps those.
 */
const WEBSITE_PITCH_SIGNALS = new Set([
  "NO_WEBSITE", "OUTDATED_WEBSITE", "NO_HTTPS", "NO_MOBILE_VIEWPORT", "SLOW_SITE",
  "OLD_COPYRIGHT", "LEGACY_JS_LIB", "WORDPRESS_DETECTED", "WOOCOMMERCE_DETECTED",
  "SHOPIFY_DETECTED", "WIX_SQUARESPACE", "MAGENTO_LEGACY", "NO_ONLINE_ORDERING",
  "NO_BOOKING_SYSTEM", "NO_SCHEMA_ORG", "NO_ANALYTICS",
]);

/**
 * An address worth stating.
 *
 * OSM supplies a house number and a street separately, and a record carrying
 * only one of them yields "Its address is 51d شارع" — a fragment that reads as
 * carelessness in an email and tells the reader nothing.
 */
/**
 * The name to greet someone by.
 *
 * Taking the first token gives "Mr." for "Mr. Tariq Atwan" — schools and
 * clinics publish their staff with honorifics almost without exception, so the
 * greeting read "Hi Mr.,". Strip the honorific, and fall back to the whole
 * string if that is all there was.
 */
const HONORIFIC = /^(?:mr|mrs|ms|miss|mx|dr|prof|professor|eng|engr|sheikh|shaikh|sir|madam|rev|fr|sr|capt|adv)\.?$/i;

export const firstNameOf = (fullName) => {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const named = parts.filter((p) => !HONORIFIC.test(p));
  return (named[0] || parts[0] || "").replace(/[.,]+$/, "");
};

/**
 * The industry as a person would say it.
 *
 * The catalogue labels categories for a filter menu — "School / academy",
 * "Hair & beauty salon", "IT / software company" — and dropping one into a
 * sentence produces "is a School / academy in Dubai", which reads as a database
 * row rather than something anyone wrote.
 */
const humanIndustry = (label) => {
  const first = String(label || "").split("/")[0].trim();
  if (!first) return "business";
  // Only lower-case a label that is not a proper noun already: "IT" stays "IT".
  return /^[\p{Lu}][\p{Ll}]/u.test(first) ? first.charAt(0).toLowerCase() + first.slice(1) : first;
};

const addressIsUsable = (line) => {
  const text = String(line || "").trim();
  if (text.length < 10) return false;
  return text.replace(/[\d\s.,-]+/g, " ").trim().split(/\s+/).filter((w) => w.length > 2).length >= 2;
};

/**
 * Assemble the facts a lead is allowed to be described by.
 *
 * `forProduct` narrows them to what is true of the company rather than of its
 * website, for a run that is promoting a product instead of selling the
 * agency's own services.
 */
export const gatherFacts = async (leadId, { forProduct = false } = {}) => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      company: {
        include: {
          contacts: { where: { isSuppressed: false } },
          domains: true,
          locations: { take: 1 },
          tech: true,
          audits: { orderBy: { auditedAt: "desc" }, take: 1 },
          jobPostings: { where: { status: "ACTIVE" }, take: 3 },
          // Best outreach target first; the enum is declared most-senior-first.
          people: { orderBy: [{ seniority: "asc" }, { email: "desc" }], take: 1 },
        },
      },
      // The signal type is what tells a company-state reason apart from a
      // website-diagnostic one; the reason text alone cannot be classified.
      reasons: { orderBy: { rank: "asc" }, include: { signal: { select: { type: true } } } },
    },
  });
  if (!lead) return null;

  const c = lead.company;
  const facts = [];
  const add = (text, confidenceLevel, observedAt) =>
    facts.push({ id: facts.length + 1, text, confidenceLevel, observedAt: observedAt ? relativeAge(observedAt) : null });

  add(`${c.name} is a ${humanIndustry(c.industry)}${c.city ? ` in ${c.city}` : ""}.`, "VERIFIED", c.firstSeenAt);
  if (c.domains[0]) add(`Its website is ${c.domains[0].domain}.`, "VERIFIED", c.lastCrawledAt);
  if (addressIsUsable(c.locations[0]?.addressLine)) add(`Its address is ${c.locations[0].addressLine}.`, "VERIFIED", null);

  for (const reason of lead.reasons) {
    if (forProduct && WEBSITE_PITCH_SIGNALS.has(reason.signal?.type)) continue;
    add(reason.text, reason.confidenceLevel, lead.scoredAt);
  }

  // The audit and the CMS describe the website, so they go the same way as the
  // website signals above when the offering is not the website.
  const audit = forProduct ? null : c.audits[0];
  if (audit) {
    add(`Its website scores ${audit.overallScore}/100 on a technical audit.`, "DETECTED", audit.auditedAt);
    for (const f of (audit.findings || []).filter((x) => ["CRITICAL", "HIGH"].includes(x.severity)).slice(0, 3)) {
      add(f.detail, "DETECTED", audit.auditedAt);
    }
  }
  const cms = forProduct ? null : c.tech.find((t) => t.category === "CMS" || t.category === "SITE_BUILDER");
  if (cms) add(`Its site is built on ${cms.techName}${cms.version ? ` ${cms.version}` : ""}.`, cms.confidence, cms.detectedAt);
  for (const job of c.jobPostings) add(`It is currently hiring: ${job.title}.`, "VERIFIED", job.lastSeenActiveAt);

  const email = c.contacts.find((x) => x.kind === "EMAIL" && x.roleHint !== "NON_OUTREACH");

  // A greeting that uses the reader's own name is one of the cheapest reply-rate
  // gains available, but only when the name is real. It is used solely when the
  // business published the person on its own site AND the address we hold is
  // theirs — addressing "Ahmed" on a shared info@ inbox that three people read
  // is worse than no name at all.
  const person = c.people?.[0] || null;
  // A name only earns a greeting if something corroborates that it is a person:
  // a job title, a seniority the classifier actually recognised, or an address
  // built from the name. The extractor is a heuristic over other people's
  // markup, and when it was looser a school's fee table produced a "person"
  // called Affordable Fee — which the composer then greeted by name. A second
  // check here costs a first name on some real leads and is worth it, because
  // the failure it prevents goes out in writing to a stranger.
  // `Boolean(person.title)` was the whole check, and a menu item's price is a
  // title too: production held "PROSCIUTTO FUNGHI, £15.5" and "Zen Sesshin,
  // 29. August" as people, and the composer greeted them by first name. The
  // name must have the shape of a name, and the title must name a role.
  const corroborated = person && isGreetableName(person.fullName) && (
    looksLikeJobTitle(person.title)
    || !["OTHER", "UNKNOWN"].includes(person.seniority)
    || (person.email && emailMatchesName(person.email, person.fullName))
  );
  const addressable = person && corroborated && email && (
    person.email?.toLowerCase() === email.value.toLowerCase()
    || (email.roleHint !== "ROLE" && !/^(info|contact|hello|sales|admin|office)@/i.test(email.value))
  );

  const recipientHint = addressable
    ? `${person.fullName}${person.title ? `, ${person.title}` : ""} — published on the company's own site. Open with their first name only.`
    : email?.roleHint === "ROLE" || /^(info|contact|hello|sales)@/.test(email?.value || "")
    ? "role account — do not address a named person"
    : email ? "published business address — do not assume a name"
    : "no email known — write for a contact form or phone follow-up";

  // The structured form of the same decision. `recipientHint` is prose for the
  // model; the template needs a name it can actually greet, and only when the
  // business published that person itself and the address reaches them.
  const recipient = addressable
    ? { fullName: person.fullName, firstName: firstNameOf(person.fullName), title: person.title || null }
    : null;

  return { lead, company: c, facts, recipientHint, recipient };
};

/** Contact-like strings the model must not invent into a body. */
const CONTACT_PATTERN = /[\w.+-]+@[\w.-]+\.\w{2,}|https?:\/\/\S+|\+?\d[\d\s().-]{7,}\d/g;

/**
 * Reject a draft that mentions a phone, email or URL not present in the facts.
 * A wrong number in an outreach email is worse than no email at all.
 */
export const bodyIsGrounded = (body, facts) => {
  const allowed = facts.map((f) => f.text).join(" ");
  const normalise = (s) => s.replace(/[^\w@.]/g, "").toLowerCase();
  for (const match of body.match(CONTACT_PATTERN) || []) {
    if (!normalise(allowed).includes(normalise(match))) return { ok: false, offending: match };
  }
  return { ok: true, offending: null };
};

export const composeEmailForLead = async ({ leadId, runId = null, tracker = null, serviceOverride = null, product = undefined }) => {
  // A promoter lead goes down the product path — same prompt trio, same
  // fallback template, same product stamp as the batch that wrote its first
  // draft — rather than the website-services one below. `product` may be
  // passed explicitly (or as null to force the services pitch); undefined
  // means "look it up".
  const resolvedProduct = product === undefined ? await promotedProductForLead(leadId) : product;
  if (resolvedProduct) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { discoveryRunId: true } });
    if (!lead) return null;
    await composeForRun({ runId: runId ?? lead.discoveryRunId, leadIds: [leadId], tracker, product: resolvedProduct });
    // Scoped to the product, not "newest of any": if the compose above wrote
    // nothing (fact gathering threw, say), an unscoped read would hand the
    // caller a leftover agency draft and report it as the product pitch it
    // just asked for. Returning null instead lets the caller skip the send.
    return prisma.leadEmailDraft.findFirst({
      where: { leadId, promotedProductId: resolvedProduct.id },
      orderBy: { createdAt: "desc" },
    });
  }

  const gathered = await gatherFacts(leadId);
  if (!gathered) return null;
  // `recipient` is used by the template fallback below; leaving it out of this
  // destructuring threw a ReferenceError on every lead whose AI draft failed.
  const { lead, company, facts, recipientHint, recipient } = gathered;
  // The searcher's own offering wins over the lead's dominant signal: a run
  // started to sell HR software must pitch HR software, even to a company
  // whose larger signal happens to be tech hiring.
  const serviceLabel = SERVICE_LABELS[serviceOverride || lead.primaryOpportunity] || "software development";

  if (isResearchAvailable()) {
    const result = await parseStructured({
      system: COMPOSE_SYSTEM,
      user: buildComposeUser({
        companyName: company.name, serviceLabel, recipientHint, facts,
        city: company.city, countryCode: company.countryCode, industry: company.industry,
      }),
      schema: COMPOSE_SCHEMA,
      schemaName: "outreach_email",
      model: AI_FAST_MODEL,
      timeoutMs: 40_000,
      tracker,
    });

    const draft = result?.data;
    if (draft?.body && draft?.subject) {
      const validIds = new Set(facts.map((f) => f.id));
      const usedOk = (draft.factIdsUsed || []).every((id) => validIds.has(id));
      const grounded = bodyIsGrounded(draft.body, facts);

      if (usedOk && grounded.ok) {
        return saveDraft({ leadId, runId, draft, facts, generatedBy: "LLM", model: result.model });
      }
      logger.warn(
        { company: company.name, reason: grounded.ok ? "cited a fact id that does not exist" : `invented "${grounded.offending}"` },
        "AI draft rejected — falling back to the template",
      );
    }
  }

  return saveDraft({
    leadId, runId,
    draft: templateDraft({ company, lead, facts, serviceLabel, serviceKey: serviceOverride || lead.primaryOpportunity, recipient }),
    facts, generatedBy: "RULE", model: null,
  });
};

/** Deterministic fallback — always available, never invents anything. */
const templateDraft = ({ company, lead, facts, serviceLabel, serviceKey, recipient = null }) =>
  initialTemplate({ company, facts, serviceKey: serviceKey || lead.primaryOpportunity, serviceLabel, recipient });

/**
 * The SaaS product a lead was found to be sold, if any.
 *
 * Which product a lead is for lives on the discovery run that produced it, not
 * on the lead. Every path that writes an email for one lead at a time — the
 * campaign drain composing on the fly, "write a new draft" on the lead page,
 * the suggestion shown when there is no draft — used to assume the offering
 * was website services, and a promoter lead got a pitch for a redesign of a
 * site it was never scored on. Resolving the product here, once, is what lets
 * all of them pitch the right thing.
 */
export const promotedProductForLead = async (leadId) => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { discoveryRun: { select: { promotedProduct: true } } },
  });
  return lead?.discoveryRun?.promotedProduct || null;
};

/** The product a run promotes, or null for an ordinary research run. */
const promotedProductForRun = async (runId) => {
  const run = await prisma.discoveryRun.findUnique({ where: { id: runId }, select: { promotedProduct: true } });
  return run?.promotedProduct || null;
};

/**
 * Split a set of leads by the product each one is for.
 *
 * The one-lead-at-a-time resolver above is the wrong tool for a book-wide pass:
 * it is a query per lead, and the caller still has to do the grouping. Returns
 * a Map keyed by product id with `null` for the agency leads, so a caller can
 * run one compose batch per offering.
 */
export const groupLeadsByProduct = async (leadIds) => {
  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    select: { id: true, discoveryRun: { select: { promotedProduct: true } } },
  });
  const groups = new Map();
  for (const lead of leads) {
    const product = lead.discoveryRun?.promotedProduct || null;
    const key = product?.id || null;
    if (!groups.has(key)) groups.set(key, { product, leadIds: [] });
    groups.get(key).leadIds.push(lead.id);
  }
  return groups;
};

const saveDraft = async ({ leadId, runId, draft, facts, generatedBy, model, promotedProductId = null }) =>
  prisma.leadEmailDraft.create({
    data: {
      leadId, runId, promotedProductId,
      subject: draft.subject.slice(0, 200),
      body: draft.body.slice(0, 4000),
      aboutCompany: (draft.aboutCompany || "").slice(0, 1000),
      groundingFacts: facts,
      factIdsUsed: draft.factIdsUsed || [],
      generatedBy,
      // A template draft is rule-derived from verified facts, not AI output —
      // labelling it AI_GENERATED overstated the uncertainty and confused the UI.
      confidenceLevel: generatedBy === "LLM" ? "AI_GENERATED" : "INFERRED",
      model,
      promptVersion: PROMPT_VERSION,
    },
  });

/** Validate one AI-drafted email against its lead's facts. */
const draftIsAcceptable = (draft, facts) => {
  if (!draft?.body || !draft?.subject) return false;
  const validIds = new Set(facts.map((f) => f.id));
  if (!(draft.factIdsUsed || []).every((id) => validIds.has(id))) return false;
  return bodyIsGrounded(draft.body, facts).ok;
};

/**
 * Compose for the strongest leads of a run.
 *
 * Token-optimised: leads are batched into a handful of AI calls (one shared
 * system prompt per chunk) instead of one call per lead. Any lead whose AI
 * draft is missing or fails grounding falls back to the deterministic
 * template, so every lead always ends the pass with an email.
 *
 * Passing `product` switches the offering to one named SaaS product: the prompt
 * trio and the fallback template change, and every draft is stamped with the
 * product it pitches. Nothing else moves — the same grounding guard rejects the
 * same inventions, whichever thing is being sold.
 */
export const composeForRun = async ({ runId, leadIds, tracker, serviceOverride = null, product = null }) => {
  // A caller that knows the run but not what it sells (the compose-batch
  // endpoint) still gets the product pitch for a promote run.
  if (!product && runId) product = await promotedProductForRun(runId);
  // A promote run gets its own ceiling. Its leads were all sourced against one
  // approved ICP, so the whole set is worth writing to, where a research run's
  // tail is speculative and deliberately cut short.
  const target = leadIds.slice(0, product ? PROMOTER_MAX_LEADS_PER_RUN : AI_COMPOSE_MAX_LEADS);
  let written = 0;
  let templated = 0;

  // Gather facts once per lead; drop leads that no longer exist.
  const gathered = [];
  for (const leadId of target) {
    try {
      const g = await gatherFacts(leadId, { forProduct: Boolean(product) });
      if (g) gathered.push({ leadId, ...g });
    } catch (err) {
      logger.debug({ leadId, msg: err.message }, "fact gathering failed");
    }
  }

  const pending = new Map(gathered.map((g) => [g.leadId, g]));

  if (isResearchAvailable() && gathered.length) {
    for (let i = 0; i < gathered.length; i += BATCH_SIZE) {
      if (!isResearchAvailable()) break; // breaker may have tripped mid-pass
      const chunk = gathered.slice(i, i + BATCH_SIZE);
      // The lead side of the payload is identical either way — only the
      // offering differs, so a promote batch swaps the prompt trio and nothing
      // about how the companies themselves are described.
      const leadPayload = chunk.map((g, idx) => ({
        index: idx + 1,
        companyName: g.company.name,
        recipientHint: g.recipientHint,
        facts: g.facts,
        city: g.company.city, countryCode: g.company.countryCode, industry: g.company.industry,
      }));
      const result = await parseStructured({
        system: product ? PROMOTE_COMPOSE_SYSTEM : BATCH_COMPOSE_SYSTEM,
        user: product
          ? buildPromoteComposeUser({ product, leads: leadPayload })
          : buildBatchComposeUser({
              leads: leadPayload.map((l, idx) => ({
                ...l,
                serviceLabel: SERVICE_LABELS[serviceOverride || chunk[idx].lead.primaryOpportunity] || "software development",
              })),
            }),
        schema: product ? PROMOTE_COMPOSE_SCHEMA : BATCH_COMPOSE_SCHEMA,
        schemaName: product ? "promoted_outreach_email_batch" : "outreach_email_batch",
        model: AI_FAST_MODEL,
        timeoutMs: 120_000,
        tracker,
      });

      for (const draft of result?.data?.emails || []) {
        const g = chunk[draft.leadIndex - 1];
        if (!g || !pending.has(g.leadId)) continue;
        // The grounding guard is not relaxed for a promote draft: a model that
        // invents a phone number while pitching a product has done exactly the
        // damage this check exists to stop.
        if (!draftIsAcceptable(draft, g.facts)) continue;
        await saveDraft({ leadId: g.leadId, runId, draft, facts: g.facts, generatedBy: "LLM", model: result.model, promotedProductId: product?.id || null });
        pending.delete(g.leadId);
        written += 1;
      }
    }
  }

  // Whatever the AI did not cover gets the deterministic template.
  for (const g of pending.values()) {
    try {
      const serviceKey = serviceOverride || g.lead.primaryOpportunity;
      // A promote lead falls back to the product's own copy, never to the
      // agency service copy — a run started to sell an HR platform must not
      // quietly send a website-development pitch when the model is down.
      const draft = product
        ? productInitialTemplate({ company: g.company, facts: g.facts, product, recipient: g.recipient })
        : templateDraft({
            company: g.company, lead: g.lead, facts: g.facts,
            serviceLabel: SERVICE_LABELS[serviceKey] || "software development",
            serviceKey, recipient: g.recipient,
          });
      await saveDraft({ leadId: g.leadId, runId, draft, facts: g.facts, generatedBy: "RULE", model: null, promotedProductId: product?.id || null });
      written += 1;
      templated += 1;
    } catch (err) {
      logger.debug({ leadId: g.leadId, msg: err.message }, "template composition failed");
    }
  }

  return { written, templated, aiWritten: written - templated };
};

const CONTACTABLE = { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT", "DISQUALIFIED"] } };

/**
 * The fact bundle for every contactable lead — what an external author (a
 * human, or an assistant session standing in for the AI API) needs to write
 * each lead its own email. Same facts, same grounding rules as the AI path.
 */
export const exportComposeContext = async () => {
  const leads = await prisma.lead.findMany({ where: CONTACTABLE, select: { id: true }, orderBy: { score: "desc" } });
  // One query for the whole book rather than one per lead; the export runs
  // over every contactable lead there is.
  const groups = await groupLeadsByProduct(leads.map((l) => l.id));
  const productByLead = new Map();
  for (const { product, leadIds } of groups.values()) {
    for (const leadId of leadIds) productByLead.set(leadId, product);
  }

  const out = [];
  for (const { id } of leads) {
    // A promoter lead is exported as the product sale it is: website
    // diagnostics stripped from its facts, and the product's own profile in
    // place of an agency service label. Without this the export described
    // every lead as a website-services prospect, the author wrote to that
    // brief, and the import then landed agency pitches on leads sourced to
    // sell a SaaS product — which is how a run's whole set lost its pitch.
    const product = productByLead.get(id) || null;
    const g = await gatherFacts(id, { forProduct: Boolean(product) });
    if (!g) continue;
    out.push({
      leadId: id,
      company: { name: g.company.name, city: g.company.city, countryCode: g.company.countryCode, industry: g.company.industry },
      ...(product
        ? {
            offering: "PRODUCT",
            product: {
              id: product.id,
              name: product.name,
              summary: product.summary,
              pitchAngle: product.pitchAngle,
              senderContext: product.senderContext,
              painPoints: product.icp?.painPoints || [],
            },
          }
        : {
            offering: "SERVICE",
            serviceLabel: SERVICE_LABELS[g.lead.primaryOpportunity] || "software development",
          }),
      recipientHint: g.recipientHint,
      facts: g.facts.map(({ id: fid, text, confidenceLevel }) => ({ id: fid, text, confidenceLevel })),
    });
  }
  return out;
};

/**
 * Accept externally-authored drafts. Every body is re-checked against the
 * lead's own facts with the same grounding guard the AI path uses — an
 * imported email that mentions a phone, address or URL the facts don't
 * contain is rejected, whoever wrote it.
 */
export const importDrafts = async ({ drafts, author = "external", forProduct = null }) => {
  const summary = { imported: 0, rejected: [] };
  for (const d of drafts) {
    // Which offering this lead is for decides both halves of the import: the
    // fact list the body is checked against, and the product the stored draft
    // is stamped with. Resolved per lead rather than taken from the caller's
    // flag, because an export covers the whole book and a single import file
    // routinely mixes promoter leads with agency ones — one flag for the batch
    // gets one of the two groups wrong every time. `forProduct` survives as an
    // explicit override (pass `true`/`false` to force it); null means resolve.
    const product = await promotedProductForLead(d.leadId);
    const narrowed = forProduct === null ? Boolean(product) : forProduct;
    const gathered = await gatherFacts(d.leadId, { forProduct: narrowed });
    if (!gathered) { summary.rejected.push({ leadId: d.leadId, reason: "lead not found" }); continue; }
    const grounded = bodyIsGrounded(d.body, gathered.facts);
    if (!grounded.ok) { summary.rejected.push({ leadId: d.leadId, reason: `invented "${grounded.offending}"` }); continue; }
    await saveDraft({
      leadId: d.leadId, runId: null,
      draft: { subject: d.subject, body: d.body, aboutCompany: d.aboutCompany || "", factIdsUsed: d.factIdsUsed || [] },
      facts: gathered.facts, generatedBy: "LLM", model: author,
      // Unstamped, an imported product email was indistinguishable from an
      // agency one, so the campaign sender could not tell which pitch it was
      // about to send — and the audit trail the column exists for was blank
      // on exactly the drafts a human wrote by hand.
      promotedProductId: product?.id || null,
    });
    summary.imported += 1;
  }
  return summary;
};

/**
 * Rewrite the outreach draft for every contactable lead.
 *
 * Used after the copy system improves: drafts are snapshots, so better
 * templates or prompts change nothing until the drafts are rebuilt. AI writes
 * where a provider is up (bounded by its own budget); everything else gets the
 * deterministic template. Old drafts stay as history — campaigns always pick
 * the newest.
 */
export const regenerateDrafts = async ({ budgetUsd = 2, keepAuthored = true } = {}) => {
  const all = await prisma.lead.findMany({
    where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT", "DISQUALIFIED"] } },
    select: { id: true, emailDrafts: { orderBy: { createdAt: "desc" }, take: 1, select: { generatedBy: true } } },
    orderBy: { score: "desc" },
  });
  // A draft written by a model or a person is worth more than the template
  // that would replace it. With no provider up, a regeneration used to put a
  // template on top of every AI-written draft in the table — the newest draft
  // wins, so the better email silently stopped being the one sent.
  const leads = keepAuthored && !isResearchAvailable()
    ? all.filter((l) => l.emailDrafts[0]?.generatedBy !== "LLM")
    : all;
  const tracker = new CostTracker(budgetUsd);
  let written = 0;
  let templated = 0;

  // Grouped by offering before anything is written. `composeForRun` can only
  // discover a product through a runId, and this pass has none to give it — so
  // every promoter lead in the book used to be rewritten as an agency lead,
  // stamped `promotedProductId: null`, and (being the newest draft) became the
  // email that actually went out. A run started to sell an HR platform had its
  // whole set quietly converted to website-redesign pitches by an unrelated
  // regeneration. The product is a property of the lead, so resolve it per
  // lead and give each group its own batch.
  const groups = await groupLeadsByProduct(leads.map((l) => l.id));

  for (const { product, leadIds } of groups.values()) {
    for (let i = 0; i < leadIds.length; i += AI_COMPOSE_MAX_LEADS) {
      const chunk = leadIds.slice(i, i + AI_COMPOSE_MAX_LEADS);
      const res = await composeForRun({ runId: null, leadIds: chunk, tracker, product });
      written += res.written;
      templated += res.templated;
    }
  }

  const summary = { leads: all.length, kept: all.length - leads.length, written, aiWritten: written - templated, templated, cost: tracker.toJSON() };
  logger.info(summary, "draft regeneration complete");
  return summary;
};
