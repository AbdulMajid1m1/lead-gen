import prisma from "../../prismaClient.js";
import { setStatus } from "../scoring/scoreEngine.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:lead-status");

/**
 * What an outreach event means for the lead's status.
 *
 * Email and WhatsApp both funnel through here so the two channels can never
 * drift into disagreeing about what "contacted" or "replied" means. Before this
 * existed, a reply wrote a LeadStatusHistory row and left Lead.status untouched
 * — the timeline said one thing and the list view said another.
 *
 * The rules are deliberately few:
 *
 *   we sent the first message  → CONTACTED
 *   we chased with a follow-up → FOLLOW_UP
 *   they answered             → REPLIED
 *
 * Everything past REPLIED is a human judgement (INTERESTED, CONVERTED,
 * NOT_INTERESTED) and automation never makes it.
 */

/**
 * Statuses automation must not overwrite.
 *
 * The first three are decisions a person made about this lead; the last three
 * are compliance states. A reply arriving on a DO_NOT_CONTACT lead is still
 * recorded as a message — it just must not quietly reopen the lead.
 */
const LOCKED = new Set([
  "INTERESTED",
  "CONVERTED",
  "NOT_INTERESTED",
  "DISQUALIFIED",
  "ARCHIVED",
  "DO_NOT_CONTACT",
]);

/** Statuses that already mean "we have reached out" — an initial send is a no-op. */
const ALREADY_CONTACTED = new Set(["CONTACTED", "FOLLOW_UP", "REPLIED"]);

/**
 * Move a lead to `toStatus` unless a human has already put it somewhere that
 * outranks automation. Never throws: a status update failing must not lose the
 * message that triggered it.
 *
 * @returns {Promise<boolean>} whether the status actually moved
 */
const advance = async (leadId, toStatus, note) => {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true } });
    if (!lead) return false;
    if (LOCKED.has(lead.status)) {
      logger.debug({ leadId, status: lead.status, toStatus }, "status locked by a human decision — left alone");
      return false;
    }
    if (lead.status === toStatus) return false;
    await setStatus(leadId, toStatus, note);
    logger.info({ leadId, from: lead.status, to: toStatus }, "lead status advanced by outreach");
    return true;
  } catch (err) {
    logger.warn({ leadId, toStatus, msg: err.message }, "lead status update failed");
    return false;
  }
};

/** First message out on any channel. */
export const onInitialSent = async ({ leadId, currentStatus, channel, recipient, via }) => {
  if (LOCKED.has(currentStatus) || ALREADY_CONTACTED.has(currentStatus)) return false;
  const label = channel === "WHATSAPP" ? "WhatsApp message" : "Email";
  return advance(leadId, "CONTACTED", `${label} sent to ${recipient}${via ? ` via ${via}` : ""}.`);
};

/**
 * A follow-up went out. FOLLOW_UP rather than CONTACTED so the list view can
 * distinguish "sent once" from "chased twice and still nothing".
 */
export const onFollowUpSent = async ({ leadId, channel, followUpNumber, recipient }) => {
  const label = channel === "WHATSAPP" ? "WhatsApp follow-up" : "Follow-up";
  return advance(leadId, "FOLLOW_UP", `${label} #${followUpNumber} sent to ${recipient}.`);
};

/**
 * They answered. This is the event the whole status layer exists for — it is
 * the only one that hands the lead back to a person.
 */
export const onReplyReceived = async ({ leadId, channel, from, snippet }) => {
  const label = channel === "WHATSAPP" ? "WhatsApp reply" : "Reply";
  const quoted = snippet ? `: "${String(snippet).replace(/\s+/g, " ").trim().slice(0, 120)}"` : "";
  return advance(leadId, "REPLIED", `${label} received from ${from}${quoted}`);
};

/**
 * Every chase is spent and nobody answered. Left at FOLLOW_UP rather than
 * inventing a dead-end status: the lead is still workable by phone or a fresh
 * angle later, and the Inbox surfaces it as "exhausted" from thread state.
 */
export const onFollowUpsExhausted = async ({ leadId, channel, recipient }) => {
  const label = channel === "WHATSAPP" ? "WhatsApp" : "Email";
  return advance(leadId, "FOLLOW_UP", `${label} sequence finished with no reply from ${recipient}.`);
};

export { LOCKED as LOCKED_STATUSES };
