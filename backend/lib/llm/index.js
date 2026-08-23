import { AI_ENABLED, AI_PROVIDER, OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("llm");

/**
 * Optional LLM layer.
 *
 * Every caller must work when this returns null. The system's crawling,
 * extraction, scoring and provenance are entirely deterministic; the LLM is
 * only ever allowed to (a) reinterpret an ambiguous search phrase into the same
 * structured shape the deterministic parser produces, and (b) reword outreach
 * copy from talking points that were already verified. It never sees raw pages,
 * never invents facts, and never touches a score.
 */

let client = null;
let clientKind = null;

const getClient = async () => {
  if (!AI_ENABLED) return null;
  if (client) return client;

  try {
    if (AI_PROVIDER === "anthropic") {
      if (!ANTHROPIC_API_KEY) return null;
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
      clientKind = "anthropic";
    } else {
      if (!OPENAI_API_KEY) return null;
      const { default: OpenAI } = await import("openai");
      client = new OpenAI({ apiKey: OPENAI_API_KEY, ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}) });
      clientKind = "openai";
    }
    return client;
  } catch (err) {
    logger.warn({ msg: err.message }, "LLM client unavailable — continuing without the AI layer");
    return null;
  }
};

export const isLlmAvailable = () =>
  AI_ENABLED && Boolean(AI_PROVIDER === "anthropic" ? ANTHROPIC_API_KEY : OPENAI_API_KEY);

/**
 * Ask for a JSON object. Returns null on any failure — timeout, bad key, or
 * unparseable output — so callers degrade rather than break.
 *
 * @param {{system:string, user:string, timeoutMs?:number, maxTokens?:number}} opts
 */
export const completeJson = async ({ system, user, timeoutMs = 6000, maxTokens = 700 }) => {
  const c = await getClient();
  if (!c) return null;

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));

  const call = (async () => {
    try {
      if (clientKind === "anthropic") {
        const res = await c.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        });
        return res.content?.map((b) => b.text || "").join("") || null;
      }
      const res = await c.chat.completions.create({
        model: OPENAI_MODEL,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      return res.choices?.[0]?.message?.content || null;
    } catch (err) {
      logger.warn({ msg: err.message }, "LLM call failed — falling back to deterministic behaviour");
      return null;
    }
  })();

  const raw = await Promise.race([call, timeout]);
  if (!raw) return null;

  try {
    // Models sometimes wrap JSON in prose or a code fence.
    const match = raw.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : raw);
  } catch {
    logger.warn("LLM returned unparseable JSON — ignoring");
    return null;
  }
};
