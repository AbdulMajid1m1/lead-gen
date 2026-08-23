import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_ENABLED, OPENAI_API_KEY, OPENAI_BASE_URL,
  ANTHROPIC_API_KEY, ANTHROPIC_MODEL,
  AI_SEARCH_MODEL, AI_FAST_MODEL, AI_RUN_BUDGET_USD,
} from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("llm:responses");

/**
 * Circuit breaker. A provider that answers "no credits" or "bad key" will keep
 * answering that for every lead in a run — retrying per lead burns time and
 * fills the logs. One hard failure puts the provider on cooldown; transient
 * errors (timeouts, 5xx) do not trip it.
 */
const COOLDOWN_MS = 10 * 60 * 1000;
const breaker = { openai: { until: 0, reason: null }, anthropic: { until: 0, reason: null } };

const isHardFailure = (err) => {
  const msg = String(err?.message || "");
  if (err?.status === 401 || err?.status === 403) return true;
  return /no credits|insufficient_quota|credit balance|billing|exceeded your current quota|invalid.{0,10}api key/i.test(msg);
};

const tripBreaker = (provider, err) => {
  breaker[provider] = { until: Date.now() + COOLDOWN_MS, reason: String(err?.message || "").slice(0, 200) };
  logger.error({ provider, reason: breaker[provider].reason },
    "AI provider hard failure — pausing its calls for 10 minutes");
};

const providerUp = (provider) => Date.now() >= breaker[provider].until;

/**
 * OpenAI Responses API layer: live web search plus schema-guaranteed JSON.
 *
 * Two rules hold everywhere in this file:
 *  1. Every call is optional. If there is no key, no credit, or the API errors,
 *     the caller gets null and the deterministic pipeline carries on unchanged.
 *  2. Nothing returned from here is treated as fact. Web-search output is a set
 *     of *claims with citations*; the verification pipeline decides what is true.
 */

let client = null;
const getClient = () => {
  if (!AI_ENABLED || !OPENAI_API_KEY || !providerUp("openai")) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: OPENAI_API_KEY,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
      maxRetries: 1, // a research run is already long; fail fast and degrade
    });
  }
  return client;
};

let anthropicClient = null;
const getAnthropicClient = () => {
  if (!AI_ENABLED || !ANTHROPIC_API_KEY || !providerUp("anthropic")) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 1 });
  }
  return anthropicClient;
};

export const isResearchAvailable = () =>
  Boolean(AI_ENABLED && ((OPENAI_API_KEY && providerUp("openai")) || (ANTHROPIC_API_KEY && providerUp("anthropic"))));

/** Health-check view of the AI layer, including breaker state. */
export const aiStatus = () => ({
  enabled: AI_ENABLED,
  available: isResearchAvailable(),
  providers: {
    openai: OPENAI_API_KEY
      ? { configured: true, up: providerUp("openai"), pausedReason: providerUp("openai") ? null : breaker.openai.reason }
      : { configured: false },
    anthropic: ANTHROPIC_API_KEY
      ? { configured: true, up: providerUp("anthropic"), pausedReason: providerUp("anthropic") ? null : breaker.anthropic.reason }
      : { configured: false },
  },
});

/**
 * Published per-million token prices, used only to keep a run inside its
 * budget. Approximate by design — the authority is the invoice, this is a
 * governor so a runaway loop cannot spend real money.
 */
const PRICING = {
  "gpt-5.6-terra": { in: 2.0, out: 12.0 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-5.6-sol": { in: 5.0, out: 30.0 },
  "gpt-5-mini": { in: 0.25, out: 2.0 },
  "gpt-5": { in: 1.25, out: 10.0 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-sonnet-5": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  default: { in: 1.0, out: 5.0 },
};
const WEB_SEARCH_CALL_USD = 0.01; // $10 per 1,000 calls

export const estimateCost = ({ model, usage, searchCalls = 0 }) => {
  const price = PRICING[model] || PRICING.default;
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out + searchCalls * WEB_SEARCH_CALL_USD;
};

/**
 * Tracks spend across one research run and refuses further calls once the
 * budget is gone, so a bad prompt cannot quietly drain an account.
 */
export class CostTracker {
  constructor(budgetUsd = AI_RUN_BUDGET_USD) {
    this.budgetUsd = budgetUsd;
    this.spentUsd = 0;
    this.calls = 0;
    this.searchCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.lastError = null;
  }

  get remainingUsd() {
    return Math.max(0, this.budgetUsd - this.spentUsd);
  }

  canSpend(estimateUsd = 0.05) {
    return this.remainingUsd >= estimateUsd;
  }

  record({ model, usage, searchCalls = 0 }) {
    this.calls += 1;
    this.searchCalls += searchCalls;
    this.inputTokens += usage?.input_tokens ?? 0;
    this.outputTokens += usage?.output_tokens ?? 0;
    this.spentUsd += estimateCost({ model, usage, searchCalls });
  }

  toJSON() {
    return {
      calls: this.calls,
      searchCalls: this.searchCalls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      estCostUsd: Number(this.spentUsd.toFixed(4)),
      budgetUsd: this.budgetUsd,
      lastError: this.lastError,
    };
  }
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);

/** Pull the model's JSON out of a Responses result, tolerating prose wrappers. */
const extractJson = (response) => {
  if (response.output_parsed) return response.output_parsed;
  const text = response.output_text || "";
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

/**
 * Every URL the search actually retrieved.
 *
 * This is the whitelist the citation guard checks claimed sources against — a
 * model that writes a plausible URL it never visited gets caught here.
 */
const extractSources = (response) => {
  const urls = new Set();
  for (const item of response.output || []) {
    for (const source of item.sources || item.action?.sources || []) {
      if (source?.url) urls.add(source.url);
    }
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation?.url) urls.add(annotation.url);
      }
    }
  }
  return [...urls];
};

/** Anthropic structured-output call, used when OpenAI is missing or paused. */
const parseStructuredAnthropic = async ({ system, user, schema, schemaName, timeoutMs, tracker }) => {
  const c = getAnthropicClient();
  if (!c) return null;
  const model = ANTHROPIC_MODEL;
  try {
    const response = await withTimeout(
      c.messages.create({
        model,
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      }),
      timeoutMs,
      `${schemaName} call (anthropic)`,
    );
    tracker?.record({ model, usage: response.usage });
    if (response.stop_reason === "refusal") return null;
    const text = response.content?.find((b) => b.type === "text")?.text || "";
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return data ? { data, usage: response.usage, model } : null;
  } catch (err) {
    if (isHardFailure(err)) tripBreaker("anthropic", err);
    if (tracker) tracker.lastError = String(err.message).slice(0, 200);
    logger.warn({ schemaName, model, msg: err.message }, "anthropic structured call failed — degrading");
    return null;
  }
};

/**
 * Structured JSON, no tools. Used for the brief, page extraction and email
 * composition — anything that must reason over text we already hold.
 * Tries OpenAI first, then Anthropic; either provider on cooldown is skipped.
 */
export const parseStructured = async ({
  system, user, schema, schemaName = "result",
  model = AI_FAST_MODEL, timeoutMs = 45_000, tracker = null,
}) => {
  if (tracker && !tracker.canSpend(0.01)) {
    logger.warn({ schemaName }, "skipping call — run budget exhausted");
    return null;
  }

  const c = getClient();
  if (c) {
    try {
      const response = await withTimeout(
        c.responses.create({
          model,
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        }),
        timeoutMs,
        `${schemaName} call`,
      );
      tracker?.record({ model, usage: response.usage });
      return { data: extractJson(response), usage: response.usage, model };
    } catch (err) {
      if (isHardFailure(err)) tripBreaker("openai", err);
      if (tracker) tracker.lastError = String(err.message).slice(0, 200);
      logger.warn({ schemaName, model, msg: err.message }, "structured call failed — trying fallback provider");
    }
  }

  return parseStructuredAnthropic({ system, user, schema, schemaName, timeoutMs, tracker });
};

/**
 * Live web search returning schema-shaped results with the sources the model
 * actually retrieved.
 *
 * `user_location` materially improves regional results — a Saudi query without
 * it returns mostly US pages.
 */
export const searchAndParse = async ({
  system, user, schema, schemaName = "discovery",
  model = AI_SEARCH_MODEL, searchContextSize = "medium",
  country = null, city = null, timeoutMs = 90_000, tracker = null,
}) => {
  const c = getClient();
  if (!c) return null;
  if (tracker && !tracker.canSpend(0.06)) {
    logger.warn({ schemaName }, "skipping web search — run budget exhausted");
    return null;
  }

  const tool = { type: "web_search", search_context_size: searchContextSize };
  if (country) {
    tool.user_location = { type: "approximate", country, ...(city ? { city } : {}) };
  }

  try {
    const response = await withTimeout(
      c.responses.create({
        model,
        tools: [tool],
        input: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      }),
      timeoutMs,
      "web search",
    );

    const searchCalls = (response.output || []).filter((o) => o.type === "web_search_call").length;
    tracker?.record({ model, usage: response.usage, searchCalls: Math.max(1, searchCalls) });

    return {
      data: extractJson(response),
      sources: extractSources(response),
      searchCalls,
      usage: response.usage,
      model,
    };
  } catch (err) {
    if (isHardFailure(err)) tripBreaker("openai", err);
    if (tracker) tracker.lastError = String(err.message).slice(0, 200);
    logger.warn({ schemaName, model, msg: err.message }, "web search failed — degrading to deterministic sources");
    return null;
  }
};

/**
 * A claimed source URL only counts if the search actually retrieved that page.
 * Host-level comparison, because models routinely cite a deep link when the
 * search returned the section index on the same site.
 */
export const citationsAreGrounded = (claimedUrls = [], retrievedUrls = []) => {
  if (!claimedUrls.length) return false;
  if (!retrievedUrls.length) return false;
  const hostOf = (u) => {
    try {
      return new URL(u).host.replace(/^www\./, "").toLowerCase();
    } catch {
      return null;
    }
  };
  const retrievedHosts = new Set(retrievedUrls.map(hostOf).filter(Boolean));
  return claimedUrls.some((u) => {
    const host = hostOf(u);
    return host && retrievedHosts.has(host);
  });
};
