import nodemailer from "nodemailer";
import { buildEmailHtml, signatureSuffix } from "./signature.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:mailer");

/**
 * SMTP sending for a connected account. Gmail works with an app password
 * (smtp.gmail.com:465); any SMTP provider with the same shape works too —
 * Resend, for instance, logs in as the literal user "resend" with an API key,
 * which is why the login is stored separately from the From address.
 */

/** The SMTP login: an explicit user when set, otherwise the From address. */
export const smtpLogin = (account) => account.smtpUser || account.email;

export const buildTransport = (account) =>
  nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    auth: { user: smtpLogin(account), pass: account.authPassword },
  });

/** Verify SMTP credentials without sending anything. */
export const verifySmtp = async (account) => {
  const transport = buildTransport(account);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    logger.warn({ email: account.email, msg: err.message }, "SMTP verify failed");
    return { ok: false, error: err.message };
  } finally {
    transport.close();
  }
};

/**
 * Send one email as multipart text + HTML.
 *
 * Both parts carry the same sign-off from the same Signature row: the text part
 * gets `renderSignatureText`, the HTML part the styled block. Sending text-only
 * would mean the styled signature never renders; sending HTML-only would break
 * for clients set to plain text, so both go out and the client picks.
 *
 * The body itself arrives *without* a signature — the composer keeps the two
 * separate so the sign-off can be swapped without editing the message. The
 * `signatureSuffix` dedupe still guards the case where one was pasted in.
 *
 * Returns the RFC Message-ID the message went out with, which is what reply
 * detection later matches In-Reply-To against.
 */
export const sendMail = async ({
  account, to, subject, body, signature = null, inReplyTo = null, references = [],
}) => {
  const transport = buildTransport(account);
  try {
    // A mailbox configured before Signature rows existed still has its freeform
    // string; it is the fallback when no structured signature was resolved.
    const legacyText = signature ? null : account.signature || null;
    const text = signature
      ? `${body}${signatureSuffix(body, signature)}`
      : legacyText ? `${body}\n\n${legacyText}` : body;

    const info = await transport.sendMail({
      from: account.displayName ? `"${account.displayName}" <${account.email}>` : account.email,
      to,
      subject,
      text,
      html: buildEmailHtml({ body, signature, legacyText }),
      ...(account.replyTo ? { replyTo: account.replyTo } : {}),
      ...(inReplyTo ? { inReplyTo, references: [...references, inReplyTo] } : {}),
    });
    // `text` comes back so the caller can store exactly what was sent — the
    // thread history should match the recipient's inbox, signature included.
    return { ok: true, messageId: info.messageId, text };
  } catch (err) {
    logger.error({ from: account.email, to, msg: err.message }, "send failed");
    return { ok: false, error: err.message };
  } finally {
    transport.close();
  }
};
