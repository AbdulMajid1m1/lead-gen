import { ImapFlow } from "imapflow";
import { log } from "../../utils/logger.js";

const logger = log("outreach:inbox");

/**
 * IMAP reply detection. One pass over INBOX since a given date, matching each
 * message against the open threads by In-Reply-To/References (strong match) or
 * by sender address (fallback — the recipient replied with a fresh email).
 */

/**
 * Whether this account has an inbox to poll at all. Send-only accounts (an
 * API relay such as Resend, with no mailbox behind it) have no IMAP host —
 * their replies land wherever the address forwards to, which can be tracked
 * by pointing imapHost/imapUser at that mailbox instead.
 */
export const canReceive = (account) => Boolean(account?.imapHost && account?.imapPort);

/** The IMAP login: an explicit user when set, otherwise the From address. */
export const imapLogin = (account) => account.imapUser || account.email;

const buildClient = (account) =>
  new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: imapLogin(account), pass: account.imapPassword || account.authPassword },
    logger: false,
  });

/** Verify IMAP credentials by logging in and opening INBOX. */
export const verifyImap = async (account) => {
  if (!canReceive(account)) return { ok: true, skipped: "send-only account — no inbox configured" };
  const client = buildClient(account);
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
    return { ok: true };
  } catch (err) {
    logger.warn({ email: account.email, msg: err.message }, "IMAP verify failed");
    return { ok: false, error: err.message };
  } finally {
    await client.logout().catch(() => {});
  }
};

const normalizeMsgId = (id) => String(id || "").trim().replace(/^<|>$/g, "");

/**
 * Scan INBOX for replies to the given threads.
 *
 * @param threads array of { id, recipientEmail, messageIds: string[] } — the
 *   outbound Message-IDs of each thread.
 * @returns array of { threadId, from, subject, date, messageId, inReplyTo, snippet }
 */
export const findReplies = async ({ account, threads, since }) => {
  if (!threads.length || !canReceive(account)) return [];
  const client = buildClient(account);
  const found = [];

  const ourAddresses = new Set(
    [account.email, account.smtpUser, account.imapUser, account.replyTo]
      .filter((a) => a && a.includes("@"))
      .map((a) => a.toLowerCase()),
  );

  const byMsgId = new Map();
  const byAddress = new Map();
  for (const t of threads) {
    for (const mid of t.messageIds) byMsgId.set(normalizeMsgId(mid), t.id);
    byAddress.set(t.recipientEmail.toLowerCase(), t.id);
  }

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const range = await client.search({ since });
      if (!range?.length) return [];

      for await (const msg of client.fetch(range, { envelope: true, headers: ["in-reply-to", "references"] })) {
        const env = msg.envelope || {};
        const fromAddr = env.from?.[0]?.address?.toLowerCase() || "";
        const headerText = msg.headers ? msg.headers.toString() : "";
        const refIds = [...headerText.matchAll(/<([^>]+)>/g)].map((m) => m[1]);

        let threadId = refIds.map((id) => byMsgId.get(id)).find(Boolean) || null;
        if (!threadId && byAddress.has(fromAddr)) threadId = byAddress.get(fromAddr);
        if (!threadId) continue;
        // Our own copy — the From address, and the mailbox we are reading if
        // it is a different one (a forwarded domain alias, say).
        if (ourAddresses.has(fromAddr)) continue;

        found.push({
          threadId,
          seq: msg.seq,
          from: fromAddr,
          subject: env.subject || "",
          date: env.date || new Date(),
          messageId: normalizeMsgId(env.messageId),
          snippet: null,
        });
      }

      // Pull a short text snippet for each hit (best effort).
      for (const hit of found) {
        try {
          const { content } = await client.download(hit.seq, "1", { maxBytes: 4096 });
          const chunks = [];
          for await (const chunk of content) chunks.push(chunk);
          hit.snippet = Buffer.concat(chunks).toString("utf8")
            .replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
        } catch {
          hit.snippet = null;
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    logger.error({ email: account.email, msg: err.message }, "reply scan failed");
    throw err;
  } finally {
    await client.logout().catch(() => {});
  }

  return found;
};
