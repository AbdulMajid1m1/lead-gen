import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import {
  listSignatures, renderSignatureText, renderSignatureHtml, renderSignatureWhatsApp,
} from "../../lib/outreach/signature.js";

/**
 * Sign-off management.
 *
 * Every response carries the three rendered forms alongside the stored fields,
 * so the composer and the settings preview never have to re-implement the
 * rendering — there is exactly one place that decides what a signature looks
 * like, and it is the server.
 */

const withPreview = (s) => ({
  id: s.id,
  name: s.name,
  isDefault: s.isDefault,
  fullName: s.fullName,
  title: s.title,
  company: s.company,
  website: s.website,
  email: s.email,
  phone: s.phone,
  tagline: s.tagline,
  accentColor: s.accentColor,
  createdAt: s.createdAt,
  preview: {
    text: renderSignatureText(s),
    html: renderSignatureHtml(s),
    whatsapp: renderSignatureWhatsApp(s),
  },
});

const optionalText = (max) =>
  z.union([z.string().trim().max(max), z.literal("")]).nullable().optional();

export const signatureSchema = z.object({
  name: z.string().trim().min(1).max(80),
  fullName: z.string().trim().min(1).max(120),
  title: optionalText(120),
  company: optionalText(120),
  website: optionalText(200),
  email: z.union([z.string().trim().email().max(255), z.literal("")]).nullable().optional(),
  phone: optionalText(40),
  tagline: optionalText(300),
  // Anything else would end up interpolated into a style attribute.
  accentColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "Use a hex colour like #4f39f6").optional(),
  isDefault: z.boolean().optional(),
});

/** Empty strings from the form mean "clear this field", not "store ''". */
const clean = (input) => {
  const nullify = (v) => (v === undefined ? undefined : v === "" || v === null ? null : String(v).trim());
  const email = nullify(input.email);
  return {
    name: input.name.trim(),
    fullName: input.fullName.trim(),
    title: nullify(input.title),
    company: nullify(input.company),
    // Stored bare so the renderers own the scheme; pasting a full URL still works.
    website: input.website === undefined ? undefined
      : input.website ? String(input.website).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "") : null,
    email: email ? email.toLowerCase() : email,
    phone: nullify(input.phone),
    tagline: nullify(input.tagline),
    ...(input.accentColor ? { accentColor: input.accentColor.toLowerCase() } : {}),
  };
};

/** Only one signature may be the default; clear the flag everywhere else. */
const applyDefault = async (id) => {
  await prisma.signature.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
  await prisma.signature.update({ where: { id }, data: { isDefault: true } });
};

/** GET /api/signatures */
export const list = asyncHandler(async (req, res) => {
  const signatures = await listSignatures();
  res.json({ success: true, data: { signatures: signatures.map(withPreview) } });
});

/** POST /api/signatures */
export const create = asyncHandler(async (req, res) => {
  const name = req.body.name.trim();
  if (await prisma.signature.findUnique({ where: { name } })) {
    throw createError(409, `A signature called "${name}" already exists.`);
  }
  // The first one becomes the default — otherwise a user who adds exactly one
  // signature would still get unsigned emails, which reads as a bug.
  const isFirst = (await prisma.signature.count()) === 0;
  const created = await prisma.signature.create({
    data: { ...clean(req.body), isDefault: isFirst || req.body.isDefault === true },
  });
  if (created.isDefault) await applyDefault(created.id);

  const saved = await prisma.signature.findUnique({ where: { id: created.id } });
  res.status(201).json({ success: true, message: `Signature "${saved.name}" saved.`, data: { signature: withPreview(saved) } });
});

/** PUT /api/signatures/:id */
export const update = asyncHandler(async (req, res) => {
  const existing = await prisma.signature.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Signature not found.");

  const name = req.body.name.trim();
  if (name !== existing.name && (await prisma.signature.findUnique({ where: { name } }))) {
    throw createError(409, `A signature called "${name}" already exists.`);
  }

  await prisma.signature.update({ where: { id: existing.id }, data: clean(req.body) });
  if (req.body.isDefault === true) await applyDefault(existing.id);

  const saved = await prisma.signature.findUnique({ where: { id: existing.id } });
  res.json({ success: true, message: `Signature "${saved.name}" updated.`, data: { signature: withPreview(saved) } });
});

/** POST /api/signatures/:id/default */
export const setDefault = asyncHandler(async (req, res) => {
  const existing = await prisma.signature.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Signature not found.");
  await applyDefault(existing.id);
  const saved = await prisma.signature.findUnique({ where: { id: existing.id } });
  res.json({ success: true, message: `"${saved.name}" is now the default sign-off.`, data: { signature: withPreview(saved) } });
});

/** DELETE /api/signatures/:id */
export const remove = asyncHandler(async (req, res) => {
  const existing = await prisma.signature.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Signature not found.");

  // Mailboxes pointing here are detached by the SetNull relation, so deleting a
  // signature never takes a mailbox down with it.
  await prisma.signature.delete({ where: { id: existing.id } });
  if (existing.isDefault) {
    const next = await prisma.signature.findFirst({ orderBy: { createdAt: "asc" } });
    if (next) await applyDefault(next.id);
  }
  res.json({ success: true, message: `Signature "${existing.name}" deleted.` });
});
