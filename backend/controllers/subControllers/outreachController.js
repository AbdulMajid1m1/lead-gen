import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { verifySmtp } from "../../lib/outreach/mailer.js";
import { verifyImap, canReceive } from "../../lib/outreach/inbox.js";
import {
  getAccount, listAccounts, sendInitialEmail, sendFollowUp, syncReplies, processDueFollowUps,
  sendWhatsAppForLead,
} from "../../lib/outreach/service.js";
import { checkSession, logout as whatsappLogout, whatsappStatus } from "../../lib/outreach/whatsapp.js";
import { composeForRun } from "../../lib/research/compose.js";
import { CostTracker } from "../../lib/llm/responses.js";

/** Everything the frontend may see about an account — never a password. */
const sanitizeAccount = (a) => ({
  id: a.id, provider: a.provider, email: a.email, displayName: a.displayName,
  replyTo: a.replyTo, isDefault: a.isDefault,
  smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpUser: a.smtpUser,
  imapHost: a.imapHost, imapPort: a.imapPort, imapUser: a.imapUser,
  canReceive: canReceive(a),
  status: a.status, lastError: a.lastError,
  autoFollowUp: a.autoFollowUp, followUpDays: a.followUpDays, maxFollowUps: a.maxFollowUps,
  signature: a.signature, lastSyncAt: a.lastSyncAt, createdAt: a.createdAt,
});

/**
 * Host presets per provider. Everything here is overridable field by field —
 * the preset only fills in what the request left blank.
 *
 * RESEND is send-only: its SMTP relay has no mailbox behind it, so replies are
 * tracked by pointing imapHost/imapUser at whatever inbox the From address
 * forwards into (a Gmail account, typically).
 */
const PRESETS = {
  GMAIL: { smtpHost: "smtp.gmail.com", smtpPort: 465, imapHost: "imap.gmail.com", imapPort: 993 },
  RESEND: { smtpHost: "smtp.resend.com", smtpPort: 465, smtpUser: "resend" },
  SMTP: {},
};

/** GET /api/outreach/accounts — every connected mailbox. */
export const listAccountInfo = asyncHandler(async (req, res) => {
  const accounts = await listAccounts();
  res.json({ success: true, data: { accounts: accounts.map(sanitizeAccount) } });
});

/**
 * GET /api/outreach/account — the mailbox the composer defaults to.
 * Kept alongside the list so older clients keep working.
 */
export const getAccountInfo = asyncHandler(async (req, res) => {
  const account = await getAccount();
  res.json({ success: true, data: { account: account ? sanitizeAccount(account) : null } });
});

const optionalHost = z.string().trim().max(255).nullable().optional();

export const accountSchema = z.object({
  email: z.string().email().max(255),
  appPassword: z.string().min(8).max(500).optional(),
  displayName: z.string().max(120).optional(),
  replyTo: z.union([z.string().email().max(255), z.literal("")]).optional(),
  provider: z.enum(["GMAIL", "SMTP", "RESEND"]).default("GMAIL"),
  isDefault: z.boolean().optional(),
  smtpHost: z.string().trim().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpUser: z.string().trim().max(255).optional(),
  imapHost: optionalHost,
  imapPort: z.number().int().min(1).max(65535).nullable().optional(),
  imapUser: z.string().trim().max(255).optional(),
  imapPassword: z.string().min(8).max(500).optional(),
  autoFollowUp: z.boolean().optional(),
  followUpDays: z.array(z.number().int().min(1).max(60)).max(5).optional(),
  maxFollowUps: z.number().int().min(0).max(5).optional(),
  signature: z.string().max(2000).optional(),
});

/** Only one account may be the default; clear the flag everywhere else. */
const applyDefault = async (accountId) => {
  await prisma.emailAccount.updateMany({ where: { id: { not: accountId } }, data: { isDefault: false } });
  await prisma.emailAccount.update({ where: { id: accountId }, data: { isDefault: true } });
};

/** Re-check SMTP (and IMAP when there is an inbox), then store the verdict. */
const verifyAndStore = async (account) => {
  const [smtp, imap] = await Promise.all([verifySmtp(account), verifyImap(account)]);
  const ok = smtp.ok && imap.ok;
  const updated = await prisma.emailAccount.update({
    where: { id: account.id },
    data: {
      status: ok ? "CONNECTED" : "ERROR",
      lastError: ok ? null : (smtp.error || imap.error || "Verification failed").slice(0, 500),
    },
  });
  return { account: updated, smtp, imap, ok };
};

const blank = (v) => v === undefined || v === null || v === "";

/**
 * Build the stored row from the request, an optional existing row, and the
 * provider preset — request wins, then what is already saved, then the preset.
 */
const buildAccountData = (input, existing) => {
  const provider = input.provider || existing?.provider || "GMAIL";
  const preset = PRESETS[provider] || {};
  const pick = (key, fallback = null) => {
    if (!blank(input[key])) return input[key];
    if (existing && !blank(existing[key]) && input.provider === existing.provider) return existing[key];
    if (!blank(preset[key])) return preset[key];
    return fallback;
  };

  // An explicitly null imapHost means "make this send-only" — honour it.
  const imapCleared = input.imapHost === null || input.imapHost === "";
  const imapHost = imapCleared ? null : pick("imapHost");

  return {
    provider,
    email: input.email.trim().toLowerCase(),
    displayName: blank(input.displayName) ? (existing?.displayName ?? null) : input.displayName.trim(),
    replyTo: input.replyTo === undefined ? (existing?.replyTo ?? null) : (input.replyTo || null),
    smtpHost: pick("smtpHost", "smtp.gmail.com"),
    smtpPort: pick("smtpPort", 465),
    smtpUser: pick("smtpUser"),
    imapHost,
    imapPort: imapHost ? pick("imapPort", 993) : null,
    imapUser: imapHost ? pick("imapUser") : null,
    ...(input.appPassword ? { authPassword: input.appPassword.replace(/\s+/g, "") } : {}),
    ...(input.imapPassword ? { imapPassword: input.imapPassword.replace(/\s+/g, "") } : {}),
    ...(input.autoFollowUp !== undefined ? { autoFollowUp: input.autoFollowUp } : {}),
    ...(input.followUpDays ? { followUpDays: input.followUpDays } : {}),
    ...(input.maxFollowUps !== undefined ? { maxFollowUps: input.maxFollowUps } : {}),
    ...(input.signature !== undefined ? { signature: input.signature || null } : {}),
  };
};

/** Connect a brand-new mailbox. Shared by the create and upsert routes. */
const connectNew = async (input) => {
  if (!input.appPassword) throw createError(400, "An app password or API key is required to connect a mailbox.");

  const email = input.email.trim().toLowerCase();
  if (await prisma.emailAccount.findUnique({ where: { email } })) {
    throw createError(409, `${email} is already connected. Edit that mailbox instead.`);
  }

  const isFirst = (await prisma.emailAccount.count()) === 0;
  const created = await prisma.emailAccount.create({
    data: { ...buildAccountData(input, null), isDefault: isFirst || input.isDefault === true },
  });
  if (created.isDefault) await applyDefault(created.id);

  const result = await verifyAndStore(created);
  return {
    ...result,
    message: result.ok
      ? `${result.account.email} connected${result.account.imapHost ? " — sending and reply tracking are live." : " — sending is live (send-only mailbox)."}`
      : `Saved, but verification failed: ${result.account.lastError}`,
  };
};

/** Update an existing mailbox in place. Shared by the update and upsert routes. */
const applyUpdate = async (existing, input) => {
  const email = input.email.trim().toLowerCase();
  if (email !== existing.email && (await prisma.emailAccount.findUnique({ where: { email } }))) {
    throw createError(409, `${email} is already connected as another mailbox.`);
  }

  const saved = await prisma.emailAccount.update({
    where: { id: existing.id },
    data: buildAccountData(input, existing),
  });
  if (input.isDefault === true) await applyDefault(saved.id);

  const result = await verifyAndStore(saved);
  return {
    ...result,
    message: result.ok ? `${result.account.email} verified.` : `Saved, but verification failed: ${result.account.lastError}`,
  };
};

const accountResponse = (res, status, { account, smtp, imap, ok, message }) =>
  res.status(status).json({
    success: true,
    message,
    data: { account: sanitizeAccount(account), verified: ok, smtp, imap },
  });

/** POST /api/outreach/accounts — connect an additional mailbox. */
export const createAccount = asyncHandler(async (req, res) => {
  accountResponse(res, 201, await connectNew(req.body));
});

/** PUT /api/outreach/accounts/:id — update one mailbox. */
export const updateAccount = asyncHandler(async (req, res) => {
  const existing = await prisma.emailAccount.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Mailbox not found.");
  accountResponse(res, 200, await applyUpdate(existing, req.body));
});

/**
 * PUT /api/outreach/account — create or update by email address.
 * The single-mailbox path the earlier UI used; it now upserts one of many.
 */
export const saveAccount = asyncHandler(async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
  const existing = await prisma.emailAccount.findUnique({ where: { email } });
  if (existing) return accountResponse(res, 200, await applyUpdate(existing, req.body));
  return accountResponse(res, 201, await connectNew(req.body));
});

/** POST /api/outreach/accounts/:id/default — make this the sending default. */
export const setDefaultAccount = asyncHandler(async (req, res) => {
  const existing = await prisma.emailAccount.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Mailbox not found.");
  await applyDefault(existing.id);
  const account = await prisma.emailAccount.findUnique({ where: { id: existing.id } });
  res.json({ success: true, message: `${account.email} is now the default sender.`, data: { account: sanitizeAccount(account) } });
});

/** POST /api/outreach/accounts/:id/test — re-verify one mailbox. */
export const testAccountById = asyncHandler(async (req, res) => {
  const existing = await prisma.emailAccount.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Mailbox not found.");
  const { smtp, imap, ok } = await verifyAndStore(existing);
  res.json({ success: true, data: { smtp, imap, ok } });
});

/** POST /api/outreach/account/test — re-verify the default mailbox. */
export const testAccount = asyncHandler(async (req, res) => {
  const account = await getAccount();
  if (!account) throw createError(404, "No mailbox connected yet.");
  const { smtp, imap, ok } = await verifyAndStore(account);
  res.json({ success: true, data: { smtp, imap, ok } });
});

/** Remove one mailbox and hand the default flag on if it held it. */
const removeAccount = async (account) => {
  await prisma.emailAccount.delete({ where: { id: account.id } });
  if (!account.isDefault) return;
  const next = await prisma.emailAccount.findFirst({ orderBy: { createdAt: "asc" } });
  if (next) await applyDefault(next.id);
};

/** DELETE /api/outreach/accounts/:id */
export const deleteAccountById = asyncHandler(async (req, res) => {
  const account = await prisma.emailAccount.findUnique({ where: { id: req.params.id } });
  if (!account) throw createError(404, "Mailbox not found.");
  await removeAccount(account);
  res.json({ success: true, message: `${account.email} disconnected. Its sent-thread history has been removed with it.` });
});

/** DELETE /api/outreach/account — disconnect the default mailbox. */
export const deleteAccount = asyncHandler(async (req, res) => {
  const account = await getAccount();
  if (!account) throw createError(404, "No mailbox connected.");
  await removeAccount(account);
  res.json({ success: true, message: "Mailbox disconnected. Sent history has been removed with it." });
});

export const sendSchema = z.object({
  leadId: z.string().min(1).max(64),
  to: z.string().email().max(255),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
  draftId: z.string().max(64).optional(),
  /// Which connected mailbox to send from. Omitted = the default sender.
  accountId: z.string().max(64).optional(),
});

/** POST /api/outreach/send */
export const send = asyncHandler(async (req, res) => {
  const { leadId, to, subject, body, draftId, accountId } = req.body;
  const account = await getAccount(accountId || null);
  if (!account) {
    throw createError(400, accountId
      ? "That mailbox is no longer connected — pick another sender."
      : "Connect a mailbox in Settings before sending.");
  }
  if (account.status === "ERROR") throw createError(400, `${account.email} has an error: ${account.lastError || "unknown"}. Re-test it in Settings.`);

  const result = await sendInitialEmail({ account, leadId, to, subject, body, draftId: draftId || null });
  if (!result.ok) throw createError(400, result.error);

  res.status(201).json({ success: true, message: `Email sent to ${to} from ${account.email}.`, data: { thread: result.thread } });
});

export const syncQuerySchema = z.object({ accountId: z.string().max(64).optional() });

/**
 * POST /api/outreach/sync — pull replies now, then send anything due.
 * One mailbox when accountId is given, every connected one otherwise.
 */
export const syncNow = asyncHandler(async (req, res) => {
  const accountId = req.body?.accountId || null;
  const accounts = accountId ? [await getAccount(accountId)].filter(Boolean) : await listAccounts();
  if (!accounts.length) throw createError(400, "Connect a mailbox in Settings first.");

  let checked = 0;
  let replies = 0;
  let followUpsSent = 0;
  const errors = [];
  for (const account of accounts) {
    const sync = await syncReplies({ account });
    if (sync.error) { errors.push(`${account.email}: ${sync.error}`); continue; }
    checked += sync.checked || 0;
    replies += sync.replies || 0;
    const followUps = await processDueFollowUps({ account });
    followUpsSent += followUps.sent || 0;
  }
  if (errors.length === accounts.length) throw createError(502, `Reply sync failed: ${errors.join("; ")}`);

  res.json({
    success: true,
    message: `Checked ${checked} open thread(s) across ${accounts.length} mailbox(es): ${replies} new repl${replies === 1 ? "y" : "ies"}`
      + `${followUpsSent ? `, ${followUpsSent} follow-up(s) sent` : ""}`
      + `${errors.length ? ` — ${errors.length} mailbox(es) failed: ${errors.join("; ")}` : ""}.`,
    data: { sync: { checked, replies }, followUps: { sent: followUpsSent }, errors },
  });
});

export const threadsQuerySchema = z.object({ leadId: z.string().max(64).optional() });

/** GET /api/outreach/threads — all threads slim, or one lead's in full. */
export const listThreads = asyncHandler(async (req, res) => {
  const { leadId } = req.validatedQuery || {};
  const threads = await prisma.outreachThread.findMany({
    where: leadId ? { leadId } : {},
    orderBy: { updatedAt: "desc" },
    take: leadId ? 20 : 500,
    include: leadId
      ? { messages: { orderBy: { createdAt: "asc" } } }
      : { messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, kind: true, createdAt: true } } },
  });
  res.json({ success: true, data: { threads } });
});

/** POST /api/outreach/threads/:id/follow-up — send one now, manually. */
export const followUpNow = asyncHandler(async (req, res) => {
  // Follow up from the mailbox the thread was opened with, so the reply chain
  // stays on one identity even when several are connected.
  const thread = await prisma.outreachThread.findUnique({ where: { id: req.params.id }, select: { accountId: true } });
  const account = await getAccount(thread?.accountId || null);
  if (!account) throw createError(400, "The mailbox this thread was sent from is no longer connected.");
  const result = await sendFollowUp({ account, threadId: req.params.id });
  if (!result.ok) throw createError(400, result.error);
  res.json({ success: true, message: "Follow-up sent.", data: { thread: result.thread } });
});

export const composeBatchSchema = z.object({
  leadIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  runId: z.string().max(64).optional(),
});

// ─── WhatsApp: QR pairing, status, sending ────────────────────────────────────

export const whatsappSessionQuerySchema = z.object({
  forceNew: z.enum(["true", "false"]).optional(),
});

/**
 * GET /api/outreach/whatsapp/session — connect or report. Returns
 * `connected` (+ user), `qr_required` (+ data-URL QR to scan), `initializing`,
 * or `disconnected`. `?forceNew=true` wipes the pairing and mints a fresh QR.
 */
export const whatsappSession = asyncHandler(async (req, res) => {
  const { forceNew } = req.validatedQuery || {};
  const result = await checkSession({ forceNew: forceNew === "true" });
  res.json({ success: true, data: result });
});

/** GET /api/outreach/whatsapp/status — cheap poll, never initializes. */
export const whatsappStatusInfo = asyncHandler(async (req, res) => {
  res.json({ success: true, data: whatsappStatus() });
});

/** POST /api/outreach/whatsapp/logout */
export const whatsappLogoutHandler = asyncHandler(async (req, res) => {
  await whatsappLogout();
  res.json({ success: true, message: "WhatsApp disconnected. Scan a new QR to pair again." });
});

export const whatsappSendSchema = z.object({
  leadId: z.string().min(1).max(64),
  phone: z.string().trim().min(7).max(30),
  message: z.string().trim().min(1).max(4000),
});

/** POST /api/outreach/whatsapp/send */
export const whatsappSend = asyncHandler(async (req, res) => {
  const { leadId, phone, message } = req.body;
  const result = await sendWhatsAppForLead({ leadId, phone, message });
  if (!result.ok) throw createError(400, result.error);
  res.status(201).json({ success: true, message: "WhatsApp message sent.", data: { thread: result.thread } });
});

/**
 * POST /api/outreach/compose-batch — write emails for many leads in one pass.
 * AI when a provider is up (few batched calls), templates otherwise.
 */
export const composeBatch = asyncHandler(async (req, res) => {
  const { leadIds, runId } = req.body;
  const tracker = new CostTracker();
  const result = await composeForRun({ runId: runId || null, leadIds, tracker });
  res.json({
    success: true,
    message: `${result.written} email(s) drafted — ${result.aiWritten} by AI, ${result.templated} from templates.`,
    data: { ...result, aiUsage: tracker.toJSON() },
  });
});
