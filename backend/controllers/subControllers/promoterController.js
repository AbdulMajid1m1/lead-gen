import { z } from "zod";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { log } from "../../utils/logger.js";
import {
  listPromotedProducts, createPromotedProduct, getPromotedProduct,
  runProductResearch, approveIcp, updatePromotedProduct,
  launchPromoteRun, archivePromotedProduct,
} from "../../lib/promoter/service.js";
import { normalizeProductUrl } from "../../lib/promoter/productResearch.js";

const logger = log("promoter");

/**
 * The SaaS promoter.
 *
 * One product URL goes in; a researched profile and a drafted ICP come back;
 * a person reads the ICP and saves it; only then may discovery run. The gate in
 * the middle is the whole point of the feature, so it is enforced here as well
 * as in the service — a run must never be launched against a profile nobody
 * read, whichever door the request came through.
 */

// ─── Shared field schemas ────────────────────────────────────────────────────

const capped = (max) => z.string().trim().max(max);

/** Sent but blank, or explicitly null, means "clear this"; absent means "leave it". */
const optionalText = (max) =>
  z.union([capped(max), z.literal("")]).nullable().optional();

const isHttpUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/// Goes into a follow-up email verbatim, so it has to be a link a recipient can
/// actually open — not a bare hostname and not a javascript: URL.
const proofLinkField = z
  .union([
    capped(300).refine(isHttpUrl, "The proof link must be a full web address, for example https://tracefyhr.com/customers."),
    z.literal(""),
  ])
  .nullable()
  .optional();

// ─── Request schemas ─────────────────────────────────────────────────────────

export const productCreateSchema = z.object({
  url: z
    .string()
    .trim()
    .min(4, "Enter the product's website address, for example tracefyhr.com.")
    .max(300, "That web address is too long to be a product's home page.")
    .refine((value) => normalizeProductUrl(value) !== null,
      "Enter the product's website address, for example tracefyhr.com."),
});

export const productPatchSchema = z.object({
  // Not nullable: the name is what the product is listed under, and a blank one
  // would leave an unidentifiable row on the dashboard.
  name: capped(160).min(1, "Give the product a name.").optional(),
  pitchAngle: optionalText(400),
  proofLink: proofLinkField,
  senderContext: optionalText(400),
});

/**
 * The approved ICP.
 *
 * This JSON is drafted by the model, then edited by hand, and from then on it is
 * interpolated straight into prompt text and into the search instructions a
 * discovery run follows. That makes an unbounded string two problems at once: a
 * token bill nobody approved, and a comfortable place to hide instructions aimed
 * at the model. So every field is shape-checked and length-capped, and unknown
 * keys are dropped rather than stored — z.object strips them.
 *
 * Mirrors PRODUCT_ICP_SCHEMA in lib/research/prompts.js, but forgiving where
 * that one is strict: a half-filled section is a normal state for something a
 * person is still editing, and must not cost them the save.
 */
const DETECTABLE_VIA = ["JOB_POSTING", "TECH_STACK", "COMPANY_AGE", "WEBSITE_CONTENT", "DIRECTORY_LISTING", "SIGNAL_CATALOG", "OTHER"];
const SOURCE_TYPES = ["DIRECTORY", "NEWS", "REVIEW_SITE", "VENDOR_PAGE", "SOCIAL", "MAPS_LISTING", "COMPANY_SITE", "JOB_BOARD", "OTHER"];

const headcount = z.coerce.number().int().min(0).max(1_000_000).nullable().default(null);

const icpSchema = z.object({
  summary: capped(600).nullable().default(null),
  industries: z.array(capped(120)).max(8).default([]),
  companySize: z
    .object({ min: headcount, max: headcount, note: capped(400).nullable().default(null) })
    .default({ min: null, max: null, note: null }),
  geographies: z
    .array(z.object({
      region: capped(120),
      countryCode: z
        .union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter country code, e.g. AE."), z.literal("")])
        .nullable()
        .default(null)
        .transform((value) => value || null),
      reason: capped(400).nullable().default(null),
      priority: z.coerce.number().int().min(1).max(99).default(1),
    }))
    .max(8)
    .default([]),
  buyerTitles: z
    .object({
      decisionMakers: z.array(capped(120)).max(8).default([]),
      champions: z.array(capped(120)).max(8).default([]),
    })
    .default({ decisionMakers: [], champions: [] }),
  painPoints: z
    .array(z.object({ pain: capped(400), productAnswer: capped(400).nullable().default(null) }))
    .max(8)
    .default([]),
  buyingSignals: z
    .array(z.object({
      signal: capped(400),
      // An unrecognised method is recorded as OTHER rather than rejected: the
      // value only ever selects a detection strategy, and one we do not have is
      // indistinguishable from none.
      detectableVia: z.enum(DETECTABLE_VIA).catch("OTHER"),
      /// Only meaningful when detectableVia is SIGNAL_CATALOG; a key the catalog
      /// does not hold simply matches nothing downstream.
      signalKey: capped(80).nullable().default(null).transform((value) => value || null),
    }))
    .max(8)
    .default([]),
  disqualifiers: z.array(capped(400)).max(8).default([]),
  competitorsToDisplace: z.array(capped(120)).max(8).default([]),
  suggestedSearchQueries: z
    .array(z.object({
      label: capped(120),
      searchInstruction: capped(600),
      expectedSourceTypes: z.array(z.enum(SOURCE_TYPES).catch("OTHER")).max(8).default([]),
    }))
    .max(5)
    .default([]),
}, { error: "Send the ideal customer profile you are approving." });

export const icpApproveSchema = z.object({
  icp: icpSchema,
  pitchAngle: optionalText(400),
  proofLink: proofLinkField,
  senderContext: optionalText(400),
});

export const runLaunchSchema = z.object({
  // Validated even though the service clamps it, so a nonsense number is
  // answered with a message rather than silently rounded into something else.
  maxLeads: z.coerce.number().int().min(1).max(200).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 404 before anything else, so a stale id never reaches a write or a run. */
const mustFindProduct = async (id) => {
  const product = await getPromotedProduct(id);
  if (!product) throw createError(404, "That product could not be found.");
  return product;
};

/**
 * The service refuses with a plain Error; Prisma and the network arrive carrying
 * a `code`, a `status` or a Prisma class name. Telling someone their ICP is
 * unusable when the database is down would send them off to fix the wrong thing,
 * so only the first kind is rewritten into a user-facing refusal.
 */
const isRefusal = (err) =>
  !err.status && !err.code && !String(err.name || "").startsWith("Prisma");

/**
 * Research crawls a site and calls the model twice — minutes, not milliseconds,
 * and far longer than a request may be held open. The client watches the
 * product's status instead. Following startDiscoveryRun: not awaited, but never
 * left as an unhandled rejection.
 */
const researchInBackground = (productId) => {
  runProductResearch(productId).catch((err) => {
    logger.error({ err, productId }, "product research crashed");
  });
};

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /api/promoter/products */
export const listProducts = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { products: await listPromotedProducts() } });
});

/** POST /api/promoter/products — add a product and start researching it. */
export const createProduct = asyncHandler(async (req, res) => {
  let product;
  try {
    product = await createPromotedProduct({ url: req.body.url });
  } catch (err) {
    // One row per site, so the second paste of the same URL is a navigation
    // problem, not a failure — say which record to open.
    if (err.code === "P2002") {
      throw createError(409, "That product is already being promoted. Open it from the list instead of adding it twice.", { field: "url" });
    }
    if (!isRefusal(err)) throw err;
    throw createError(400, "That web address could not be read. Enter the product's own site, for example tracefyhr.com.", { field: "url" });
  }

  researchInBackground(product.id);

  res.status(202).json({
    success: true,
    message: `Researching ${product.name || product.url}. The profile and a draft ICP appear here in a minute or two.`,
    data: { product },
  });
});

/** GET /api/promoter/products/:id */
export const getProduct = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { product: await mustFindProduct(req.params.id) } });
});

/** PATCH /api/promoter/products/:id — the compose assets and the display name. */
export const patchProduct = asyncHandler(async (req, res) => {
  const existing = await mustFindProduct(req.params.id);
  const product = await updatePromotedProduct(existing.id, req.body);
  res.json({ success: true, message: "Product updated.", data: { product } });
});

/**
 * PUT /api/promoter/products/:id/icp — the human approval gate.
 *
 * Saving is approving: there is no separate button, because a profile someone
 * has read and edited is exactly what approval was meant to certify.
 */
export const approveProductIcp = asyncHandler(async (req, res) => {
  const existing = await mustFindProduct(req.params.id);

  let product;
  try {
    product = await approveIcp(existing.id, {
      icp: req.body.icp,
      pitchAngle: req.body.pitchAngle,
      proofLink: req.body.proofLink,
      senderContext: req.body.senderContext,
    });
  } catch (err) {
    if (!isRefusal(err)) throw err;
    throw createError(422, "This profile is not complete enough to find leads with. Fill in the industries, the buyer titles and at least one search to run.", { field: "icp" });
  }

  res.json({ success: true, message: "ICP approved. You can launch a run now.", data: { product } });
});

/**
 * POST /api/promoter/products/:id/research — research the site again.
 *
 * The first attempt can come back empty because the site blocked the crawler or
 * the model was unavailable, and neither is a permanent state worth making
 * someone delete the product over.
 */
export const researchProduct = asyncHandler(async (req, res) => {
  const product = await mustFindProduct(req.params.id);
  researchInBackground(product.id);

  res.status(202).json({
    success: true,
    message: "Researching the product again. The profile updates here as it finishes.",
    data: { product },
  });
});

/**
 * POST /api/promoter/products/:id/runs — source leads for this product.
 *
 * The approval check is made here, before the service is asked to do anything,
 * so the refusal is a clear 403 rather than a thrown string turned into a 500.
 */
export const launchRun = asyncHandler(async (req, res) => {
  const product = await mustFindProduct(req.params.id);
  if (!product.icpApproved) {
    throw createError(403, "Approve the ideal customer profile before running discovery. Nothing is contacted on a profile nobody has read.");
  }

  const { runId, steps } = await launchPromoteRun(product.id, { maxLeads: req.body.maxLeads });

  res.status(202).json({
    success: true,
    message: `Finding leads for ${product.name}.`,
    data: { runId, productId: product.id, steps },
  });
});

/** POST /api/promoter/products/:id/archive */
export const archiveProduct = asyncHandler(async (req, res) => {
  const existing = await mustFindProduct(req.params.id);
  const product = await archivePromotedProduct(existing.id);
  res.json({ success: true, message: `${product.name} archived.`, data: { product } });
});
