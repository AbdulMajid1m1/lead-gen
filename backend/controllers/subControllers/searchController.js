import { z } from "zod";
import prisma from "../../prismaClient.js";
import { parseQuery, describeQuery } from "../../lib/nlquery/parser.js";
import { parseWithLlm } from "../../lib/nlquery/llmParser.js";
import { searchLeads, buildDiscoveryPlan, shouldDiscover, explainEmptyResult } from "../../lib/nlquery/planner.js";
import { createDiscoveryRun, startDiscoveryRun } from "../../lib/discovery/runner.js";
import { createError } from "../../utils/createError.js";
import { asyncHandler } from "../../middlewares/validate.js";

export const searchSchema = z.object({
  q: z.string().trim().min(2, "Enter at least two characters.").max(500),
  page: z.coerce.number().int().min(1).max(100).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  autoDiscover: z.coerce.boolean().default(true),
});

/**
 * POST /api/search
 *
 * Always answers from the database first, then decides whether the answer is
 * thin enough to justify going out and discovering more. The response carries
 * the parsed interpretation so the UI can show *how* the query was understood.
 */
export const search = asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const { q, page, pageSize, autoDiscover } = req.body;

  // The deterministic parser always runs; the LLM only ever refines a
  // low-confidence result, and its output is validated against the same shape.
  let parsed = parseQuery(q);
  if (parsed.confidence < 0.5) {
    const refined = await parseWithLlm(q, parsed);
    if (refined) parsed = refined;
  }

  const { leads, total } = await searchLeads(parsed, { page, pageSize });

  const searchQuery = await prisma.searchQuery.create({
    data: {
      rawText: q.slice(0, 1000),
      parsed: { query: parsed.query, chips: parsed.chips, confidence: parsed.confidence },
      parserUsed: parsed.parserUsed,
      resultCount: total,
      tookMs: Date.now() - startedAt,
    },
  });

  // When nothing matched, work out which filter is responsible so the UI can
  // say something more useful than "0 leads".
  const diagnostics = total === 0 ? await explainEmptyResult(parsed) : null;

  let discoveryRunId = null;
  if (autoDiscover && shouldDiscover(total, parsed)) {
    const plan = buildDiscoveryPlan(parsed);
    const run = await createDiscoveryRun({ plan, trigger: "NL_QUERY", searchQueryId: searchQuery.id });
    startDiscoveryRun(run.id, parsed);
    discoveryRunId = run.id;
  }

  res.json({
    success: true,
    data: {
      query: {
        id: searchQuery.id,
        raw: q,
        interpretation: describeQuery(parsed),
        chips: parsed.chips,
        structured: parsed.query,
        parserUsed: parsed.parserUsed,
        confidence: parsed.confidence,
        unparsed: parsed.unparsed,
      },
      leads,
      total,
      page,
      pageSize,
      discoveryRunId,
      diagnostics,
      tookMs: Date.now() - startedAt,
    },
  });
});

export const discoverSchema = z.object({ queryId: z.string().min(1) });

/** POST /api/search/:queryId/discover — explicit "go find more" */
export const discoverForQuery = asyncHandler(async (req, res) => {
  const searchQuery = await prisma.searchQuery.findUnique({ where: { id: req.params.queryId } });
  if (!searchQuery) throw createError(404, "That search could not be found.");

  const stored = searchQuery.parsed || {};
  const parsed = {
    query: stored.query || parseQuery(searchQuery.rawText).query,
    chips: stored.chips || [],
    confidence: stored.confidence ?? 0.5,
    parserUsed: searchQuery.parserUsed,
  };

  const plan = buildDiscoveryPlan(parsed);
  const run = await createDiscoveryRun({ plan, trigger: "NL_QUERY", searchQueryId: searchQuery.id });
  startDiscoveryRun(run.id, parsed);

  res.status(202).json({ success: true, message: "Discovery started.", data: { discoveryRunId: run.id, plan } });
});

/** GET /api/search/parse?q=… — preview the interpretation without searching. */
export const previewParse = asyncHandler(async (req, res) => {
  const q = String(req.query.q || "");
  if (q.trim().length < 2) throw createError(400, "Enter at least two characters.", { field: "q" });
  const parsed = parseQuery(q);
  res.json({
    success: true,
    data: {
      interpretation: describeQuery(parsed),
      chips: parsed.chips,
      structured: parsed.query,
      confidence: parsed.confidence,
      unparsed: parsed.unparsed,
    },
  });
});
