import { z } from "zod";
import { completeJson, isLlmAvailable } from "../llm/index.js";
import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { SIGNAL_CATALOG } from "../signals/signalCatalog.js";
import { industryLabel } from "./lexicon.js";
import { log } from "../../utils/logger.js";

const logger = log("llmParser");

/**
 * Optional LLM assist for search phrasing the lexicon did not recognise.
 *
 * The model is constrained to *pick from* the same closed vocabularies the
 * deterministic parser uses — it cannot invent a signal type or an industry.
 * Anything it returns that fails validation is discarded and the deterministic
 * parse stands, so enabling the AI layer can add coverage but never break it.
 */

const INDUSTRY_KEYS = Object.keys(OSM_CATEGORIES);
const SIGNAL_KEYS = Object.keys(SIGNAL_CATALOG);
const SERVICES = ["WEBSITE_DEV", "CRM_DEV", "MOBILE_APP", "AI_AUTOMATION", "ECOMMERCE_DEV", "SAAS_DEV", "CUSTOM_SOFTWARE", "HR_SOFTWARE"];

const responseSchema = z.object({
  industries: z.array(z.enum(INDUSTRY_KEYS)).max(3).default([]),
  location: z.string().max(80).nullable().optional(),
  signals: z.array(z.enum(SIGNAL_KEYS)).max(8).default([]),
  technologies: z.array(z.string().max(40)).max(5).default([]),
  service: z.enum(SERVICES).nullable().optional(),
  jobTitleContains: z.array(z.string().max(40)).max(6).default([]),
  postedWithinDays: z.number().int().min(1).max(365).nullable().optional(),
});

const SYSTEM = `You convert a sales prospecting request into a structured filter.
Reply with JSON only. Choose values ONLY from the allowed lists you are given.
If something is not clearly stated in the request, omit it — never guess a location
or an industry that the user did not mention. Do not invent new enum values.`;

export const parseWithLlm = async (rawText, deterministic) => {
  if (!isLlmAvailable()) return null;

  const user = [
    `Request: "${rawText}"`,
    "",
    `Allowed industries: ${INDUSTRY_KEYS.join(", ")}`,
    `Allowed signals: ${SIGNAL_KEYS.join(", ")}`,
    `Allowed services: ${SERVICES.join(", ")}`,
    "",
    'Reply as: {"industries":[],"location":null,"signals":[],"technologies":[],"service":null,"jobTitleContains":[],"postedWithinDays":null}',
  ].join("\n");

  const json = await completeJson({ system: SYSTEM, user, timeoutMs: 6000 });
  if (!json) return null;

  const result = responseSchema.safeParse(json);
  if (!result.success) {
    logger.warn({ issues: result.error.issues.length }, "LLM parse failed validation — keeping deterministic result");
    return null;
  }
  const v = result.data;

  // Merge rather than replace: the deterministic parser is authoritative for
  // everything it *did* recognise, and the model only fills the gaps.
  const merged = {
    ...deterministic.query,
    industries: deterministic.query.industries.length ? deterministic.query.industries : v.industries,
    signals: [...new Set([...deterministic.query.signals, ...v.signals])],
    technologies: deterministic.query.technologies.length ? deterministic.query.technologies : v.technologies,
    service: deterministic.query.service || v.service || null,
    jobTitleContains: deterministic.query.jobTitleContains.length ? deterministic.query.jobTitleContains : v.jobTitleContains,
    postedWithinDays: deterministic.query.postedWithinDays || v.postedWithinDays || null,
    location: deterministic.query.location || (v.location ? { name: v.location, raw: v.location.toLowerCase() } : null),
  };

  const chips = [...deterministic.chips];
  const has = (kind, value) => chips.some((c) => c.kind === kind && c.value === value);
  for (const key of merged.industries) {
    if (!has("INDUSTRY", key)) chips.push({ kind: "INDUSTRY", label: industryLabel(key), value: key, viaAi: true });
  }
  if (merged.location && !chips.some((c) => c.kind === "LOCATION")) {
    chips.push({ kind: "LOCATION", label: merged.location.name, value: merged.location.raw, viaAi: true });
  }
  for (const s of v.signals) {
    if (!deterministic.query.signals.includes(s)) {
      chips.push({ kind: "SIGNAL", label: SIGNAL_CATALOG[s]?.label || s, value: [s], viaAi: true });
    }
  }

  return {
    query: merged,
    chips,
    parserUsed: "LLM",
    confidence: Math.max(deterministic.confidence, 0.6),
    unparsed: deterministic.unparsed,
  };
};
