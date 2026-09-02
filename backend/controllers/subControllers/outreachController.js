import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { verifySmtp } from "../../lib/outreach/mailer.js";
import { verifyImap, canReceive } from "../../lib/outreach/inbox.js";
import {
  getAccount, listAccounts, sendInitialEmail, sendFollowUp, sendReply, syncReplies, processDueFollowUps,
  sendWhatsAppForLead, sendWhatsAppFollowUp, processDueWhatsAppFollowUps, outreachInbox,
} from "../../lib/outreach/service.js";
import {
  checkSession, logoutWhatsApp, whatsappStatusAll, whatsappAccountStatus,
  listWhatsAppAccounts, createWhatsAppAccount, deleteWhatsAppAccount,
  getWhatsAppAccount, applyWhatsAppDefault,
} from "../../lib/outreach/whatsapp.js";
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
  signature: a.signature, signatureId: a.signatureId,
  lastSyncAt: a.lastSyncAt, createdAt: a.createdAt,
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
  /// The Signature row this mailbox signs off with. Explicit null = none.
  signatureId: z.string().max(64).nullable().optional(),
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
    ...(input.signatureId !== undefined ? { signatureId: input.signatureId || null } : {}),
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
  // The ramp in deliverability.js is keyed off this date, and a null one means
  // "past the ramp" — so a mailbox connected without it would open at the full
  // daily cap on its first day, which is the standing start the ramp exists to
  // avoid. Connecting a mailbox *is* the moment its warm-up begins.
  const created = await prisma.emailAccount.create({
    data: {
      ...buildAccountData(input, null),
      warmupStartedAt: new Date(),
      isDefault: isFirst || input.isDefault === true,
    },
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
  /// Which sign-off to append. Omitted = the mailbox's own, then the global
  /// default. Explicit null = send unsigned.
  signatureId: z.string().max(64).nullable().optional(),
});

/** POST /api/outreach/send */
export const send = asyncHandler(async (req, res) => {
  const { leadId, to, subject, body, draftId, accountId, signatureId } = req.body;
  const account = await getAccount(accountId || null);
  if (!account) {
    throw createError(400, accountId
      ? "That mailbox is no longer connected — pick another sender."
      : "Connect a mailbox in Settings before sending.");
  }
  if (account.status === "ERROR") throw createError(400, `${account.email} has an error: ${account.lastError || "unknown"}. Re-test it in Settings.`);

  const result = await sendInitialEmail({
    account, leadId, to, subject, body, draftId: draftId || null, signatureId,
    // Which mailbox it left from is already on the thread; this records which
    // colleague pressed send, which is the question a shared mailbox cannot
    // answer on its own.
    sentBy: req.auth.user,
  });
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
  // WhatsApp replies arrive over a live socket, so there is nothing to poll —
  // but a manual sync should still flush any chase that has come due, or the
  // button would silently do half the job when only a phone is linked.
  const devices = accountId ? [] : await listWhatsAppAccounts();

  if (!accounts.length && !devices.length) {
    throw createError(400, "Connect a mailbox or link a WhatsApp device in Settings first.");
  }

  let checked = 0;
  let replies = 0;
  let followUpsSent = 0;
  let whatsappFollowUps = 0;
  const errors = [];
  for (const account of accounts) {
    const sync = await syncReplies({ account });
    if (sync.error) { errors.push(`${account.email}: ${sync.error}`); continue; }
    checked += sync.checked || 0;
    replies += sync.replies || 0;
    const followUps = await processDueFollowUps({ account });
    followUpsSent += followUps.sent || 0;
  }
  for (const device of devices) {
    const followUps = await processDueWhatsAppFollowUps({ device });
    whatsappFollowUps += followUps.sent || 0;
  }

  // Only a total email failure is an error — a WhatsApp-only setup has no
  // mailbox to fail, and one dead mailbox out of three is a warning, not a 502.
  if (accounts.length && errors.length === accounts.length && !devices.length) {
    throw createError(502, `Reply sync failed: ${errors.join("; ")}`);
  }

  const totalFollowUps = followUpsSent + whatsappFollowUps;
  res.json({
    success: true,
    message: `Checked ${checked} open thread(s) across ${accounts.length} mailbox(es): ${replies} new repl${replies === 1 ? "y" : "ies"}`
      + `${totalFollowUps ? `, ${totalFollowUps} follow-up(s) sent` : ""}`
      + `${errors.length ? ` — ${errors.length} mailbox(es) failed: ${errors.join("; ")}` : ""}.`,
    data: {
      sync: { checked, replies },
      followUps: { sent: totalFollowUps, email: followUpsSent, whatsapp: whatsappFollowUps },
      errors,
    },
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
      ? {
          startedBy: { select: { id: true, name: true, email: true } },
          messages: {
            orderBy: { createdAt: "asc" },
            include: { sentBy: { select: { id: true, name: true, email: true } } },
          },
        }
      : { messages: { orderBy: { createdAt: "desc" }, take: 1, select: { direction: true, kind: true, createdAt: true } } },
  });
  res.json({ success: true, data: { threads } });
});

/**
 * POST /api/outreach/threads/:id/follow-up — send one now, manually.
 *
 * Always goes out on the channel and identity the thread was opened with: the
 * mailbox that sent the first email, or the phone that sent the first message.
 * A chase arriving from a second identity reads as a different person.
 */
export const followUpNow = asyncHandler(async (req, res) => {
  const thread = await prisma.outreachThread.findUnique({
    where: { id: req.params.id },
    select: { accountId: true, waAccountId: true, channel: true },
  });
  if (!thread) throw createError(404, "Thread not found.");

  if (thread.channel === "WHATSAPP") {
    const device = await getWhatsAppAccount(thread.waAccountId || null);
    if (!device) throw createError(400, "The WhatsApp device this thread was sent from is no longer linked.");
    if (device.status !== "CONNECTED") {
      throw createError(400, `"${device.label}" is ${device.status.toLowerCase()} — reconnect it in Settings to send.`);
    }
    const result = await sendWhatsAppFollowUp({ device, threadId: req.params.id, sentBy: req.auth.user });
    if (!result.ok) throw createError(400, result.error);
    return res.json({ success: true, message: "WhatsApp follow-up sent.", data: { thread: result.thread } });
  }

  const account = await getAccount(thread.accountId || null);
  if (!account) throw createError(400, "The mailbox this thread was sent from is no longer connected.");
  const result = await sendFollowUp({ account, threadId: req.params.id, sentBy: req.auth.user });
  if (!result.ok) throw createError(400, result.error);
  res.json({ success: true, message: "Follow-up sent.", data: { thread: result.thread } });
});

export const replySchema = z.object({
  body: z.string().trim().min(1, "Write something to send.").max(8000),
  // Threads keep their subject unless you deliberately change it, so a reply
  // stays in the same conversation in the recipient's client.
  subject: z.string().trim().max(255).optional(),
  signatureId: z.string().max(64).nullable().optional(),
});

/**
 * POST /api/outreach/threads/:id/reply — write back by hand.
 *
 * Goes out from the mailbox the thread was opened with, never the default one:
 * a reply arriving from a different address breaks the conversation in the
 * recipient's client and reads as a stranger joining the thread.
 */
export const replyToThread = asyncHandler(async (req, res) => {
  const thread = await prisma.outreachThread.findUnique({
    where: { id: req.params.id },
    select: { accountId: true, channel: true },
  });
  if (!thread) throw createError(404, "Thread not found.");
  if (thread.channel !== "EMAIL") throw createError(400, "This is a WhatsApp thread — reply on that channel.");

  const account = await getAccount(thread.accountId || null);
  if (!account) throw createError(400, "The mailbox this thread was sent from is no longer connected.");

  const result = await sendReply({
    account, threadId: req.params.id,
    body: req.body.body, subject: req.body.subject, signatureId: req.body.signatureId,
    sentBy: req.auth.user,
  });
  if (!result.ok) throw createError(400, result.error);
  res.json({ success: true, message: "Reply sent.", data: { thread: result.thread } });
});

export const inboxQuerySchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]).optional(),
  bucket: z.enum(["replied", "due", "waiting", "silent", "closed"]).optional(),
});

/**
 * GET /api/outreach/inbox — the working queue: who replied, what is due, what
 * is still waiting. Counts are always for the whole set so the filter chips can
 * show totals even while one bucket is selected.
 */
export const inbox = asyncHandler(async (req, res) => {
  const { channel, bucket } = req.validatedQuery || {};
  res.json({ success: true, data: await outreachInbox({ channel: channel || null, bucket: bucket || null }) });
});

export const composeBatchSchema = z.object({
  leadIds: z.array(z.string().min(1).max(64)).min(1).max(50),
  runId: z.string().max(64).optional(),
});

// ─── WhatsApp: linked devices, QR pairing, status, sending ────────────────────
//
// Several phones can be linked at once. The singular /session, /status and
// /logout routes still work and act on the default device, so nothing that
// called them before this change has to be updated at once.

/** GET /api/outreach/whatsapp/accounts — every linked device with live state. */
export const listWhatsAppAccountInfo = asyncHandler(async (req, res) => {
  const accounts = await listWhatsAppAccounts();
  res.json({ success: true, data: { accounts: accounts.map(whatsappAccountStatus) } });
});

export const whatsappAccountSchema = z.object({
  label: z.string().trim().min(1).max(80),
});

/**
 * POST /api/outreach/whatsapp/accounts — register a device slot.
 *
 * The row is created before pairing because the credential folder is keyed by
 * its id; the phone number is learned from WhatsApp when the QR is scanned,
 * never typed in.
 */
export const createWhatsAppAccountHandler = asyncHandler(async (req, res) => {
  const account = await createWhatsAppAccount({ label: req.body.label });
  res.status(201).json({
    success: true,
    message: `"${account.label}" added. Scan its QR code to link a phone.`,
    data: { account: whatsappAccountStatus(account) },
  });
});

export const whatsappAccountUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  autoFollowUp: z.boolean().optional(),
  maxFollowUps: z.number().int().min(0).max(5).optional(),
  // Gaps in days before each chase. Ascending is not enforced — a [1, 14]
  // cadence is unusual but legitimate.
  followUpDays: z.array(z.number().int().min(1).max(90)).max(5).optional(),
});

/**
 * PUT /api/outreach/whatsapp/accounts/:id — rename a device, or change how it
 * chases. Pairing is untouched: none of these fields affect the credentials.
 */
export const updateWhatsAppAccountHandler = asyncHandler(async (req, res) => {
  const existing = await prisma.whatsAppAccount.findUnique({ where: { id: req.params.id } });
  if (!existing) throw createError(404, "Device not found.");

  const account = await prisma.whatsAppAccount.update({
    where: { id: existing.id },
    data: {
      ...(req.body.label !== undefined ? { label: req.body.label } : {}),
      ...(req.body.autoFollowUp !== undefined ? { autoFollowUp: req.body.autoFollowUp } : {}),
      ...(req.body.maxFollowUps !== undefined ? { maxFollowUps: req.body.maxFollowUps } : {}),
      ...(req.body.followUpDays !== undefined ? { followUpDays: req.body.followUpDays } : {}),
    },
  });
  res.json({ success: true, message: `"${account.label}" updated.`, data: { account: whatsappAccountStatus(account) } });
});

/** POST /api/outreach/whatsapp/accounts/:id/default */
export const setDefaultWhatsAppAccount = asyncHandler(async (req, res) => {
  const existing = await getWhatsAppAccount(req.params.id);
  if (!existing) throw createError(404, "WhatsApp device not found.");
  await applyWhatsAppDefault(existing.id);
  const account = await getWhatsAppAccount(existing.id);
  res.json({
    success: true,
    message: `"${account.label}" is now the default WhatsApp sender.`,
    data: { account: whatsappAccountStatus(account) },
  });
});

/** DELETE /api/outreach/whatsapp/accounts/:id — unlink and forget a device. */
export const deleteWhatsAppAccountHandler = asyncHandler(async (req, res) => {
  const existing = await getWhatsAppAccount(req.params.id);
  if (!existing) throw createError(404, "WhatsApp device not found.");
  await deleteWhatsAppAccount(existing.id);
  res.json({
    success: true,
    message: `"${existing.label}" unlinked. Its conversations are kept on the leads.`,
  });
});

export const whatsappSessionQuerySchema = z.object({
  forceNew: z.enum(["true", "false"]).optional(),
  accountId: z.string().max(64).optional(),
});

/**
 * GET /api/outreach/whatsapp/session — connect one device, or report on it.
 * Returns `connected` (+ user), `qr_required` (+ data-URL QR to scan),
 * `initializing`, or `disconnected`. `?forceNew=true` wipes that device's
 * pairing and mints a fresh QR.
 */
export const whatsappSession = asyncHandler(async (req, res) => {
  const { forceNew, accountId } = req.validatedQuery || {};
  const account = await getWhatsAppAccount(accountId || null);
  if (!account) throw createError(400, "Add a WhatsApp device in Settings before pairing.");
  const result = await checkSession(account.id, { forceNew: forceNew === "true" });
  res.json({ success: true, data: { ...result, accountId: account.id, label: account.label } });
});

/** GET /api/outreach/whatsapp/status — cheap poll across every device. */
export const whatsappStatusInfo = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await whatsappStatusAll() });
});

export const whatsappLogoutSchema = z.object({ accountId: z.string().max(64).optional() });

/** POST /api/outreach/whatsapp/logout — unpair one device, keep the row. */
export const whatsappLogoutHandler = asyncHandler(async (req, res) => {
  const account = await getWhatsAppAccount(req.body?.accountId || null);
  if (!account) throw createError(404, "No WhatsApp device to disconnect.");
  await logoutWhatsApp(account.id);
  res.json({ success: true, message: `"${account.label}" disconnected. Scan a new QR to pair it again.` });
});

export const whatsappSendSchema = z.object({
  leadId: z.string().min(1).max(64),
  phone: z.string().trim().min(7).max(30),
  message: z.string().trim().min(1).max(4000),
  /// Which linked device sends. Omitted = the default one.
  waAccountId: z.string().max(64).optional(),
  /// Sign-off to append, in its two-line chat form. Explicit null = none.
  signatureId: z.string().max(64).nullable().optional(),
});

/** POST /api/outreach/whatsapp/send */
export const whatsappSend = asyncHandler(async (req, res) => {
  const { leadId, phone, message, waAccountId, signatureId } = req.body;
  const result = await sendWhatsAppForLead({
    leadId, phone, message, waAccountId: waAccountId || null, signatureId,
    sentBy: req.auth.user,
  });
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
