import dotenv from "dotenv";

dotenv.config();

const int = (val, fallback) => {
  const n = Number.parseInt(val ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (val, fallback = false) => {
  if (val === undefined || val === null || val === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(val).toLowerCase());
};
const list = (val, fallback = []) =>
  (val ? String(val).split(",") : [])
    .map((v) => v.trim())
    .filter(Boolean)
    .concat(val ? [] : fallback);

// ─── Core ─────────────────────────────────────────────────────────────────────
export const NODE_ENV     = process.env.NODE_ENV || "development";
export const PORT               = int(process.env.PORT, 4100);
export const WORKER_HEALTH_PORT = int(process.env.WORKER_HEALTH_PORT, 4101);
export const DATABASE_URL = process.env.DATABASE_URL;
export const REDIS_URL    = process.env.REDIS_URL || "redis://127.0.0.1:6380";
export const APP_URL      = process.env.APP_URL || "http://localhost:4180";
export const ALLOWED_ORIGINS = list(
  process.env.ALLOWED_ORIGINS,
  ["http://localhost:4180", "http://127.0.0.1:4180"],
);

// ─── Discovery limits ─────────────────────────────────────────────────────────
// A live discovery run is triggered by a user typing a query, so it must be
// bounded in both breadth and wall-clock or the UI waits forever.
export const DISCOVERY_MAX_COMPANIES     = int(process.env.DISCOVERY_MAX_COMPANIES, 150);
export const DISCOVERY_MAX_CRAWL_HOSTS   = int(process.env.DISCOVERY_MAX_CRAWL_HOSTS, 60);
export const DISCOVERY_TIMEOUT_MS        = int(process.env.DISCOVERY_TIMEOUT_MS, 8 * 60 * 1000);
export const MIN_RESULTS_BEFORE_DISCOVER = int(process.env.MIN_RESULTS_BEFORE_DISCOVER, 5);
export const NOMINATIM_EMAIL             = process.env.NOMINATIM_EMAIL || "";
export const LOG_LEVEL = process.env.LOG_LEVEL || (NODE_ENV === "production" ? "info" : "debug");

// ─── Crawler identity & politeness ────────────────────────────────────────────
// A crawler that does not identify itself is indistinguishable from an attack.
// CRAWLER_USER_AGENT is sent on every outbound request and CRAWLER_CONTACT_URL
// gives site owners a way to reach us / opt out — both are required in prod.
export const CRAWLER_USER_AGENT = process.env.CRAWLER_USER_AGENT
  || "LeadSignalBot/1.0 (+https://leadsignal.local/bot; contact: bot@leadsignal.local)";
export const CRAWLER_CONTACT_URL     = process.env.CRAWLER_CONTACT_URL || "https://leadsignal.local/bot";
export const CRAWLER_DEFAULT_DELAY_MS = int(process.env.CRAWLER_DEFAULT_DELAY_MS, 1500);
export const CRAWLER_MAX_PAGES_PER_HOST = int(process.env.CRAWLER_MAX_PAGES_PER_HOST, 12);
export const CRAWLER_TIMEOUT_MS      = int(process.env.CRAWLER_TIMEOUT_MS, 15000);
export const CRAWLER_MAX_BYTES       = int(process.env.CRAWLER_MAX_BYTES, 3 * 1024 * 1024);
export const CRAWLER_MAX_REDIRECTS   = int(process.env.CRAWLER_MAX_REDIRECTS, 4);
export const CRAWLER_CONCURRENCY     = int(process.env.CRAWLER_CONCURRENCY, 6);
export const CRAWLER_RESPECT_ROBOTS  = bool(process.env.CRAWLER_RESPECT_ROBOTS, true);
// Escape hatch for local testing against a fixture server on 127.0.0.1. Never
// enable in production: it disables the SSRF private-address guard.
export const CRAWLER_ALLOW_PRIVATE_HOSTS = bool(process.env.CRAWLER_ALLOW_PRIVATE_HOSTS, false);

// ─── Optional AI layer ────────────────────────────────────────────────────────
// The product is fully functional with all of these unset — the AI layer only
// adds narrative polish on top of deterministic signals/scores.
export const AI_ENABLED        = bool(process.env.AI_ENABLED, false);
export const AI_PROVIDER       = process.env.AI_PROVIDER || "openai"; // openai | anthropic
export const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
export const OPENAI_BASE_URL   = process.env.OPENAI_BASE_URL;
export const OPENAI_MODEL      = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// ─── AI deep-research layer ───────────────────────────────────────────────────
// Two tiers: a stronger model does the live web search (where result quality
// depends on judgement about what a page really says), a cheap one does the
// briefing, extraction and email drafting.
export const AI_SEARCH_MODEL = process.env.AI_SEARCH_MODEL || "gpt-5.6-terra";
export const AI_FAST_MODEL   = process.env.AI_FAST_MODEL   || "gpt-5.6-luna";
// Hard ceiling per research run. The cost tracker refuses further calls once
// this is spent, so a bad prompt cannot quietly drain the account.
export const AI_RUN_BUDGET_USD        = Number(process.env.AI_RUN_BUDGET_USD || 0.75);
export const AI_MAX_SEARCH_CALLS      = int(process.env.AI_MAX_SEARCH_CALLS, 3);
export const AI_MAX_CANDIDATES        = int(process.env.AI_MAX_CANDIDATES, 36);
export const AI_MAX_CITATION_FETCHES  = int(process.env.AI_MAX_CITATION_FETCHES, 25);
export const AI_COMPOSE_MAX_LEADS     = int(process.env.AI_COMPOSE_MAX_LEADS, 15);
// A research run does strictly more work than a plain discovery (two search
// engines, verification fetches, email drafting), so it gets its own budget.
export const RESEARCH_TIMEOUT_MS      = int(process.env.RESEARCH_TIMEOUT_MS, 15 * 60 * 1000);

// ─── Third-party discovery sources (all optional) ─────────────────────────────
export const OVERPASS_URL   = process.env.OVERPASS_URL   || "https://overpass-api.de/api/interpreter";
export const NOMINATIM_URL  = process.env.NOMINATIM_URL  || "https://nominatim.openstreetmap.org";
// Adzuna was evaluated as a job source but is not implemented in v1 — it is the
// only candidate requiring registration, and the six unauthenticated ATS boards
// already cover hiring intelligence. See docs/DATA_SOURCES.md.

// ─── Boot-time guards ─────────────────────────────────────────────────────────
// Fail loudly at import time rather than three requests later with a confusing
// Prisma error or an anonymous crawler hammering a stranger's site.
if (!DATABASE_URL) {
  throw new Error("[envConfig] DATABASE_URL is required. Copy .env.example to .env.");
}

if (NODE_ENV === "production") {
  if (!process.env.CRAWLER_USER_AGENT || !CRAWLER_USER_AGENT.includes("+http")) {
    throw new Error(
      "[envConfig] CRAWLER_USER_AGENT must be set in production and include a +http(s) " +
      "contact URL so crawled sites can identify and reach us. Refusing to start.",
    );
  }
  if (CRAWLER_ALLOW_PRIVATE_HOSTS) {
    throw new Error(
      "[envConfig] CRAWLER_ALLOW_PRIVATE_HOSTS disables the SSRF guard and must never " +
      "be enabled in production. Refusing to start.",
    );
  }
  if (!CRAWLER_RESPECT_ROBOTS) {
    throw new Error("[envConfig] CRAWLER_RESPECT_ROBOTS cannot be disabled in production.");
  }
}

if (AI_ENABLED) {
  const key = AI_PROVIDER === "anthropic" ? ANTHROPIC_API_KEY : OPENAI_API_KEY;
  if (!key) {
    console.warn(
      `[envConfig] AI_ENABLED=true but no API key for provider "${AI_PROVIDER}". ` +
      "The AI layer will stay disabled; deterministic scoring is unaffected.",
    );
  }
}
