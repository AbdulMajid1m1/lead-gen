import { z } from "zod";
import prisma from "../../prismaClient.js";
import { discoveryEvents, getRunWithSteps, cancelDiscoveryRun, createDiscoveryRun, startDiscoveryRun } from "../../lib/discovery/runner.js";
import { OSM_CATEGORIES } from "../../lib/adapters/overpass.js";
import { createError } from "../../utils/createError.js";
import { asyncHandler } from "../../middlewares/validate.js";

const runDto = (run) => ({
  id: run.id,
  trigger: run.trigger,
  status: run.status,
  stats: run.stats || { companiesFound: 0, crawled: 0, blocked: 0, jobsFound: 0, leadsCreated: 0, errors: 0 },
  leadCount: run._count?.leads ?? undefined,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  createdAt: run.createdAt,
  steps: (run.steps || []).map((s) => ({
    ordinal: s.ordinal, kind: s.kind, label: s.label, status: s.status,
    counts: s.counts, errorText: s.errorText, startedAt: s.startedAt, finishedAt: s.finishedAt,
  })),
});

/** GET /api/discovery-runs */
export const listRuns = asyncHandler(async (req, res) => {
  const runs = await prisma.discoveryRun.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    include: { steps: { orderBy: { ordinal: "asc" } }, _count: { select: { leads: true } }, searchQuery: true },
  });
  res.json({
    success: true,
    data: { runs: runs.map((r) => ({ ...runDto(r), query: r.searchQuery?.rawText ?? null })) },
  });
});

/** GET /api/discovery-runs/:id */
export const getRun = asyncHandler(async (req, res) => {
  const run = await getRunWithSteps(req.params.id);
  if (!run) throw createError(404, "Discovery run not found.");
  res.json({ success: true, data: runDto(run) });
});

/**
 * GET /api/discovery-runs/:id/events — Server-Sent Events.
 *
 * SSE rather than WebSockets: the stream is one-directional, short-lived and
 * survives proxies without an upgrade handshake.
 */
export const streamRun = asyncHandler(async (req, res) => {
  const run = await getRunWithSteps(req.params.id);
  if (!run) throw createError(404, "Discovery run not found.");

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // Replay current state first, so a client that connects late is never blank.
  send({ type: "snapshot", run: runDto(run) });

  if (["SUCCEEDED", "FAILED", "PARTIAL", "CANCELLED"].includes(run.status)) {
    send({ type: "run.finished", status: run.status, stats: run.stats });
    return res.end();
  }

  const onEvent = async (event) => {
    send(event);
    if (event.type === "run.finished") {
      const finished = await getRunWithSteps(req.params.id);
      send({ type: "snapshot", run: runDto(finished) });
      cleanup();
      res.end();
    }
  };

  // Proxies drop idle connections; a comment line every 20s keeps it warm.
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    discoveryEvents.off(req.params.id, onEvent);
  };

  discoveryEvents.on(req.params.id, onEvent);
  req.on("close", cleanup);
});

/** POST /api/discovery-runs/:id/cancel */
export const cancelRun = asyncHandler(async (req, res) => {
  const run = await prisma.discoveryRun.findUnique({ where: { id: req.params.id } });
  if (!run) throw createError(404, "Discovery run not found.");
  cancelDiscoveryRun(run.id);
  res.json({ success: true, message: "Cancellation requested." });
});

export const manualRunSchema = z.object({
  location: z.string().min(2).max(120),
  categories: z.array(z.enum(Object.keys(OSM_CATEGORIES))).min(1).max(3),
  radiusMeters: z.coerce.number().int().min(1000).max(50_000).default(10_000),
  limit: z.coerce.number().int().min(10).max(200).default(120),
  crawl: z.coerce.boolean().default(true),
});

/** POST /api/discovery-runs — start a targeted run without a text query. */
export const startManualRun = asyncHandler(async (req, res) => {
  const { location, categories, radiusMeters, limit, crawl } = req.body;

  let ordinal = 0;
  const steps = categories.map((categoryKey) => ({
    ordinal: ordinal++,
    kind: "OVERPASS",
    label: `Find ${OSM_CATEGORIES[categoryKey].label} businesses in ${location} via OpenStreetMap`,
    params: { categoryKey, location, radiusMeters, limit },
  }));
  if (crawl) {
    steps.push({ ordinal: ordinal++, kind: "CRAWL", label: "Crawl and audit the websites that were found", params: { maxHosts: 40, maxPagesPerHost: 4 } });
  }
  steps.push({ ordinal: ordinal++, kind: "SIGNALS", label: "Derive signals from the collected evidence", params: {} });
  steps.push({ ordinal: ordinal++, kind: "SCORE", label: "Score and rank the resulting leads", params: {} });

  const run = await createDiscoveryRun({ plan: { steps, estimatedSeconds: steps.length * 25 }, trigger: "MANUAL" });
  startDiscoveryRun(run.id, { query: { location: { name: location }, industries: categories } });

  res.status(202).json({ success: true, message: "Discovery started.", data: { discoveryRunId: run.id, steps: steps.length } });
});

/** GET /api/discovery-runs/categories — the category vocabulary for the UI. */
export const listCategories = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      categories: Object.entries(OSM_CATEGORIES).map(([key, v]) => ({ key, label: v.label })),
    },
  });
});
