import prisma from "../../prismaClient.js";
import { sendMail } from "./mailer.js";
import { findReplies, canReceive } from "./inbox.js";
import { sendWhatsAppText } from "./whatsapp.js";
import { followUpTemplate } from "../research/templates.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:service");

const ACTIVE = { status: { not: "DISABLED" } };

/** Every usable mailbox, default first, then oldest first. */
export const listAccounts = () =>
  prisma.emailAccount.findMany({ where: ACTIVE, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

/**
 * Resolve the mailbox to send from: the one asked for by id, else the default,
 * else the oldest connected one. Returns null when nothing is connected — or
 * when a specific id was asked for and it is not a usable account.
 */
export const getAccount = async (accountId = null) => {
  if (accountId) return prisma.emailAccount.findFirst({ where: { id: accountId, ...ACTIVE } });
  return (
    (await prisma.emailAccount.findFirst({ where: { isDefault: true, ...ACTIVE } })) ||
    prisma.emailAccount.findFirst({ where: ACTIVE, orderBy: { createdAt: "asc" } })
  );
};

const domainOf = (email) => String(email).split("@")[1]?.toLowerCase() || "";

/**
 * The compliance gate. Every send — initial, follow-up, manual or automated —
 * goes through here.
 */
export const sendIsBlocked = async ({ lead, recipientEmail }) => {
  if (["DO_NOT_CONTACT", "ARCHIVED"].includes(lead.status)) {
    return `Lead status is ${lead.status}.`;
  }
  const suppressed = await prisma.suppressionEntry.findFirst({
    where: {
      OR: [
        { kind: "EMAIL", value: { equals: recipientEmail, mode: "insensitive" } },
        { kind: "DOMAIN", value: { equals: domainOf(recipientEmail), mode: "insensitive" } },
      ],
    },
  });
  if (suppressed) return `${recipientEmail} is on the suppression list (${suppressed.kind.toLowerCase()}).`;
  const contact = await prisma.contact.findFirst({
    where: { companyId: lead.companyId, kind: "EMAIL", value: { equals: recipientEmail, mode: "insensitive" } },
  });
  if (contact?.isSuppressed) return "This contact is suppressed.";
  return null;
};

/** Phone-side compliance gate, mirroring the email one. */
export const phoneSendIsBlocked = async ({ lead, phone }) => {
  if (["DO_NOT_CONTACT", "ARCHIVED"].includes(lead.status)) {
    return `Lead status is ${lead.status}.`;
  }
  const digits = String(phone).replace(/\D/g, "");
  const tail = digits.slice(-9);
  const matches = (value) => value.replace(/\D/g, "").endsWith(tail);

  const suppressed = await prisma.suppressionEntry.findMany({ where: { kind: "PHONE" }, select: { value: true } });
  if (suppressed.some((s) => matches(s.value))) return `${phone} is on the suppression list.`;

  const suppressedContacts = await prisma.contact.findMany({
    where: { companyId: lead.companyId, kind: "PHONE", isSuppressed: true },
    select: { value: true },
  });
  if (suppressedContacts.some((c) => matches(c.value))) return "This contact is suppressed.";
  return null;
};

/**
 * Send a WhatsApp message for a lead and open (or extend) a tracked thread.
 * Same lifecycle as email: lead goes CONTACTED, replies land in the thread.
 */
export const sendWhatsAppForLead = async ({ leadId, phone, message }) => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
  if (!lead) return { ok: false, error: "Lead not found." };

  const blocked = await phoneSendIsBlocked({ lead, phone });
  if (blocked) return { ok: false, error: blocked };

  const sent = await sendWhatsAppText({ phone, text: message });
  if (!sent.ok) return { ok: false, error: sent.error };

  const digits = String(phone).replace(/\D/g, "");
  const existing = await prisma.outreachThread.findFirst({
    where: { leadId, channel: "WHATSAPP", recipientEmail: { endsWith: digits.slice(-9) } },
  });

  let thread;
  if (existing) {
    await prisma.outreachMessage.create({
      data: {
        threadId: existing.id, direction: "OUTBOUND",
        kind: existing.status === "AWAITING_REPLY" ? "FOLLOW_UP" : "INITIAL",
        subject: "WhatsApp message", body: message.slice(0, 8000),
        messageId: sent.messageId, sentAt: new Date(),
      },
    });
    thread = await prisma.outreachThread.update({
      where: { id: existing.id },
      data: { status: "AWAITING_REPLY", lastOutboundAt: new Date() },
    });
  } else {
    thread = await prisma.outreachThread.create({
      data: {
        leadId, channel: "WHATSAPP",
        recipientEmail: digits, subject: `WhatsApp — ${lead.company.name}`.slice(0, 255),
        status: "AWAITING_REPLY", lastOutboundAt: new Date(),
        messages: {
          create: {
            direction: "OUTBOUND", kind: "INITIAL",
            subject: "WhatsApp message", body: message.slice(0, 8000),
            messageId: sent.messageId, sentAt: new Date(),
          },
        },
      },
    });
  }

  if (!["CONTACTED", "FOLLOW_UP", "INTERESTED", "CONVERTED"].includes(lead.status)) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: "CONTACTED" } });
    await prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: lead.status, toStatus: "CONTACTED", note: `WhatsApp message sent to ${digits}.` },
    });
  }

  logger.info({ leadId, phone: digits, threadId: thread.id }, "WhatsApp outreach sent");
  return { ok: true, thread };
};

/**
 * Send the initial pitch for a lead and open a tracked thread.
 * Marks the lead CONTACTED and schedules the first follow-up.
 */
export const sendInitialEmail = async ({ account, leadId, to, subject, body, draftId = null }) => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
  if (!lead) return { ok: false, error: "Lead not found." };

  const blocked = await sendIsBlocked({ lead, recipientEmail: to });
  if (blocked) return { ok: false, error: blocked };

  const sent = await sendMail({ account, to, subject, body });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  const followUpDays = Array.isArray(account.followUpDays) ? account.followUpDays : [3, 7];
  const nextFollowUpAt = account.maxFollowUps > 0 && followUpDays[0]
    ? new Date(Date.now() + followUpDays[0] * 86_400_000)
    : null;

  const thread = await prisma.outreachThread.create({
    data: {
      leadId, accountId: account.id,
      recipientEmail: to, subject: subject.slice(0, 255),
      status: "AWAITING_REPLY",
      lastOutboundAt: new Date(),
      nextFollowUpAt,
      messages: {
        create: {
          direction: "OUTBOUND", kind: "INITIAL",
          subject: subject.slice(0, 255), body: body.slice(0, 8000),
          messageId: sent.messageId, draftId, sentAt: new Date(),
        },
      },
    },
    include: { messages: true },
  });

  if (!["CONTACTED", "FOLLOW_UP", "INTERESTED", "CONVERTED"].includes(lead.status)) {
    await prisma.lead.update({ where: { id: leadId }, data: { status: "CONTACTED" } });
    await prisma.leadStatusHistory.create({
      data: { leadId, fromStatus: lead.status, toStatus: "CONTACTED", note: `Email sent to ${to} via ${account.email}.` },
    });
  }

  logger.info({ leadId, to, threadId: thread.id }, "outreach email sent");
  return { ok: true, thread };
};

/** Send one follow-up on a thread (manual click or the scheduler). */
export const sendFollowUp = async ({ account, threadId }) => {
  const thread = await prisma.outreachThread.findUnique({
    where: { id: threadId },
    include: { lead: { include: { company: true } }, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!thread) return { ok: false, error: "Thread not found." };
  if (thread.status !== "AWAITING_REPLY") return { ok: false, error: `Thread is ${thread.status.toLowerCase()} — no follow-up needed.` };
  if (thread.followUpsSent >= account.maxFollowUps) return { ok: false, error: "Follow-up limit reached for this thread." };

  const blocked = await sendIsBlocked({ lead: thread.lead, recipientEmail: thread.recipientEmail });
  if (blocked) return { ok: false, error: blocked };

  const followUpNumber = thread.followUpsSent + 1;
  const serviceLabel = SERVICE_LABELS[thread.lead.primaryOpportunity] || "software development";
  const { body } = followUpTemplate({ company: thread.lead.company, serviceLabel, followUpNumber });

  const lastOutbound = [...thread.messages].reverse().find((m) => m.direction === "OUTBOUND");
  const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;

  const sent = await sendMail({
    account, to: thread.recipientEmail, subject, body,
    inReplyTo: lastOutbound?.messageId || null,
    references: thread.messages.filter((m) => m.direction === "OUTBOUND" && m.messageId).map((m) => m.messageId),
  });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  const followUpDays = Array.isArray(account.followUpDays) ? account.followUpDays : [3, 7];
  const nextGapDays = followUpDays[followUpNumber] || null;

  await prisma.outreachMessage.create({
    data: {
      threadId, direction: "OUTBOUND", kind: "FOLLOW_UP",
      subject: subject.slice(0, 255), body: body.slice(0, 8000),
      messageId: sent.messageId, generatedBy: "RULE", sentAt: new Date(),
    },
  });
  const updated = await prisma.outreachThread.update({
    where: { id: threadId },
    data: {
      followUpsSent: followUpNumber,
      lastOutboundAt: new Date(),
      nextFollowUpAt: followUpNumber < account.maxFollowUps && nextGapDays
        ? new Date(Date.now() + nextGapDays * 86_400_000)
        : null,
    },
  });

  logger.info({ threadId, followUpNumber }, "follow-up sent");
  return { ok: true, thread: updated };
};

/**
 * Poll the mailbox for replies to open threads. Called by the sync button and
 * by the worker on a schedule.
 */
export const syncReplies = async ({ account }) => {
  if (!canReceive(account)) return { checked: 0, replies: 0, skipped: "send-only mailbox — no inbox to poll" };

  const open = await prisma.outreachThread.findMany({
    where: { accountId: account.id, status: "AWAITING_REPLY" },
    include: { messages: { where: { direction: "OUTBOUND" }, select: { messageId: true } } },
  });
  if (!open.length) {
    await prisma.emailAccount.update({ where: { id: account.id }, data: { lastSyncAt: new Date(), lastError: null } });
    return { checked: 0, replies: 0 };
  }

  // Overlap the window by a day so a reply landing mid-sync is never missed.
  const since = account.lastSyncAt
    ? new Date(account.lastSyncAt.getTime() - 86_400_000)
    : new Date(Date.now() - 30 * 86_400_000);

  let hits;
  try {
    hits = await findReplies({
      account,
      since,
      threads: open.map((t) => ({
        id: t.id,
        recipientEmail: t.recipientEmail,
        messageIds: t.messages.map((m) => m.messageId).filter(Boolean),
      })),
    });
  } catch (err) {
    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { status: "ERROR", lastError: String(err.message).slice(0, 500) },
    });
    return { checked: open.length, replies: 0, error: err.message };
  }

  let replies = 0;
  for (const hit of hits) {
    const exists = hit.messageId
      ? await prisma.outreachMessage.findFirst({ where: { messageId: hit.messageId } })
      : null;
    if (exists) continue;

    const thread = open.find((t) => t.id === hit.threadId);
    if (!thread) continue;

    await prisma.outreachMessage.create({
      data: {
        threadId: hit.threadId, direction: "INBOUND", kind: "REPLY",
        subject: (hit.subject || "").slice(0, 255),
        body: (hit.snippet || "(reply detected — open your inbox for the full message)").slice(0, 8000),
        messageId: hit.messageId || null,
        fromAddress: hit.from, receivedAt: hit.date,
      },
    });
    await prisma.outreachThread.update({
      where: { id: hit.threadId },
      data: { status: "REPLIED", repliedAt: hit.date, nextFollowUpAt: null },
    });
    await prisma.leadStatusHistory.create({
      data: {
        leadId: thread.leadId, fromStatus: null, toStatus: "FOLLOW_UP",
        note: `Reply received from ${hit.from}: "${(hit.snippet || hit.subject || "").slice(0, 120)}"`,
      },
    });
    replies += 1;
  }

  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { lastSyncAt: new Date(), status: "CONNECTED", lastError: null },
  });
  logger.info({ checked: open.length, replies }, "reply sync complete");
  return { checked: open.length, replies };
};

/** Send every follow-up that has come due. Respects the account toggle. */
export const processDueFollowUps = async ({ account, force = false }) => {
  if (!account.autoFollowUp && !force) return { sent: 0, skipped: "auto follow-up disabled" };
  const due = await prisma.outreachThread.findMany({
    where: {
      accountId: account.id,
      status: "AWAITING_REPLY",
      nextFollowUpAt: { not: null, lte: new Date() },
      followUpsSent: { lt: account.maxFollowUps },
    },
    take: 20,
  });
  let sent = 0;
  for (const thread of due) {
    const res = await sendFollowUp({ account, threadId: thread.id });
    if (res.ok) sent += 1;
    else {
      // A blocked or failed thread must not be retried forever.
      await prisma.outreachThread.update({ where: { id: thread.id }, data: { nextFollowUpAt: null } });
      logger.warn({ threadId: thread.id, msg: res.error }, "scheduled follow-up skipped");
    }
  }
  return { sent, due: due.length };
};

/**
 * One pass of the outreach automation across every connected mailbox: pull
 * replies first (so a thread that was answered an hour ago never gets a
 * follow-up), then send what is due. One failing mailbox never stops the rest.
 */
export const runOutreachMaintenance = async () => {
  const accounts = await listAccounts();
  if (!accounts.length) return { skipped: "no email account connected" };

  const perAccount = [];
  let replies = 0;
  let sent = 0;
  for (const account of accounts) {
    const sync = await syncReplies({ account });
    replies += sync.replies || 0;
    const followUps = sync.error ? { sent: 0, skipped: "sync failed" } : await processDueFollowUps({ account });
    sent += followUps.sent || 0;
    perAccount.push({ accountId: account.id, email: account.email, sync, followUps });
  }
  return { accounts: perAccount.length, replies, followUpsSent: sent, perAccount };
};
