import prisma from "../../prismaClient.js";
import { normalizeProductUrl, researchProduct } from "./productResearch.js";
import { draftIcp, normaliseIcp, icpIsUsable, icpToParsedQuery } from "./icp.js";
import { CostTracker } from "../llm/responses.js";
import { PROMPT_VERSION } from "../research/prompts.js";
import { buildPromotePlan } from "../nlquery/planner.js";
import { createDiscoveryRun, startDiscoveryRun } from "../discovery/runner.js";
import { PROMOTER_RUN_BUDGET_USD } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("promoter");

/**
 * Everything that reads or writes a PromotedProduct.
 *
 * The two-gate flow lives here: research fills the row in, a human approves the
 * ICP, and only then may a run be launched. The approval check is enforced in
 * launchPromoteRun() rather than in the API layer, because the consequence of
 * skipping it is real email to real strangers chosen by a profile nobody read.
 */

/** VarChar limits from promoter.prisma. Writing past one is a 500, not a truncation. */
const LIMITS = {
  url: 300, name: 160, summary: 2000, category: 120,
  pitchAngle: 400, proofLink: 300, senderContext: 400,
  model: 60, promptVersion: 20,
};

const cut = (value, max) => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, max);
  return trimmed || null;
};

const toRunSummary = (run) => ({
  runId: run.id,
  status: run.status,
  createdAt: run.createdAt,
  finishedAt: run.finishedAt,
  stats: run.stats || null,
  leadCount: run._count?.leads ?? 0,
});

/** The one shape the frontend renders a product from, list row and detail alike. */
export const toProductDto = (product, extras = {}) => ({
  id: product.id,
  url: product.url,
  name: product.name,
  status: product.status,
  summary: product.summary,
  category: product.category,
  features: product.features || [],
  pricing: product.pricing || [],
  differentiators: product.differentiators || [],
  proofPoints: product.proofPoints || [],
  competitors: product.competitors || [],
  geographyCues: product.geographyCues || [],
  researchedUrls: product.researchedUrls || [],
  icp: product.icp || null,
  icpApproved: Boolean(product.icpApprovedAt),
  icpApprovedAt: product.icpApprovedAt,
  pitchAngle: product.pitchAngle,
  proofLink: product.proofLink,
  senderContext: product.senderContext,
  model: product.model,
  promptVersion: product.promptVersion,
  aiUsage: product.aiUsage || null,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
  runs: (product.runs || []).map(toRunSummary),
  ...extras,
});

const RUNS_INCLUDE = {
  runs: {
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { _count: { select: { leads: true } } },
  },
};

/**
 * The list rows, with enough on each to fill a card.
 *
 * This used to omit the runs entirely, so every card on the landing page said
 * "0 runs · 0 leads" however much a product had actually found — and the page
 * worked around it by fetching each product again individually, one request per
 * card. The runs are cheap to include and `leadCount` is a grouped count over
 * the whole set rather than a query per product.
 */
export const listPromotedProducts = async () => {
  const products = await prisma.promotedProduct.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { updatedAt: "desc" },
    include: RUNS_INCLUDE,
  });
  if (!products.length) return [];

  // One grouped query for every product's lead total, keyed by the run that
  // found each lead. Counting per product would be a query per card again.
  const runs = await prisma.discoveryRun.findMany({
    where: { promotedProductId: { in: products.map((p) => p.id) } },
    select: { id: true, promotedProductId: true, _count: { select: { leads: true } } },
  });
  const leadsByProduct = new Map();
  for (const run of runs) {
    leadsByProduct.set(run.promotedProductId, (leadsByProduct.get(run.promotedProductId) || 0) + run._count.leads);
  }

  return products.map((p) => toProductDto(p, { leadCount: leadsByProduct.get(p.id) || 0 }));
};

export const getPromotedProduct = async (id) => {
  const product = await prisma.promotedProduct.findUnique({ where: { id }, include: RUNS_INCLUDE });
  return product ? toProductDto(product) : null;
};

/**
 * A placeholder name so the row is identifiable before research finishes — and
 * the permanent name when the site never says what it calls itself.
 */
const nameFromUrl = (url) => {
  const host = new URL(url).hostname;
  const label = host.split(".")[0] || host;
  return cut(label.charAt(0).toUpperCase() + label.slice(1), LIMITS.name) || host.slice(0, LIMITS.name);
};

export const createPromotedProduct = async ({ url }) => {
  const normalized = normalizeProductUrl(url);
  if (!normalized) throw new Error(`"${url}" is not a public website address.`);

  // Re-pasting the same URL is how people re-open a product they already added.
  // Creating a second row for it would split its runs and drafts across two
  // products that are the same product.
  const existing = await prisma.promotedProduct.findUnique({ where: { url: normalized }, include: RUNS_INCLUDE });
  if (existing && existing.status !== "ARCHIVED") return toProductDto(existing);

  if (existing) {
    const revived = await prisma.promotedProduct.update({
      where: { id: existing.id },
      data: { status: "RESEARCHING" },
      include: RUNS_INCLUDE,
    });
    return toProductDto(revived);
  }

  const created = await prisma.promotedProduct.create({
    data: { url: normalized.slice(0, LIMITS.url), name: nameFromUrl(normalized), status: "RESEARCHING" },
  });
  logger.info({ productId: created.id, url: normalized }, "promoted product added");
  return toProductDto(created);
};

/** The first sentence of the summary, which is the angle until a human writes one. */
const angleFromSummary = (summary) => {
  if (!summary) return null;
  const sentence = String(summary).split(/(?<=[.!?])\s+/)[0] || summary;
  return cut(sentence, LIMITS.pitchAngle);
};

/**
 * Crawls the product's site, extracts its profile and drafts the ICP.
 *
 * Both AI stages are optional. A site that could not be read at all is a
 * FAILED product — there is nothing to promote. A site that was read but could
 * not be summarised still reaches ICP_REVIEW, because a human can write the
 * profile from the pages themselves and the gate they pass through is the same
 * one either way.
 */
export const runProductResearch = async (productId) => {
  const existing = await prisma.promotedProduct.findUnique({ where: { id: productId } });
  if (!existing) throw new Error("No such promoted product.");

  await prisma.promotedProduct.update({ where: { id: productId }, data: { status: "RESEARCHING" } });

  const tracker = new CostTracker(PROMOTER_RUN_BUDGET_USD);
  const research = await researchProduct({ productId, tracker });

  if (!research.ok) {
    const failed = await prisma.promotedProduct.update({
      where: { id: productId },
      data: { status: "FAILED", aiUsage: tracker.toJSON(), promptVersion: PROMPT_VERSION.slice(0, LIMITS.promptVersion) },
      include: RUNS_INCLUDE,
    });
    logger.warn({ productId, reason: research.reason }, "product research failed");
    return { ok: false, reason: research.reason, product: toProductDto(failed) };
  }

  const extracted = research.extracted;
  const data = { researchedUrls: research.pageUrls };

  if (extracted) {
    data.name = cut(extracted.name, LIMITS.name) || existing.name || nameFromUrl(existing.url);
    data.summary = cut(extracted.summary, LIMITS.summary);
    data.category = cut(extracted.category, LIMITS.category);
    data.features = extracted.features;
    data.pricing = extracted.pricing;
    data.differentiators = extracted.differentiators;
    data.proofPoints = extracted.proofPoints;
    data.competitors = extracted.competitors;
    data.geographyCues = extracted.geographyCues;
    data.model = cut(extracted.model, LIMITS.model);
  }

  // The ICP is drafted from what was just extracted where there is anything,
  // and otherwise from whatever a previous run or a human already stored — a
  // re-run must never draft against an empty product it did not read.
  const profile = extracted || {
    name: existing.name,
    summary: existing.summary,
    category: existing.category,
    features: existing.features || [],
    pricing: existing.pricing || [],
    differentiators: existing.differentiators || [],
    proofPoints: existing.proofPoints || [],
    competitors: existing.competitors || [],
    geographyCues: existing.geographyCues || [],
    targetSizeCues: [],
  };

  const draft = await draftIcp({ product: profile, tracker });

  // An approved ICP is the human's, not the model's. Replacing it on a re-run
  // would leave icpApprovedAt pointing at text nobody read, which is exactly
  // the state the gate exists to prevent.
  if (draft.ok && !existing.icpApprovedAt) data.icp = normaliseIcp(draft.icp);
  if (draft.model) data.model = cut(draft.model, LIMITS.model);

  data.promptVersion = PROMPT_VERSION.slice(0, LIMITS.promptVersion);
  data.aiUsage = tracker.toJSON();
  data.status = existing.icpApprovedAt ? "READY" : "ICP_REVIEW";

  // Defaults only where a human has not already answered. These fields go
  // straight into outreach copy, so an edited value outranks a derived one.
  const name = data.name || existing.name;
  if (!existing.pitchAngle) data.pitchAngle = angleFromSummary(data.summary ?? existing.summary);
  if (!existing.senderContext) data.senderContext = cut(`Writing on behalf of ${name}.`, LIMITS.senderContext);

  const product = await prisma.promotedProduct.update({ where: { id: productId }, data, include: RUNS_INCLUDE });

  const reason = [research.reason, draft.reason].filter(Boolean).join(" ") || null;
  logger.info({ productId, pagesRead: research.pagesRead, icp: Boolean(data.icp) }, "product research finished");
  return { ok: true, reason, product: toProductDto(product) };
};

/**
 * The human gate. Nothing may be sourced for this product until it passes.
 *
 * Re-approving is the normal way an ICP is edited, so this refreshes the
 * timestamp rather than refusing a product that is already READY.
 */
export const approveIcp = async (productId, { icp, pitchAngle, proofLink, senderContext } = {}) => {
  const existing = await prisma.promotedProduct.findUnique({ where: { id: productId } });
  if (!existing) throw new Error("No such promoted product.");

  const normalised = normaliseIcp(icp ?? existing.icp);
  if (!icpIsUsable(normalised)) {
    throw new Error(
      "This ideal customer profile has no search instructions, so it would source nothing. " +
      "Add at least one before approving it.",
    );
  }

  const data = { icp: normalised, icpApprovedAt: new Date(), status: "READY" };
  if (pitchAngle !== undefined) data.pitchAngle = cut(pitchAngle, LIMITS.pitchAngle);
  if (proofLink !== undefined) data.proofLink = proofLink ? cut(proofLink, LIMITS.proofLink) : null;
  if (senderContext !== undefined) data.senderContext = cut(senderContext, LIMITS.senderContext);

  const product = await prisma.promotedProduct.update({ where: { id: productId }, data, include: RUNS_INCLUDE });
  logger.info({ productId, queries: normalised.suggestedSearchQueries.length }, "ICP approved");
  return toProductDto(product);
};

/** The editable fields, each clamped to what the column will hold. */
export const updatePromotedProduct = async (productId, patch = {}) => {
  const existing = await prisma.promotedProduct.findUnique({ where: { id: productId } });
  if (!existing) throw new Error("No such promoted product.");

  const data = {};
  if (patch.name !== undefined) data.name = cut(patch.name, LIMITS.name) || existing.name;
  if (patch.summary !== undefined) data.summary = cut(patch.summary, LIMITS.summary);
  if (patch.category !== undefined) data.category = cut(patch.category, LIMITS.category);
  if (patch.pitchAngle !== undefined) data.pitchAngle = cut(patch.pitchAngle, LIMITS.pitchAngle);
  if (patch.proofLink !== undefined) data.proofLink = patch.proofLink ? cut(patch.proofLink, LIMITS.proofLink) : null;
  if (patch.senderContext !== undefined) data.senderContext = cut(patch.senderContext, LIMITS.senderContext);

  // Editing the ICP retracts the approval. The alternative — an approved
  // timestamp over text that changed after it was read — is the one thing the
  // gate exists to make impossible.
  if (patch.icp !== undefined) {
    data.icp = normaliseIcp(patch.icp);
    data.icpApprovedAt = null;
    if (existing.status === "READY") data.status = "ICP_REVIEW";
  }

  const product = await prisma.promotedProduct.update({ where: { id: productId }, data, include: RUNS_INCLUDE });
  return toProductDto(product);
};

/**
 * Starts a discovery run that sources leads for this product.
 *
 * The approval check is here, server-side, and not only in the UI: this is the
 * function that puts strangers into an outreach queue, and a run launched from
 * a script or a stale browser tab must hit the same gate a button does.
 */
export const launchPromoteRun = async (productId, options = {}) => {
  const product = await prisma.promotedProduct.findUnique({ where: { id: productId } });
  if (!product) throw new Error("No such promoted product.");
  if (product.status === "ARCHIVED") throw new Error(`${product.name} is archived. Restore it before running discovery.`);
  if (!product.icpApprovedAt) {
    throw new Error(
      `The ideal customer profile for ${product.name} has not been approved yet. ` +
      "No leads can be sourced until someone reads and approves it.",
    );
  }

  const plan = buildPromotePlan(product, options);
  const run = await createDiscoveryRun({ plan, trigger: "MANUAL" });
  // Linking after creation rather than through createDiscoveryRun keeps that
  // function's signature shared with every other kind of run.
  await prisma.discoveryRun.update({ where: { id: run.id }, data: { promotedProductId: product.id } });

  startDiscoveryRun(run.id, icpToParsedQuery(product.icp));
  logger.info({ productId, runId: run.id, steps: plan.steps.length }, "promote run launched");

  return {
    runId: run.id,
    steps: plan.steps.map((s) => ({ ordinal: s.ordinal, kind: s.kind, label: s.label })),
    product: toProductDto(product),
  };
};

export const archivePromotedProduct = async (productId) => {
  const product = await prisma.promotedProduct.update({
    where: { id: productId },
    data: { status: "ARCHIVED" },
    include: RUNS_INCLUDE,
  });
  logger.info({ productId }, "promoted product archived");
  return toProductDto(product);
};
