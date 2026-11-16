import { describe, it, expect, vi, beforeEach } from "vitest";

// No OpenAI key: every web search in these tests has to run on Claude.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { constructor() { this.messages = { create }; } } }));
vi.mock("openai", () => ({ default: class {} }));
vi.mock("../../configs/envConfig.js", async (importOriginal) => ({
  ...(await importOriginal()),
  AI_ENABLED: true,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_SEARCH_MODEL: "claude-sonnet-5",
  anthropicClientOptions: (extra = {}) => ({ apiKey: "test-key", ...extra }),
  AI_SEARCH_MODEL: "gpt-5.6-terra",
  AI_FAST_MODEL: "gpt-5.6-luna",
  AI_RUN_BUDGET_USD: 0.75,
}));

const { searchAndParse, estimateCost, CostTracker, claudeSchema, capArrays } = await import("../../lib/llm/responses.js");

// Shaped like the real discovery schema, maxItems included.
const SCHEMA = {
  type: "object",
  properties: { companies: { type: "array", maxItems: 2, items: { type: "object", properties: { name: { type: "string", maxLength: 120 } }, required: ["name"], additionalProperties: false } } },
  required: ["companies"],
  additionalProperties: false,
};

const searchTurn = ({ urls = [], text = "Notes.", stop = "end_turn", error = false } = {}) => ({
  stop_reason: stop,
  usage: { input_tokens: 1000, output_tokens: 200, server_tool_use: { web_search_requests: 1 } },
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", content: error ? { type: "web_search_tool_result_error", error_code: "unavailable" } : urls.map((url) => ({ type: "web_search_result", url, title: "t" })) },
    { type: "text", text, citations: [] },
  ],
});
const shapeTurn = (data) => ({ stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 100 }, content: [{ type: "text", text: JSON.stringify(data) }] });

const run = (over = {}) => searchAndParse({ system: "Find clinics.", user: "Dental clinics in Riyadh.", schema: SCHEMA, schemaName: "company_discovery", country: "SA", city: "Riyadh", ...over });

beforeEach(() => create.mockReset());

describe("searchAndParse on Claude", () => {
  it("searches with Claude's basic web search tool, then shapes the notes into the schema", async () => {
    create
      .mockResolvedValueOnce(searchTurn({ urls: ["https://a.example/clinic", "https://b.example/"], text: "Alpha Dental, a.example." }))
      .mockResolvedValueOnce(shapeTurn({ companies: [{ name: "Alpha Dental" }, { name: "Beta Dental" }, { name: "Gamma Dental" }] }));

    const result = await run();

    // Claude never sees maxItems (it would 400), but the answer is still held to it.
    expect(result.data).toEqual({ companies: [{ name: "Alpha Dental" }, { name: "Beta Dental" }] });
    expect(result.sources).toEqual(["https://a.example/clinic", "https://b.example/"]);
    expect(result.searchCalls).toBe(1);
    const [search, shape] = create.mock.calls.map(([body]) => body);
    expect(search.tools[0]).toMatchObject({ type: "web_search_20250305", name: "web_search", user_location: { country: "SA", city: "Riyadh" } });
    expect(search.output_config).toEqual({ effort: "medium" });
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(shape.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(shape.output_config.format.schema)).not.toMatch(/maxItems|maxLength/);
    expect(shape.messages[0].content).toContain("https://a.example/clinic");
  });

  it("retries without a location when the search tool rejects the country", async () => {
    create
      .mockRejectedValueOnce(Object.assign(new Error("tools.0.web_search_20260209: Country code PK is not supported."), { status: 400 }))
      .mockResolvedValueOnce(searchTurn({ urls: ["https://pk.example/"] }))
      .mockResolvedValueOnce(shapeTurn({ companies: [] }));

    const result = await run({ country: "PK", city: "Lahore" });

    expect(result.sources).toEqual(["https://pk.example/"]);
    expect(create.mock.calls[1][0].tools[0].user_location).toBeUndefined();
  });

  it("resumes a paused search turn instead of starting again", async () => {
    create
      .mockResolvedValueOnce(searchTurn({ urls: ["https://first.example/"], stop: "pause_turn", text: "" }))
      .mockResolvedValueOnce(searchTurn({ urls: ["https://second.example/"], text: "Two clinics." }))
      .mockResolvedValueOnce(shapeTurn({ companies: [] }));

    const result = await run();

    const resumed = create.mock.calls[1][0].messages;
    expect(resumed).toHaveLength(2);
    expect(resumed[1].role).toBe("assistant");
    expect(result.sources).toEqual(["https://first.example/", "https://second.example/"]);
    expect(result.searchCalls).toBe(2);
  });

  it("returns null and says why when the search only produced errors", async () => {
    create.mockResolvedValueOnce(searchTurn({ error: true }));
    const tracker = new CostTracker(1);

    expect(await run({ tracker })).toBeNull();
    expect(tracker.lastError).toMatch(/only errors/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("charges the search and both calls to the run budget", async () => {
    create
      .mockResolvedValueOnce(searchTurn({ urls: ["https://a.example/"] }))
      .mockResolvedValueOnce(shapeTurn({ companies: [] }));
    const tracker = new CostTracker(1);

    await run({ tracker });

    expect(tracker.searchCalls).toBe(1);
    expect(tracker.spentUsd).toBeGreaterThan(0.01);
  });
});

describe("claudeSchema", () => {
  it("drops the keywords Claude rejects and keeps everything else", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", minItems: 2, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40, enum: ["a", "b"] } },
        score: { type: "integer", minimum: 0, maximum: 100 },
        notes: { type: "array", minItems: 1, items: { type: "string", format: "uri" } },
        // A field that happens to share a keyword's name is still a field.
        maximum: { type: "number" },
      },
      required: ["tags", "score", "notes", "maximum"],
      additionalProperties: false,
    };
    expect(claudeSchema(schema)).toEqual({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
        score: { type: "integer" },
        notes: { type: "array", minItems: 1, items: { type: "string", format: "uri" } },
        maximum: { type: "number" },
      },
      required: ["tags", "score", "notes", "maximum"],
      additionalProperties: false,
    });
  });

  it("turns a nullable enum into anyOf, which Claude accepts", () => {
    const field = { type: ["string", "null"], enum: ["restaurant", "clinic", null], description: "Industry." };
    expect(claudeSchema(field)).toEqual({
      description: "Industry.",
      anyOf: [{ type: "string", enum: ["restaurant", "clinic"] }, { type: "null" }],
    });
    // A plain nullable field without an enum is left alone.
    expect(claudeSchema({ type: ["string", "null"] })).toEqual({ type: ["string", "null"] });
  });
});

describe("capArrays", () => {
  it("trims arrays to their maxItems at every depth", () => {
    const schema = { type: "object", properties: { rows: { type: "array", maxItems: 2, items: { type: "object", properties: { tags: { type: "array", maxItems: 1, items: { type: "string" } } } } } } };
    const data = { rows: [{ tags: ["x", "y"] }, { tags: [] }, { tags: ["z"] }] };
    expect(capArrays(data, schema)).toEqual({ rows: [{ tags: ["x"] }, { tags: [] }] });
  });
});

describe("estimateCost", () => {
  it("prices Claude Sonnet 5 at $2 in and $10 out per million tokens", () => {
    expect(estimateCost({ model: "claude-sonnet-5", usage: { input_tokens: 1e6, output_tokens: 1e6 } })).toBeCloseTo(12);
  });
});
