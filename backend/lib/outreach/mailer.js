import nodemailer from "nodemailer";
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
 * Send one plain-text email. Returns the RFC Message-ID the message went out
 * with, which is what reply detection later matches In-Reply-To against.
 */
export const sendMail = async ({ account, to, subject, body, inReplyTo = null, references = [] }) => {
  const transport = buildTransport(account);
  try {
    const text = account.signature ? `${body}\n\n${account.signature}` : body;
    const info = await transport.sendMail({
      from: account.displayName ? `"${account.displayName}" <${account.email}>` : account.email,
      to,
      subject,
      text,
      ...(account.replyTo ? { replyTo: account.replyTo } : {}),
      ...(inReplyTo ? { inReplyTo, references: [...references, inReplyTo] } : {}),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ from: account.email, to, msg: err.message }, "send failed");
    return { ok: false, error: err.message };
  } finally {
    transport.close();
  }
};
