import prisma from "../../prismaClient.js";
import { sendMail } from "./mailer.js";
import { findReplies, canReceive } from "./inbox.js";
import { recordBounce } from "./deliverability.js";
import { classifyAutoReply } from "./autoReply.js";
import { sendWhatsAppText, getWhatsAppAccount, listWhatsAppAccounts } from "./whatsapp.js";
import { resolveSignature, signatureSuffix } from "./signature.js";
import { toActor } from "./attribution.js";
import { followUpTemplate, whatsappFollowUpTemplate } from "../research/templates.js";
import { gatherFacts } from "../research/compose.js";
import { onInitialSent, onFollowUpSent, onReplyReceived, onFollowUpsExhausted } from "./leadStatus.js";
import { SERVICE_LABELS } from "../scoring/scoreEngine.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:service");

const ACTIVE = { status: { not: "DISABLED" } };

const DAY_MS = 86_400_000;

/**
 * When the next chase on this thread is due, or null when the sequence is spent.
 *
 * `followUpDays` is the gap *before* each follow-up: [3, 7] means chase 3 days
 * after the initial message, then 7 days after that one. Shared by email and
 * WhatsApp so both channels honour one definition of the cadence.
 *
 * @param {{followUpDays: unknown, maxFollowUps: number}} config
 * @param {number} followUpsSent how many chases have already gone out
 */
export const nextFollowUpDate = (config, followUpsSent = 0) => {
  const days = Array.isArray(config?.followUpDays) ? config.followUpDays : [3, 7];
  const max = Number.isFinite(config?.maxFollowUps) ? config.maxFollowUps : 2;
  if (followUpsSent >= max) return null;
  const gap = Number(days[followUpsSent]);
  return Number.isFinite(gap) && gap > 0 ? new Date(Date.now() + gap * DAY_MS) : null;
};

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
  // The same locked set the campaign builder uses. A follow-up used to check
  // only the first two, so a lead disqualified after the first email still got
  // chased three days later.
  if (["DO_NOT_CONTACT", "ARCHIVED", "DISQUALIFIED", "NOT_INTERESTED", "CONVERTED"].includes(lead.status)) {
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
export const sendWhatsAppForLead = async ({
  leadId, phone, message, waAccountId = null, signatureId = undefined, sentBy = null,
}) => {
  const actor = toActor(sentBy);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
  if (!lead) return { ok: false, error: "Lead not found." };

  const device = await getWhatsAppAccount(waAccountId);
  if (!device) return { ok: false, error: "No WhatsApp device is linked yet. Add one in Settings." };

  const blocked = await phoneSendIsBlocked({ lead, phone });
  if (blocked) return { ok: false, error: blocked };

  // The chat form of the signature: two lines, no rule. A formatted block in a
  // WhatsApp bubble reads as spam.
  const signature = await resolveSignature({ signatureId });
  const text = `${message}${signatureSuffix(message, signature, { channel: "WHATSAPP" })}`;

  const sent = await sendWhatsAppText({ accountId: device.id, phone, text });
  if (!sent.ok) return { ok: false, error: sent.error };

  const digits = String(phone).replace(/\D/g, "");
  // Scoped to the device: the same lead may be in conversation on two phones.
  const existing = await prisma.outreachThread.findFirst({
    where: {
      leadId, channel: "WHATSAPP", waAccountId: device.id,
      recipientEmail: { endsWith: digits.slice(-9) },
    },
  });

  let thread;
  if (existing) {
    // Messaging an open thread by hand *is* a follow-up, and it resets the
    // clock — the scheduler must not fire again three days after the original
    // message when a human already chased today. Messaging a thread that was
    // replied to or closed starts a fresh round instead.
    const isManualFollowUp = existing.status === "AWAITING_REPLY";
    const followUpsSent = isManualFollowUp ? existing.followUpsSent + 1 : 0;

    await prisma.outreachMessage.create({
      data: {
        threadId: existing.id, direction: "OUTBOUND",
        kind: isManualFollowUp ? "FOLLOW_UP" : "INITIAL",
        subject: "WhatsApp message", body: text.slice(0, 8000),
        messageId: sent.messageId, sentAt: new Date(),
        sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
      },
    });
    thread = await prisma.outreachThread.update({
      where: { id: existing.id },
      data: {
        status: "AWAITING_REPLY",
        lastOutboundAt: new Date(),
        followUpsSent,
        nextFollowUpAt: nextFollowUpDate(device, followUpsSent),
      },
    });
  } else {
    thread = await prisma.outreachThread.create({
      data: {
        leadId, channel: "WHATSAPP", waAccountId: device.id,
        recipientEmail: digits, subject: `WhatsApp — ${lead.company.name}`.slice(0, 255),
        status: "AWAITING_REPLY", lastOutboundAt: new Date(),
        nextFollowUpAt: nextFollowUpDate(device, 0),
        startedById: actor?.id ?? null, startedByName: actor?.name ?? null,
        messages: {
          create: {
            direction: "OUTBOUND", kind: "INITIAL",
            subject: "WhatsApp message", body: text.slice(0, 8000),
            messageId: sent.messageId, sentAt: new Date(),
            sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
          },
        },
      },
    });
  }

  await onInitialSent({
    leadId, currentStatus: lead.status, channel: "WHATSAPP",
    recipient: digits, via: device.label,
  });

  logger.info({ leadId, phone: digits, threadId: thread.id, sentBy: actor?.id || "system", nextFollowUpAt: thread.nextFollowUpAt }, "WhatsApp outreach sent");
  return { ok: true, thread };
};

/**
 * Send the initial pitch for a lead and open a tracked thread.
 * Marks the lead CONTACTED and schedules the first follow-up.
 */
export const sendInitialEmail = async ({
  account, leadId, to, subject, body, draftId = null, signatureId = undefined, sentBy = null,
}) => {
  const actor = toActor(sentBy);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { company: true } });
  if (!lead) return { ok: false, error: "Lead not found." };

  const blocked = await sendIsBlocked({ lead, recipientEmail: to });
  if (blocked) return { ok: false, error: blocked };

  const signature = await resolveSignature({ signatureId, account });
  const sent = await sendMail({ account, to, subject, body, signature });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  const nextFollowUpAt = nextFollowUpDate(account, 0);

  const thread = await prisma.outreachThread.create({
    data: {
      leadId, accountId: account.id,
      recipientEmail: to, subject: subject.slice(0, 255),
      status: "AWAITING_REPLY",
      lastOutboundAt: new Date(),
      nextFollowUpAt,
      startedById: actor?.id ?? null, startedByName: actor?.name ?? null,
      messages: {
        create: {
          direction: "OUTBOUND", kind: "INITIAL",
          subject: subject.slice(0, 255), body: (sent.text || body).slice(0, 8000),
          messageId: sent.messageId, draftId, sentAt: new Date(),
          sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
        },
      },
    },
    include: { messages: true },
  });

  await onInitialSent({
    leadId, currentStatus: lead.status, channel: "EMAIL",
    recipient: to, via: account.email,
  });

  logger.info({ leadId, to, threadId: thread.id, sentBy: actor?.id || "system", nextFollowUpAt }, "outreach email sent");
  return { ok: true, thread };
};

/**
 * Send one follow-up on a thread (manual click or the scheduler).
 *
 * `sentBy` is null when the scheduler fires it, and that null is meaningful:
 * the thread then reads "sent automatically" rather than crediting the chase to
 * whoever happened to open the first email.
 */
export const sendFollowUp = async ({ account, threadId, sentBy = null }) => {
  const actor = toActor(sentBy);
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
  // Facts give the chase something new to say; a lead that vanished mid-thread
  // still gets the factless variant rather than an error.
  const gathered = await gatherFacts(thread.lead.id).catch(() => null);
  const { body } = followUpTemplate({
    company: thread.lead.company,
    serviceLabel,
    serviceKey: thread.lead.primaryOpportunity,
    followUpNumber,
    facts: gathered?.facts || [],
  });

  const lastOutbound = [...thread.messages].reverse().find((m) => m.direction === "OUTBOUND");
  const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;

  // A follow-up signs off the same way the initial email did, so the thread
  // reads as one person rather than two.
  const signature = await resolveSignature({ account });
  const sent = await sendMail({
    account, to: thread.recipientEmail, subject, body, signature,
    inReplyTo: lastOutbound?.messageId || null,
    references: thread.messages.filter((m) => m.direction === "OUTBOUND" && m.messageId).map((m) => m.messageId),
  });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  const nextFollowUpAt = nextFollowUpDate(account, followUpNumber);

  await prisma.outreachMessage.create({
    data: {
      threadId, direction: "OUTBOUND", kind: "FOLLOW_UP",
      subject: subject.slice(0, 255), body: (sent.text || body).slice(0, 8000),
      messageId: sent.messageId, generatedBy: "RULE", sentAt: new Date(),
      sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
    },
  });
  const updated = await prisma.outreachThread.update({
    where: { id: threadId },
    data: { followUpsSent: followUpNumber, lastOutboundAt: new Date(), nextFollowUpAt },
  });

  await onFollowUpSent({
    leadId: thread.leadId, channel: "EMAIL",
    followUpNumber, recipient: thread.recipientEmail,
  });
  if (!nextFollowUpAt) {
    await onFollowUpsExhausted({ leadId: thread.leadId, channel: "EMAIL", recipient: thread.recipientEmail });
  }

  logger.info({ threadId, followUpNumber, nextFollowUpAt }, "follow-up sent");
  return { ok: true, thread: updated };
};

/**
 * Write back into a conversation by hand, as many times as the exchange needs.
 *
 * The difference from `sendFollowUp` is not the transport but the authorship: a
 * follow-up is a generated chase the scheduler is also allowed to send, capped
 * by `maxFollowUps` and counted. This is a person typing, so it is uncapped,
 * never counted as a chase, and always attributed to whoever sent it. Replying
 * to someone who has already answered is the normal case, not an edge one —
 * that is the whole point of not having to open the mailbox.
 *
 * Sending by hand also **stops the automated chase** on that thread. Once a
 * person is in the conversation, a robot sending "just circling back" three
 * days later over the top of a live exchange is the worst thing the system
 * could do, so `nextFollowUpAt` is cleared and the thread goes back to
 * awaiting *their* reply.
 */
export const sendReply = async ({ account, threadId, body, subject = null, signatureId = undefined, sentBy = null }) => {
  const actor = toActor(sentBy);
  const text = String(body || "").trim();
  if (!text) return { ok: false, error: "Write something to send." };

  const thread = await prisma.outreachThread.findUnique({
    where: { id: threadId },
    include: { lead: { include: { company: true } }, messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!thread) return { ok: false, error: "Thread not found." };
  if (thread.channel !== "EMAIL") return { ok: false, error: "This is a WhatsApp thread — reply on that channel." };
  // A bounced address is not a conversation, it is a dead mailbox: sending
  // again would earn a second bounce on a domain that already paid for one.
  if (thread.status === "BOUNCED") {
    return { ok: false, error: "The last message to this address bounced — fix or replace the address first." };
  }

  const blocked = await sendIsBlocked({ lead: thread.lead, recipientEmail: thread.recipientEmail });
  if (blocked) return { ok: false, error: blocked };

  // Thread against the newest message in the conversation whichever way it
  // travelled: replying to their reply is what keeps our message inside the
  // same conversation in their client, rather than starting a second one.
  const newest = [...thread.messages].reverse().find((m) => m.messageId);
  const references = thread.messages.map((m) => m.messageId).filter(Boolean);

  const finalSubject = (subject?.trim() || (thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`)).slice(0, 255);
  const signature = await resolveSignature({ signatureId, account });

  const sent = await sendMail({
    account, to: thread.recipientEmail, subject: finalSubject, body: text, signature,
    inReplyTo: newest?.messageId || null,
    references,
  });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  await prisma.outreachMessage.create({
    data: {
      threadId, direction: "OUTBOUND", kind: "REPLY",
      subject: finalSubject, body: (sent.text || text).slice(0, 8000),
      // generatedBy stays null: nothing generated this. ParserUsed names the
      // machine that wrote a message, and a person typing is not one of them.
      messageId: sent.messageId, sentAt: new Date(),
      sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
    },
  });

  const updated = await prisma.outreachThread.update({
    where: { id: threadId },
    data: {
      // Back to waiting on them, with no scheduled chase behind it.
      status: "AWAITING_REPLY",
      lastOutboundAt: new Date(),
      nextFollowUpAt: null,
      subject: finalSubject,
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        include: { sentBy: { select: { id: true, name: true, email: true } } },
      },
    },
  });

  logger.info({ threadId, to: thread.recipientEmail, sentBy: actor?.id || "system" }, "manual reply sent");
  return { ok: true, thread: updated };
};

/**
 * Send one WhatsApp follow-up on a thread. The email twin above, minus the
 * reply-chain headers WhatsApp has no equivalent of — continuity there comes
 * from the chat itself, so the message just has to be short and human.
 */
export const sendWhatsAppFollowUp = async ({ device, threadId, sentBy = null }) => {
  const actor = toActor(sentBy);
  const thread = await prisma.outreachThread.findUnique({
    where: { id: threadId },
    include: { lead: { include: { company: true } } },
  });
  if (!thread) return { ok: false, error: "Thread not found." };
  if (thread.channel !== "WHATSAPP") return { ok: false, error: "Not a WhatsApp thread." };
  if (thread.status !== "AWAITING_REPLY") return { ok: false, error: `Thread is ${thread.status.toLowerCase()} — no follow-up needed.` };
  if (thread.followUpsSent >= device.maxFollowUps) return { ok: false, error: "Follow-up limit reached for this thread." };

  const blocked = await phoneSendIsBlocked({ lead: thread.lead, phone: thread.recipientEmail });
  if (blocked) return { ok: false, error: blocked };

  const followUpNumber = thread.followUpsSent + 1;
  const serviceLabel = SERVICE_LABELS[thread.lead.primaryOpportunity] || "software development";
  const gathered = await gatherFacts(thread.lead.id).catch(() => null);
  const { body } = whatsappFollowUpTemplate({
    company: thread.lead.company,
    serviceLabel,
    serviceKey: thread.lead.primaryOpportunity,
    followUpNumber,
    facts: gathered?.facts || [],
  });

  // The same sign-off the first message used, so the chat reads as one person.
  const signature = await resolveSignature({});
  const text = `${body}${signatureSuffix(body, signature, { channel: "WHATSAPP" })}`;

  const sent = await sendWhatsAppText({ accountId: device.id, phone: thread.recipientEmail, text });
  if (!sent.ok) return { ok: false, error: `Sending failed: ${sent.error}` };

  const nextFollowUpAt = nextFollowUpDate(device, followUpNumber);

  await prisma.outreachMessage.create({
    data: {
      threadId, direction: "OUTBOUND", kind: "FOLLOW_UP",
      subject: "WhatsApp follow-up", body: text.slice(0, 8000),
      messageId: sent.messageId, generatedBy: "RULE", sentAt: new Date(),
      sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
    },
  });
  const updated = await prisma.outreachThread.update({
    where: { id: threadId },
    data: { followUpsSent: followUpNumber, lastOutboundAt: new Date(), nextFollowUpAt },
  });

  await onFollowUpSent({
    leadId: thread.leadId, channel: "WHATSAPP",
    followUpNumber, recipient: thread.recipientEmail,
  });
  if (!nextFollowUpAt) {
    await onFollowUpsExhausted({ leadId: thread.leadId, channel: "WHATSAPP", recipient: thread.recipientEmail });
  }

  logger.info({ threadId, followUpNumber, nextFollowUpAt }, "WhatsApp follow-up sent");
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
    include: {
      messages: { where: { direction: "OUTBOUND" }, select: { messageId: true } },
      lead: { select: { id: true, status: true, company: { select: { domains: { select: { domain: true }, take: 1 } } } } },
    },
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
  let bounces = 0;
  let autoReplies = 0;
  for (const hit of hits) {
    const exists = hit.messageId
      ? await prisma.outreachMessage.findFirst({ where: { messageId: hit.messageId } })
      : null;
    if (exists) continue;

    const thread = open.find((t) => t.id === hit.threadId);
    if (!thread) continue;

    // A non-delivery report is not an answer. It reaches this loop matched to
    // the thread by the very Message-ID it is reporting on, so without this
    // branch a dead address would mark the thread REPLIED and hand the lead to
    // a human as if somebody had written back.
    if (hit.bounce?.isBounce) {
      const recorded = await recordBounce({ threadId: hit.threadId, hit, classification: hit.bounce });
      if (recorded) bounces += 1;
      continue;
    }

    // Neither is a machine's acknowledgement. A help desk's "your request has
    // been received" and an out-of-office both carry our Message-ID in
    // In-Reply-To, so they match the thread exactly as a person's answer would.
    // Recorded on the thread for the record, but the thread stays open, the
    // follow-ups stay scheduled and the lead does not move to REPLIED.
    const auto = classifyAutoReply({
      from: hit.from, subject: hit.subject, body: hit.snippet || "", headers: hit.headers || "",
      companyDomain: thread.lead?.company?.domains?.[0]?.domain || null,
    });
    if (auto.isAutoReply) {
      await recordAutoReply({ thread, hit, auto });
      autoReplies += 1;
      continue;
    }

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
    // Moves Lead.status itself, not just the timeline. Until this call existed
    // a replied-to lead still read as CONTACTED everywhere outside the thread.
    await onReplyReceived({
      leadId: thread.leadId, channel: "EMAIL",
      from: hit.from, snippet: hit.snippet || hit.subject,
    });
    replies += 1;
  }

  await prisma.emailAccount.update({
    where: { id: account.id },
    data: { lastSyncAt: new Date(), status: "CONNECTED", lastError: null },
  });
  logger.info({ checked: open.length, replies, bounces, autoReplies }, "reply sync complete");
  return { checked: open.length, replies, bounces, autoReplies };
};

/**
 * Store a machine's answer without treating it as one.
 *
 * Two cases, told apart by who sent it. An out-of-office from the person we
 * wrote to changes nothing: they will read the message when they are back,
 * and the next follow-up lands then. A ticket acknowledgement from a
 * third-party platform — Menufy's support desk answering for a restaurant —
 * means the address was never the business's at all: it is suppressed so no
 * follow-up chases a ticket queue, the thread is closed, and the lead is
 * handed back with a note saying a real contact is still needed.
 */
const recordAutoReply = async ({ thread, hit, auto }) => {
  await prisma.outreachMessage.create({
    data: {
      threadId: thread.id, direction: "INBOUND", kind: "AUTO_REPLY",
      subject: (hit.subject || "").slice(0, 255),
      body: `[${auto.reason}]\n\n${hit.snippet || ""}`.slice(0, 8000),
      messageId: hit.messageId || null,
      fromAddress: hit.from, receivedAt: hit.date,
    },
  });

  const platform = auto.platform;
  if (!platform) {
    logger.info({ threadId: thread.id, kind: auto.kind, from: hit.from }, "auto-reply recorded — thread left open");
    return;
  }

  // The address reaches a platform's queue, not the business.
  const recipient = thread.recipientEmail.toLowerCase();
  const reason = `Answered by ${platform.domain}'s ticket system (${auto.kind}) — a ${platform.label}, not the business.`;
  await prisma.suppressionEntry.upsert({
    where: { kind_value: { kind: "EMAIL", value: recipient } },
    create: { kind: "EMAIL", value: recipient, reason: reason.slice(0, 500) },
    update: { reason: reason.slice(0, 500) },
  });
  await prisma.contact.updateMany({ where: { kind: "EMAIL", value: { equals: recipient, mode: "insensitive" } }, data: { isSuppressed: true } });
  await prisma.outreachThread.update({
    where: { id: thread.id },
    data: { status: "CLOSED", nextFollowUpAt: null },
  });
  if (thread.lead) {
    await prisma.leadStatusHistory.create({
      data: {
        leadId: thread.lead.id, fromStatus: thread.lead.status, toStatus: thread.lead.status,
        note: `${reason} ${recipient} suppressed and the thread closed. The business still needs a real contact — try the owner's own address, phone or a social profile.`.slice(0, 1000),
      },
    });
  }
  logger.warn({ threadId: thread.id, recipient, platform: platform.domain }, "auto-reply from a third-party platform — address suppressed, thread closed");
};

/**
 * How a failed scheduled send is handled.
 *
 * The distinction matters: a suppressed contact must never be retried, but a
 * mailbox that was briefly unreachable — or a WhatsApp socket reconnecting —
 * must not silently cost the lead its whole follow-up sequence. Cancelling on
 * every failure is what the first version of this did, and it meant one flaky
 * minute quietly ended outreach to that company for good.
 */
const TRANSIENT_PATTERNS = [
  /not connected/i,
  /timed?\s?-?\s?out/i,
  /econn|enotfound|eai_again|epipe|etimedout/i,
  /socket|network|unreachable/i,
  /temporar|try again|rate.?limit|too many/i,
  /\b4\.\d\.\d\b/, // SMTP 4.x.x — transient by definition
];

/** Give up retrying a thread that has been stuck this long; something is wrong. */
const RETRY_WINDOW_MS = 14 * DAY_MS;
const RETRY_GAP_MS = 60 * 60 * 1000;

/**
 * When to try this thread again after a failed send, or null to stop trying.
 * @param {string} error the failure message from the sender
 * @param {Date|null} lastOutboundAt when we last successfully sent on this thread
 */
export const retryAfterFailure = (error, lastOutboundAt) => {
  const transient = TRANSIENT_PATTERNS.some((re) => re.test(String(error || "")));
  if (!transient) return null;
  // Bounded so an unpaired device or a dead mailbox cannot retry forever.
  const since = lastOutboundAt ? Date.now() - new Date(lastOutboundAt).getTime() : 0;
  if (since > RETRY_WINDOW_MS) return null;
  return new Date(Date.now() + RETRY_GAP_MS);
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
      const nextFollowUpAt = retryAfterFailure(res.error, thread.lastOutboundAt);
      await prisma.outreachThread.update({ where: { id: thread.id }, data: { nextFollowUpAt } });
      logger.warn(
        { threadId: thread.id, msg: res.error, retryAt: nextFollowUpAt },
        nextFollowUpAt ? "scheduled follow-up deferred" : "scheduled follow-up cancelled",
      );
    }
  }
  return { sent, due: due.length };
};

/**
 * The WhatsApp twin of processDueFollowUps.
 *
 * Kept separate rather than generalised because the two channels genuinely
 * differ: email chases are matched to a mailbox by `accountId` and can be sent
 * through any relay, while WhatsApp chases can only leave through the one
 * paired device that opened the thread — and only while that device's socket is
 * actually connected. Sending into a dead socket would burn the follow-up.
 */
export const processDueWhatsAppFollowUps = async ({ device, force = false }) => {
  if (!device.autoFollowUp && !force) return { sent: 0, skipped: "auto follow-up disabled" };
  if (device.status !== "CONNECTED") return { sent: 0, skipped: `device is ${device.status.toLowerCase()}` };

  const due = await prisma.outreachThread.findMany({
    where: {
      waAccountId: device.id,
      channel: "WHATSAPP",
      status: "AWAITING_REPLY",
      nextFollowUpAt: { not: null, lte: new Date() },
      followUpsSent: { lt: device.maxFollowUps },
    },
    take: 20,
  });
  let sent = 0;
  for (const thread of due) {
    const res = await sendWhatsAppFollowUp({ device, threadId: thread.id });
    if (res.ok) sent += 1;
    else {
      const nextFollowUpAt = retryAfterFailure(res.error, thread.lastOutboundAt);
      await prisma.outreachThread.update({ where: { id: thread.id }, data: { nextFollowUpAt } });
      logger.warn(
        { threadId: thread.id, msg: res.error, retryAt: nextFollowUpAt },
        nextFollowUpAt ? "scheduled WhatsApp follow-up deferred" : "scheduled WhatsApp follow-up cancelled",
      );
    }
  }
  return { sent, due: due.length };
};

/**
 * One pass of the outreach automation across every channel: pull replies first
 * (so a thread that was answered an hour ago never gets a follow-up), then send
 * what is due. One failing mailbox or device never stops the rest.
 *
 * WhatsApp needs no reply-pulling step — its socket pushes incoming messages
 * into handleIncoming the moment they land, so by the time this runs the
 * replied threads have already had their follow-ups cancelled.
 */
export const runOutreachMaintenance = async () => {
  const [accounts, devices] = await Promise.all([listAccounts(), listWhatsAppAccounts()]);
  if (!accounts.length && !devices.length) return { skipped: "no email account or WhatsApp device connected" };

  const perAccount = [];
  let replies = 0;
  let bounces = 0;
  let sent = 0;
  for (const account of accounts) {
    const sync = await syncReplies({ account });
    replies += sync.replies || 0;
    bounces += sync.bounces || 0;
    const followUps = sync.error ? { sent: 0, skipped: "sync failed" } : await processDueFollowUps({ account });
    sent += followUps.sent || 0;
    perAccount.push({ channel: "EMAIL", accountId: account.id, email: account.email, sync, followUps });
  }

  let whatsappSent = 0;
  for (const device of devices) {
    const followUps = await processDueWhatsAppFollowUps({ device }).catch((err) => {
      logger.warn({ deviceId: device.id, msg: err.message }, "WhatsApp follow-up pass failed");
      return { sent: 0, error: err.message };
    });
    whatsappSent += followUps.sent || 0;
    perAccount.push({ channel: "WHATSAPP", accountId: device.id, label: device.label, followUps });
  }

  return {
    accounts: accounts.length,
    devices: devices.length,
    replies,
    bounces,
    followUpsSent: sent + whatsappSent,
    emailFollowUps: sent,
    whatsappFollowUps: whatsappSent,
    perAccount,
  };
};

// ─── Inbox: what actually needs a human today ────────────────────────────────

/**
 * A thread carries just enough of its lead to render a row without a second
 * round-trip: who it is, how hot, and the last thing either side said.
 */
const INBOX_SELECT = {
  id: true,
  leadId: true,
  channel: true,
  recipientEmail: true,
  subject: true,
  status: true,
  lastOutboundAt: true,
  repliedAt: true,
  followUpsSent: true,
  nextFollowUpAt: true,
  updatedAt: true,
  // Who opened the conversation. The snapshot is the fallback for a thread
  // whose owner has since been deleted, and for one sent before attribution.
  startedById: true,
  startedByName: true,
  startedBy: { select: { id: true, name: true, email: true } },
  account: { select: { email: true } },
  waAccount: { select: { label: true } },
  lead: {
    select: {
      id: true,
      score: true,
      status: true,
      primaryOpportunity: true,
      company: { select: { name: true, city: true, countryCode: true } },
    },
  },
  messages: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      direction: true, kind: true, body: true, subject: true, createdAt: true,
      sentByName: true, sentBy: { select: { id: true, name: true, email: true } },
    },
  },
};

/**
 * Where a thread belongs in the day's work.
 *
 * Derived rather than stored, because every input already exists and a stored
 * bucket would be one more thing that can go stale. The order matters: a thread
 * is tested against these top to bottom and takes the first that fits.
 *
 *   replied → they answered and nobody has decided anything yet. Yours to act on.
 *   due     → the chase is scheduled for now or earlier.
 *   waiting → sent, chase is booked for later. Nothing to do.
 *   silent  → every chase spent, still nothing. Needs a different angle, not another email.
 *   closed  → done with, one way or another.
 */
export const bucketFor = (thread, now = new Date()) => {
  if (thread.status === "REPLIED") {
    // Once a human has judged the lead the reply is no longer an open question.
    return thread.lead?.status === "REPLIED" ? "replied" : "closed";
  }
  if (thread.status === "BOUNCED" || thread.status === "CLOSED") return "closed";
  if (thread.nextFollowUpAt && thread.nextFollowUpAt <= now) return "due";
  if (thread.nextFollowUpAt) return "waiting";
  return thread.followUpsSent > 0 ? "silent" : "waiting";
};

const BUCKET_ORDER = ["replied", "due", "waiting", "silent", "closed"];

/**
 * Everything the Inbox screen renders, in one query.
 *
 * Sorted so the most valuable unanswered thing is first: replies before chases,
 * then by lead score. A 500-thread ceiling keeps this a single fast read — this
 * is a working queue, not an archive, and anything past that is in All leads.
 */
export const outreachInbox = async ({ channel = null, bucket = null } = {}) => {
  const threads = await prisma.outreachThread.findMany({
    where: channel ? { channel } : {},
    orderBy: { updatedAt: "desc" },
    take: 500,
    select: INBOX_SELECT,
  });

  const now = new Date();
  const withBucket = threads.map((t) => ({ ...t, bucket: bucketFor(t, now) }));

  const counts = Object.fromEntries(BUCKET_ORDER.map((b) => [b, 0]));
  for (const t of withBucket) counts[t.bucket] += 1;

  const visible = (bucket ? withBucket.filter((t) => t.bucket === bucket) : withBucket).sort((a, b) => {
    const rank = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
    if (rank !== 0) return rank;
    if (a.bucket === "replied") return (b.repliedAt?.getTime() || 0) - (a.repliedAt?.getTime() || 0);
    if (a.bucket === "due") return (a.nextFollowUpAt?.getTime() || 0) - (b.nextFollowUpAt?.getTime() || 0);
    return (b.lead?.score || 0) - (a.lead?.score || 0);
  });

  // Whether any automation is actually armed. Without this the UI cannot tell
  // "nothing is due" from "nothing will ever be sent because it is all off".
  const [autoEmail, autoWhatsApp, connectedDevices] = await Promise.all([
    prisma.emailAccount.count({ where: { ...ACTIVE, autoFollowUp: true } }),
    prisma.whatsAppAccount.count({ where: { autoFollowUp: true, status: "CONNECTED" } }),
    prisma.whatsAppAccount.count({ where: { status: "CONNECTED" } }),
  ]);

  return {
    counts,
    threads: visible,
    automation: {
      emailAccountsAutoFollowUp: autoEmail,
      whatsappDevicesAutoFollowUp: autoWhatsApp,
      whatsappDevicesConnected: connectedDevices,
    },
  };
};
