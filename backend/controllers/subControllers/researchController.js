import { z } from "zod";
import prisma from "../../prismaClient.js";
import { parseQuery, describeQuery } from "../../lib/nlquery/parser.js";
import { parseWithLlm } from "../../lib/nlquery/llmParser.js";
import { buildResearchPlan } from "../../lib/nlquery/planner.js";
import { buildBrief, saveBrief } from "../../lib/research/brief.js";
import { getGrid } from "../../lib/research/grid.js";
import { composeEmailForLead } from "../../lib/research/compose.js";
import { createDiscoveryRun, startDiscoveryRun } from "../../lib/discovery/runner.js";
import { isResearchAvailable, CostTracker } from "../../lib/llm/responses.js";
import { createError } from "../../utils/createError.js";
import { asyncHandler } from "../../middlewares/validate.js";

export const researchSchema = z.object({
  q: z.string().trim().min(3, "Describe what you are looking for.").max(500),
});

/**
 * POST /api/research — start a deep-research run.
 *
 * The brief is produced synchronously so the response can show the user how the
 * request was understood, and so the run's steps carry real strategy names
 * rather than placeholders.
 */
export const startResearch = asyncHandler(async (req, res) => {
  const { q } = req.body;
  // Same contract as quick search: the deterministic parser always runs, and
  // the LLM refines a low-confidence parse. Deep research previously skipped
  // this, so a garbled location sailed straight into the plan.
  let parsed = parseQuery(q);
  if (parsed.confidence < 0.5) {
    const refined = await parseWithLlm(q, parsed);
    if (refined) parsed = refined;
  }
  const tracker = new CostTracker();

  const { brief, producedBy, model } = await buildBrief({ rawQuery: q, parsed, tracker });

  const searchQuery = await prisma.searchQuery.create({
    data: {
      rawText: q.slice(0, 1000),
      parsed: { query: parsed.query, chips: parsed.chips, confidence: parsed.confidence, brief },
      parserUsed: producedBy === "LLM" ? "LLM" : "DETERMINISTIC",
    },
  });

  const plan = buildResearchPlan(parsed, brief);
  const run = await createDiscoveryRun({ plan, trigger: "NL_QUERY", searchQueryId: searchQuery.id });
  await saveBrief({ runId: run.id, searchQueryId: searchQuery.id, brief, producedBy, model });
  startDiscoveryRun(run.id, parsed);

  res.status(202).json({
    success: true,
    message: "Research started.",
    data: {
      runId: run.id,
      queryId: searchQuery.id,
      interpretation: describeQuery(parsed),
      chips: parsed.chips,
      brief,
      briefProducedBy: producedBy,
      aiAvailable: isResearchAvailable(),
      steps: plan.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, label: s.label })),
    },
  });
});

/** GET /api/research-runs/:id/grid — the results table. */
export const getResearchGrid = asyncHandler(async (req, res) => {
  const grid = await getGrid(req.params.id);
  if (!grid) throw createError(404, "That research run could not be found.");

  const run = await prisma.discoveryRun.findUnique({
    where: { id: req.params.id },
    include: { steps: { orderBy: { ordinal: "asc" } }, searchQuery: true },
  });

  res.json({
    success: true,
    data: {
      runId: req.params.id,
      query: run?.searchQuery?.rawText ?? null,
      status: run?.status,
      isSnapshot: grid.isSnapshot,
      brief: grid.brief,
      aiUsage: grid.aiUsage,
      rows: grid.rows,
      unverified: grid.unverified,
      steps: (run?.steps || []).map((s) => ({ ordinal: s.ordinal, kind: s.kind, label: s.label, status: s.status, counts: s.counts, errorText: s.errorText })),
    },
  });
});

export const historySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** GET /api/research-history — every past search, newest first. */
export const getHistory = asyncHandler(async (req, res) => {
  const { page, pageSize } = req.validatedQuery;

  const where = { researchBrief: { isNot: null } };
  const [total, runs] = await Promise.all([
    prisma.discoveryRun.count({ where }),
    prisma.discoveryRun.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        searchQuery: true,
        researchBrief: true,
        _count: { select: { resultRows: true, aiCandidates: true } },
      },
    }),
  ]);

  res.json({
    success: true,
    data: {
      total, page, pageSize,
      runs: runs.map((r) => ({
        runId: r.id,
        query: r.searchQuery?.rawText ?? null,
        goal: r.researchBrief?.brief?.restatedGoal ?? null,
        briefProducedBy: r.researchBrief?.producedBy ?? null,
        status: r.status,
        stats: r.stats,
        aiUsage: r.aiUsage,
        resultCount: r._count.resultRows,
        candidateCount: r._count.aiCandidates,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      })),
    },
  });
});

/** GET /api/leads/:id/email-drafts */
export const listEmailDrafts = asyncHandler(async (req, res) => {
  const drafts = await prisma.leadEmailDraft.findMany({
    where: { leadId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  res.json({
    success: true,
    data: {
      drafts: drafts.map((d) => ({
        id: d.id, subject: d.subject, body: d.body, aboutCompany: d.aboutCompany,
        generatedBy: d.generatedBy, confidenceLevel: d.confidenceLevel,
        groundingFacts: d.groundingFacts, factIdsUsed: d.factIdsUsed,
        model: d.model, promptVersion: d.promptVersion, createdAt: d.createdAt,
      })),
    },
  });
});

/** POST /api/leads/:id/email-drafts — write a fresh one. */
export const regenerateEmailDraft = asyncHandler(async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
  if (!lead) throw createError(404, "Lead not found.");

  const tracker = new CostTracker();
  const draft = await composeEmailForLead({ leadId: lead.id, tracker });
  if (!draft) throw createError(500, "Could not generate an email for this lead.");

  res.status(201).json({
    success: true,
    message: draft.generatedBy === "LLM" ? "Email drafted." : "Email drafted from the template (AI unavailable).",
    data: {
      draft: {
        id: draft.id, subject: draft.subject, body: draft.body, aboutCompany: draft.aboutCompany,
        generatedBy: draft.generatedBy, confidenceLevel: draft.confidenceLevel,
        groundingFacts: draft.groundingFacts, factIdsUsed: draft.factIdsUsed,
      },
      aiUsage: tracker.toJSON(),
    },
  });
});
