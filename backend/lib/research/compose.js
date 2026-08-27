import prisma from "../../prismaClient.js";
import { parseStructured, isResearchAvailable, CostTracker } from "../llm/responses.js";
import {
  COMPOSE_SYSTEM, buildComposeUser, COMPOSE_SCHEMA,
  BATCH_COMPOSE_SYSTEM, buildBatchComposeUser, BATCH_COMPOSE_SCHEMA,
  PROMPT_VERSION,
} from "./prompts.js";
import { initialTemplate } from "./templates.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { AI_FAST_MODEL, AI_COMPOSE_MAX_LEADS } from "../../configs/envConfig.js";
import { relativeAge } from "../scoring/decay.js";
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

/** Assemble the facts a lead is allowed to be described by. */
export const gatherFacts = async (leadId) => {
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
      reasons: { orderBy: { rank: "asc" } },
    },
  });
  if (!lead) return null;

  const c = lead.company;
  const facts = [];
  const add = (text, confidenceLevel, observedAt) =>
    facts.push({ id: facts.length + 1, text, confidenceLevel, observedAt: observedAt ? relativeAge(observedAt) : null });

  add(`${c.name} is a ${c.industry || "business"}${c.city ? ` in ${c.city}` : ""}.`, "VERIFIED", c.firstSeenAt);
  if (c.domains[0]) add(`Its website is ${c.domains[0].domain}.`, "VERIFIED", c.lastCrawledAt);
  if (c.locations[0]?.addressLine) add(`Its address is ${c.locations[0].addressLine}.`, "VERIFIED", null);

  for (const reason of lead.reasons) add(reason.text, reason.confidenceLevel, lead.scoredAt);

  const audit = c.audits[0];
  if (audit) {
    add(`Its website scores ${audit.overallScore}/100 on a technical audit.`, "DETECTED", audit.auditedAt);
    for (const f of (audit.findings || []).filter((x) => ["CRITICAL", "HIGH"].includes(x.severity)).slice(0, 3)) {
      add(f.detail, "DETECTED", audit.auditedAt);
    }
  }
  const cms = c.tech.find((t) => t.category === "CMS" || t.category === "SITE_BUILDER");
  if (cms) add(`Its site is built on ${cms.techName}${cms.version ? ` ${cms.version}` : ""}.`, cms.confidence, cms.detectedAt);
  for (const job of c.jobPostings) add(`It is currently hiring: ${job.title}.`, "VERIFIED", job.lastSeenActiveAt);

  const email = c.contacts.find((x) => x.kind === "EMAIL" && x.roleHint !== "NON_OUTREACH");

  // A greeting that uses the reader's own name is one of the cheapest reply-rate
  // gains available, but only when the name is real. It is used solely when the
  // business published the person on its own site AND the address we hold is
  // theirs — addressing "Ahmed" on a shared info@ inbox that three people read
  // is worse than no name at all.
  const person = c.people?.[0] || null;
  const addressable = person && email && (
    person.email?.toLowerCase() === email.value.toLowerCase()
    || (email.roleHint !== "ROLE" && !/^(info|contact|hello|sales|admin|office)@/i.test(email.value))
  );

  const recipientHint = addressable
    ? `${person.fullName}${person.title ? `, ${person.title}` : ""} — published on the company's own site. Open with their first name only.`
    : email?.roleHint === "ROLE" || /^(info|contact|hello|sales)@/.test(email?.value || "")
    ? "role account — do not address a named person"
    : email ? "published business address — do not assume a name"
    : "no email known — write for a contact form or phone follow-up";

  return { lead, company: c, facts, recipientHint };
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

export const composeEmailForLead = async ({ leadId, runId = null, tracker = null, serviceOverride = null }) => {
  const gathered = await gatherFacts(leadId);
  if (!gathered) return null;
  const { lead, company, facts, recipientHint } = gathered;
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
    draft: templateDraft({ company, lead, facts, serviceLabel, serviceKey: serviceOverride || lead.primaryOpportunity }),
    facts, generatedBy: "RULE", model: null,
  });
};

/** Deterministic fallback — always available, never invents anything. */
const templateDraft = ({ company, lead, facts, serviceLabel, serviceKey }) =>
  initialTemplate({ company, facts, serviceKey: serviceKey || lead.primaryOpportunity, serviceLabel });

const saveDraft = async ({ leadId, runId, draft, facts, generatedBy, model }) =>
  prisma.leadEmailDraft.create({
    data: {
      leadId, runId,
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
 */
export const composeForRun = async ({ runId, leadIds, tracker, serviceOverride = null }) => {
  const target = leadIds.slice(0, AI_COMPOSE_MAX_LEADS);
  let written = 0;
  let templated = 0;

  // Gather facts once per lead; drop leads that no longer exist.
  const gathered = [];
  for (const leadId of target) {
    try {
      const g = await gatherFacts(leadId);
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
      const result = await parseStructured({
        system: BATCH_COMPOSE_SYSTEM,
        user: buildBatchComposeUser({
          leads: chunk.map((g, idx) => ({
            index: idx + 1,
            companyName: g.company.name,
            serviceLabel: SERVICE_LABELS[serviceOverride || g.lead.primaryOpportunity] || "software development",
            recipientHint: g.recipientHint,
            facts: g.facts,
            city: g.company.city, countryCode: g.company.countryCode, industry: g.company.industry,
          })),
        }),
        schema: BATCH_COMPOSE_SCHEMA,
        schemaName: "outreach_email_batch",
        model: AI_FAST_MODEL,
        timeoutMs: 120_000,
        tracker,
      });

      for (const draft of result?.data?.emails || []) {
        const g = chunk[draft.leadIndex - 1];
        if (!g || !pending.has(g.leadId)) continue;
        if (!draftIsAcceptable(draft, g.facts)) continue;
        await saveDraft({ leadId: g.leadId, runId, draft, facts: g.facts, generatedBy: "LLM", model: result.model });
        pending.delete(g.leadId);
        written += 1;
      }
    }
  }

  // Whatever the AI did not cover gets the deterministic template.
  for (const g of pending.values()) {
    try {
      const serviceKey = serviceOverride || g.lead.primaryOpportunity;
      const draft = templateDraft({
        company: g.company, lead: g.lead, facts: g.facts,
        serviceLabel: SERVICE_LABELS[serviceKey] || "software development",
        serviceKey,
      });
      await saveDraft({ leadId: g.leadId, runId, draft, facts: g.facts, generatedBy: "RULE", model: null });
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
  const out = [];
  for (const { id } of leads) {
    const g = await gatherFacts(id);
    if (!g) continue;
    out.push({
      leadId: id,
      company: { name: g.company.name, city: g.company.city, countryCode: g.company.countryCode, industry: g.company.industry },
      serviceLabel: SERVICE_LABELS[g.lead.primaryOpportunity] || "software development",
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
export const importDrafts = async ({ drafts, author = "external" }) => {
  const summary = { imported: 0, rejected: [] };
  for (const d of drafts) {
    const gathered = await gatherFacts(d.leadId);
    if (!gathered) { summary.rejected.push({ leadId: d.leadId, reason: "lead not found" }); continue; }
    const grounded = bodyIsGrounded(d.body, gathered.facts);
    if (!grounded.ok) { summary.rejected.push({ leadId: d.leadId, reason: `invented "${grounded.offending}"` }); continue; }
    await saveDraft({
      leadId: d.leadId, runId: null,
      draft: { subject: d.subject, body: d.body, aboutCompany: d.aboutCompany || "", factIdsUsed: d.factIdsUsed || [] },
      facts: gathered.facts, generatedBy: "LLM", model: author,
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
export const regenerateDrafts = async ({ budgetUsd = 2 } = {}) => {
  const leads = await prisma.lead.findMany({
    where: { status: { notIn: ["ARCHIVED", "DO_NOT_CONTACT", "DISQUALIFIED"] } },
    select: { id: true },
    orderBy: { score: "desc" },
  });
  const tracker = new CostTracker(budgetUsd);
  let written = 0;
  let templated = 0;

  for (let i = 0; i < leads.length; i += AI_COMPOSE_MAX_LEADS) {
    const chunk = leads.slice(i, i + AI_COMPOSE_MAX_LEADS).map((l) => l.id);
    const res = await composeForRun({ runId: null, leadIds: chunk, tracker });
    written += res.written;
    templated += res.templated;
  }

  const summary = { leads: leads.length, written, aiWritten: written - templated, templated, cost: tracker.toJSON() };
  logger.info(summary, "draft regeneration complete");
  return summary;
};
