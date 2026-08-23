import prisma from "../../prismaClient.js";

/**
 * Sign-off rendering.
 *
 * One Signature row renders three ways, because the three places it appears
 * have genuinely different constraints:
 *
 *   · renderSignatureHtml — the styled block in the email's HTML part. Table
 *     layout and inline styles only: Outlook ignores <style> blocks and most
 *     of flexbox, and every serious email client strips external CSS.
 *   · renderSignatureText — the plain-text part, and what the composer shows
 *     in its textarea. What the recipient sees if their client refuses HTML.
 *   · renderSignatureWhatsApp — two lines, no rule, no separator. A formatted
 *     block in a chat bubble reads as spam.
 *
 * The text form is the one the user edits and sends, so it is deliberately the
 * source of truth: the HTML part is built from the *same* row, not parsed back
 * out of the textarea.
 */

/** Bare host for display, full URL for the href. */
const siteParts = (website) => {
  if (!website) return null;
  const bare = String(website).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!bare) return null;
  return { bare, href: `https://${bare}` };
};

/** Minimal HTML escaping — signature fields are user input that lands in markup. */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A hex colour we are willing to interpolate into a style attribute. */
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || "")) ? c : "#4f39f6");

/**
 * The plain-text sign-off.
 *
 * Plain URLs, never markdown link syntax — the same rule the email templates
 * follow, because a raw `[text](url)` in an inbox looks broken.
 */
export const renderSignatureText = (sig) => {
  if (!sig) return "";
  const site = siteParts(sig.website);
  const lines = [
    sig.fullName,
    [sig.title, sig.company].filter(Boolean).join(", "),
    site ? site.href : null,
    sig.email,
    sig.phone,
    sig.tagline,
  ].filter(Boolean);
  return lines.join("\n");
};

/** Two lines for a chat bubble: who, and where to find them. */
export const renderSignatureWhatsApp = (sig) => {
  if (!sig) return "";
  const site = siteParts(sig.website);
  const who = [sig.fullName, sig.title].filter(Boolean).join(" · ");
  return [who, site ? site.href : null].filter(Boolean).join("\n");
};

/**
 * The styled block for the HTML part.
 *
 * Table-based and inline-styled on purpose (see the module note). Colours are
 * fixed rather than theme-derived: an email is rendered by someone else's
 * client, which knows nothing about our CSS variables.
 */
export const renderSignatureHtml = (sig) => {
  if (!sig) return "";
  const accent = safeColor(sig.accentColor);
  const site = siteParts(sig.website);

  const roleLine = [sig.title, sig.company].filter(Boolean).map(esc).join(
    ` <span style="color:#9aa0ac;">·</span> `,
  );

  const contactBits = [
    site ? `<a href="${esc(site.href)}" style="color:${accent};text-decoration:none;">${esc(site.bare)}</a>` : null,
    sig.email ? `<a href="mailto:${esc(sig.email)}" style="color:${accent};text-decoration:none;">${esc(sig.email)}</a>` : null,
    sig.phone ? `<span style="color:#5b6170;">${esc(sig.phone)}</span>` : null,
  ].filter(Boolean);

  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">`,
    `<tr><td style="padding:0 0 12px 0;"><div style="width:44px;height:3px;background:${accent};border-radius:2px;"></div></td></tr>`,
    `<tr><td style="padding:0;">`,
    `<div style="font-size:15px;font-weight:600;color:#12141a;line-height:1.4;">${esc(sig.fullName)}</div>`,
    roleLine
      ? `<div style="font-size:13px;color:#5b6170;line-height:1.5;margin-top:2px;">${roleLine}</div>`
      : "",
    contactBits.length
      ? `<div style="font-size:13px;line-height:1.6;margin-top:6px;">${contactBits.join(` <span style="color:#c3c7d1;">|</span> `)}</div>`
      : "",
    sig.tagline
      ? `<div style="font-size:12px;color:#9aa0ac;line-height:1.5;margin-top:8px;">${esc(sig.tagline)}</div>`
      : "",
    `</td></tr></table>`,
  ].filter(Boolean).join("");
};

/**
 * Wrap a plain-text body into an HTML email.
 *
 * Blank-line-separated blocks become paragraphs, single newlines become <br> —
 * the shape the composer's textarea implies. Bare URLs are linkified, because
 * the templates emit plain URLs and an unlinked one in an HTML part is a dead
 * end for the reader.
 */
export const bodyToHtml = (body) => {
  const linkify = (text) =>
    esc(text).replace(
      /\bhttps?:\/\/[^\s<>"']+/g,
      (url) => `<a href="${url}" style="color:#4f39f6;">${url}</a>`,
    );

  const paragraphs = String(body || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p style="margin:0 0 14px 0;">${linkify(block).replace(/\n/g, "<br>")}</p>`);

  return paragraphs.join("");
};

/**
 * The pre-Signature freeform `EmailAccount.signature` string, rendered as a
 * plain block. No structure to work with, so it gets typography and nothing
 * else — enough that a mailbox set up before Signature rows existed still
 * produces a tidy HTML part.
 */
const legacyBlockHtml = (text) =>
  text
    ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e6e8ee;font-size:13px;line-height:1.6;color:#5b6170;white-space:pre-line;">${esc(text)}</div>`
    : "";

/** The full HTML document for an outreach email. */
export const buildEmailHtml = ({ body, signature = null, legacyText = null }) =>
  [
    `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">`,
    `<div style="max-width:600px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`,
    `font-size:15px;line-height:1.6;color:#22252d;padding:8px 0;">`,
    bodyToHtml(body),
    signature ? renderSignatureHtml(signature) : legacyBlockHtml(legacyText),
    `</div></body></html>`,
  ].join("");

// ─── Selection ────────────────────────────────────────────────────────────────

export const listSignatures = () =>
  prisma.signature.findMany({ orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

/**
 * Which sign-off an email actually gets.
 *
 * Explicit choice wins, then the mailbox's own default, then the global
 * default. `signatureId: null` passed explicitly means "no signature" and is
 * honoured — it is the only way to send an unsigned email once one is set up.
 */
export const resolveSignature = async ({ signatureId = undefined, account = null } = {}) => {
  if (signatureId === null) return null;
  if (signatureId) {
    const chosen = await prisma.signature.findUnique({ where: { id: signatureId } });
    if (chosen) return chosen;
  }
  if (account?.signatureId) {
    const own = await prisma.signature.findUnique({ where: { id: account.signatureId } });
    if (own) return own;
  }
  return prisma.signature.findFirst({ where: { isDefault: true } });
};

/**
 * The text appended to the body at send time.
 *
 * Returns "" when the body already ends with this signature — the composer
 * shows the sign-off inline so the user can edit it, which means it usually
 * arrives here already attached. Appending it a second time is the obvious
 * failure mode and this is where it is prevented.
 */
export const signatureSuffix = (body, signature, { channel = "EMAIL" } = {}) => {
  const text = channel === "WHATSAPP" ? renderSignatureWhatsApp(signature) : renderSignatureText(signature);
  if (!text) return "";
  const normalise = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
  if (normalise(body).endsWith(normalise(text))) return "";
  return `\n\n${text}`;
};
