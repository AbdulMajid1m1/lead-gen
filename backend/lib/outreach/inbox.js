import { ImapFlow } from "imapflow";
import { classifyBounce } from "./deliverability.js";
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

/** Header text with continuation lines joined, so one header is one line. */
const unfoldHeaders = (text) => String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");

/** Every value of one header, by name. Repeated headers all come back. */
const headerValues = (text, name) =>
  unfoldHeaders(text)
    .split("\n")
    .filter((line) => line.toLowerCase().startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim());

/**
 * Download one MIME part as text. Best effort by design: a part that is missing
 * or unreadable must leave the scan running, not end it.
 */
const downloadPart = async (client, seq, part, maxBytes) => {
  try {
    const { content } = await client.download(seq, part, { maxBytes });
    const chunks = [];
    for await (const chunk of content) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
};

/**
 * Scan INBOX for replies to the given threads.
 *
 * A non-delivery report is matched here too, and deliberately not as a reply: a
 * bounce from MAILER-DAEMON carries the original Message-ID in In-Reply-To, so
 * before it was classified it matched a thread by the same strong match a real
 * answer does — marking the thread REPLIED, pushing the lead into the "someone
 * answered you" queue, and inflating the reply rate with dead addresses.
 *
 * @param threads array of { id, recipientEmail, messageIds: string[] } — the
 *   outbound Message-IDs of each thread.
 * @returns array of { threadId, from, subject, date, messageId, inReplyTo,
 *   snippet, bounce } — `bounce` is null on a real reply, otherwise the
 *   classifyBounce result.
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

      // content-type and return-path are what identify a delivery-status report;
      // the reply chain is still read from in-reply-to/references alone.
      const headerBySeq = new Map();
      for await (const msg of client.fetch(range, {
        envelope: true,
        headers: ["in-reply-to", "references", "content-type", "return-path", "x-failed-recipients"],
      })) {
        const env = msg.envelope || {};
        const fromAddr = env.from?.[0]?.address?.toLowerCase() || "";
        const headerText = msg.headers ? msg.headers.toString() : "";
        const chainText = [...headerValues(headerText, "in-reply-to"), ...headerValues(headerText, "references")].join(" ");
        const refIds = [...chainText.matchAll(/<([^>]+)>/g)].map((m) => m[1]);

        let threadId = refIds.map((id) => byMsgId.get(id)).find(Boolean) || null;
        if (!threadId && byAddress.has(fromAddr)) threadId = byAddress.get(fromAddr);
        if (!threadId) continue;
        // Our own copy — the From address, and the mailbox we are reading if
        // it is a different one (a forwarded domain alias, say).
        if (ourAddresses.has(fromAddr)) continue;

        headerBySeq.set(msg.seq, headerText);
        found.push({
          threadId,
          seq: msg.seq,
          from: fromAddr,
          subject: env.subject || "",
          date: env.date || new Date(),
          messageId: normalizeMsgId(env.messageId),
          snippet: null,
          bounce: null,
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

        try {
          const headers = headerBySeq.get(hit.seq) || "";
          const first = classifyBounce({ from: hit.from, subject: hit.subject, body: hit.snippet || "", headers });
          if (!first.isBounce) continue;

          // The status code and the failing address live in the delivery-status
          // part, which is part 2 of a multipart/report and therefore outside
          // the human-readable snippet above. Without it every bounce would
          // fall back to the ambiguous default and nothing would be suppressed.
          const report = await downloadPart(client, hit.seq, "2", 4096);
          const detailed = report
            ? classifyBounce({ from: hit.from, subject: hit.subject, body: `${hit.snippet || ""}\n${report}`, headers })
            : null;
          hit.bounce = detailed?.isBounce ? detailed : first;
        } catch (err) {
          // An unreadable report is not a reason to lose the whole scan; the
          // hit stays a reply, which is how it was handled before this existed.
          logger.warn({ email: account.email, seq: hit.seq, msg: err.message }, "bounce classification failed");
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
