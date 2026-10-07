/**
 * Tell a "no" from an answer.
 *
 * Every email we send ends "Not relevant? Reply "no" and I will not write
 * again." Until this existed nothing kept that promise. A reply moved the
 * thread to REPLIED and stopped its follow-ups, but REPLIED is not a locked
 * status and nothing reached the suppression list, so the only thing between
 * the person and our next campaign was the 30-day second-first-contact guard.
 * The two real cases, both from the dental lane:
 *
 *   - TAHA Dental Excellence, 3 Oct 2026: "Unsubscribe".
 *   - Syston Chiropractic Clinic, 1 Oct 2026: "No thank you. I'm happy as I am.."
 *
 * Two verdicts, because they mean different things to a person reading the
 * book later. UNSUBSCRIBE is an objection to being emailed at all (PECR and
 * CAN-SPAM both say it must be honoured); DECLINE is "not for us". Both
 * suppress the address — we told them a "no" would end it.
 *
 * Only the person's own words are read: the quoted copy of our email below
 * their answer contains "Reply "no"" and would match every reply otherwise.
 *
 * The bar is set for precision on DECLINE. "No problem, send it over" and
 * "No worries — what does it cost?" are interested people, so a leading "no"
 * only counts when it stands alone or comes with thanks.
 */

/** Where the quoted original starts, in the shapes Gmail, Outlook and Apple Mail write. */
const QUOTE_STARTS = [
  /^\s*>/m,
  /^\s*On\b[^\n]{0,200}(?:\n[^\n]{0,200})?\bwrote:\s*$/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*From:\s[^\n]+\n\s*(?:Sent|Date):/im,
  /^\s*_{8,}\s*$/m,
  /^\s*Le\b[^\n]{0,200}\ba écrit\s*:\s*$/m,
  /^\s*Am\b[^\n]{0,200}\bschrieb[^\n]*:\s*$/m,
];

/** The part of a reply the person typed, above anything quoted. */
export const freshText = (body) => {
  const text = String(body || "").replace(/\r\n?/g, "\n");
  let cut = text.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
};

/** An objection to being contacted at all. Decisive on its own. */
const UNSUBSCRIBE_RES = [
  /\bun-?subscribe\b/i,
  /\bremove (?:me|us|my (?:e-?mail|address|details|name)|our (?:e-?mail|address|details))\b/i,
  /\b(?:take|strike) (?:me|us) off\b/i,
  /\bopt(?:ed|ing)?[\s-]?out\b/i,
  /\bstop (?:e-?mailing|contacting|messaging|sending|writing|spamming)\b/i,
  /\b(?:do not|don'?t|never) (?:e-?mail|contact|message|write to|send (?:me|us)) (?:me|us|again|this)/i,
  /\bno (?:more|further) (?:e-?mails?|messages?|contact)\b/i,
  /\bdelete (?:my|our) (?:details|data|e-?mail|address)\b/i,
  /^\s*stop\s*[.!]*\s*$/i,
];

/** "Not for us." Read only in the person's own words; see the note above. */
const DECLINE_RES = [
  /^\s*no\s*[.!]*\s*$/i,
  /^\s*(?:no|nope)\b[\s,.!-]*(?:thank(?:s| you)|ta|cheers)\b/i,
  /\bno,? thank(?:s| you)\b/i,
  /^\s*no\s*[,.!-]+\s*(?:we|i)(?:'re|'m| are| am)\s+(?:happy|fine|ok|okay|good|sorted|all set|set)\b/i,
  /\b(?:i'?m|i am|we'?re|we are)\s+not\s+interested\b/i,
  /^\s*not interested\b/i,
  /^\s*not (?:relevant|for us|needed|required)\b/i,
  /\b(?:we|i)(?:'re|'m| are| am) (?:not|no longer) looking\b/i,
  /\b(?:i'?m|i am|we'?re|we are) (?:happy|fine|sorted) (?:as (?:i|we) (?:am|are)|with (?:our|my|what (?:we|i)) )/i,
];

/**
 * @param {{body?: string}} input  the inbound message as stored (quotes and all)
 * @returns {{isOptOut: boolean, kind: "UNSUBSCRIBE"|"DECLINE"|null, phrase: string|null}}
 */
export const classifyOptOut = ({ body = "" } = {}) => {
  const fresh = freshText(body).slice(0, 600);
  if (!fresh) return { isOptOut: false, kind: null, phrase: null };
  for (const re of UNSUBSCRIBE_RES) {
    const m = re.exec(fresh);
    if (m) return { isOptOut: true, kind: "UNSUBSCRIBE", phrase: m[0].trim() };
  }
  for (const re of DECLINE_RES) {
    const m = re.exec(fresh);
    if (m) return { isOptOut: true, kind: "DECLINE", phrase: m[0].trim() };
  }
  return { isOptOut: false, kind: null, phrase: null };
};
