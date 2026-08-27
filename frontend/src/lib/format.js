import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs) => twMerge(clsx(inputs));

export const SERVICE_LABELS = {
  WEBSITE_DEV: "Website development",
  CRM_DEV: "CRM development",
  MOBILE_APP: "Mobile app",
  AI_AUTOMATION: "AI automation",
  ECOMMERCE_DEV: "E-commerce",
  SAAS_DEV: "SaaS development",
  CUSTOM_SOFTWARE: "Custom software",
  HR_SOFTWARE: "HR software",
};

export const LEAD_TYPE_LABELS = {
  TECH_DEBT: "Technical debt",
  HIRING_INTENT: "Hiring intent",
  NEW_BUSINESS: "New business",
  DIGITAL_GAP: "Digital gap",
  EXPANSION: "Expansion",
};

export const STATUS_LABELS = {
  NEW: "New",
  QUALIFIED: "Qualified",
  CONTACTED: "Contacted",
  FOLLOW_UP: "Follow up",
  REPLIED: "Replied",
  INTERESTED: "Interested",
  CONVERTED: "Converted",
  NOT_INTERESTED: "Not interested",
  DISQUALIFIED: "Disqualified",
  ARCHIVED: "Archived",
  DO_NOT_CONTACT: "Do not contact",
};

/**
 * Status colour carries one meaning only: whose move is it?
 *
 * Accent = yours, right now (they replied). Positive = going well. Caution =
 * waiting on them. Neutral = nothing owed by anyone. Critical = stop.
 * Everything else on the page defers to this, so a scan of the list finds the
 * accent rows first without reading a word.
 */
export const STATUS_TONE = {
  NEW: "var(--text-subtle)",
  QUALIFIED: "var(--color-info)",
  CONTACTED: "var(--color-caution)",
  FOLLOW_UP: "var(--color-caution)",
  REPLIED: "var(--accent)",
  INTERESTED: "var(--color-positive)",
  CONVERTED: "var(--color-positive)",
  NOT_INTERESTED: "var(--text-subtle)",
  DISQUALIFIED: "var(--text-subtle)",
  ARCHIVED: "var(--text-subtle)",
  DO_NOT_CONTACT: "var(--color-critical)",
};

/**
 * The Inbox buckets, in the order they are worked. `blurb` is what the empty
 * state says — phrased as reassurance, since an empty bucket here is good news.
 */
export const INBOX_BUCKETS = {
  replied: {
    label: "Needs reply",
    tone: "var(--accent)",
    hint: "They answered. Nobody has decided anything yet.",
    blurb: "No unanswered replies. Everything anyone sent you has been dealt with.",
  },
  due: {
    label: "Follow-up due",
    tone: "var(--color-caution)",
    hint: "The next chase is scheduled for now or earlier.",
    blurb: "Nothing is due. The next chase will appear here when its day arrives.",
  },
  waiting: {
    label: "Waiting",
    tone: "var(--color-info)",
    hint: "Sent, no reply yet, next chase already booked.",
    blurb: "Nothing is in flight. Send a first message from a lead to start a thread.",
  },
  silent: {
    label: "Went quiet",
    tone: "var(--text-subtle)",
    hint: "Every follow-up spent and still no reply — worth a different angle, not another email.",
    blurb: "No dead ends. Every thread is either live or resolved.",
  },
  closed: {
    label: "Closed",
    tone: "var(--text-subtle)",
    hint: "Replied and judged, bounced, or closed out.",
    blurb: "Nothing closed out yet.",
  },
};

/**
 * Client-book vocabulary.
 *
 * Status colour answers the same question it does on the lead side — is
 * anything owed here? Positive = work is running. Neutral = delivered and
 * quiet, which is the normal resting state of a past client and must not look
 * like a problem. Caution = paused and worth a nudge. Subtle = deliberately out
 * of sight.
 */
export const CLIENT_STATUS_LABELS = {
  ACTIVE: "Active",
  PAST: "Past client",
  ON_HOLD: "On hold",
  ARCHIVED: "Archived",
};

export const CLIENT_STATUS_HINTS = {
  ACTIVE: "Work is running right now.",
  PAST: "Delivered, nothing live — still worth a check-in.",
  ON_HOLD: "Paused by them or by us.",
  ARCHIVED: "Hidden from the list and never suggested for a check-in.",
};

export const CLIENT_STATUS_TONE = {
  ACTIVE: "var(--color-positive)",
  PAST: "var(--color-info)",
  ON_HOLD: "var(--color-caution)",
  ARCHIVED: "var(--text-subtle)",
};

export const PROJECT_STATUS_LABELS = {
  IN_PROGRESS: "In progress",
  DELIVERED: "Delivered",
  MAINTENANCE: "Maintenance",
  ON_HOLD: "On hold",
  CANCELLED: "Cancelled",
};

export const PROJECT_STATUS_TONE = {
  IN_PROGRESS: "var(--accent)",
  DELIVERED: "var(--color-positive)",
  MAINTENANCE: "var(--color-info)",
  ON_HOLD: "var(--color-caution)",
  CANCELLED: "var(--text-subtle)",
};

/**
 * How a check-in verdict reads on a card. `urgent` drives the accent treatment,
 * so only the states that genuinely want action today carry it.
 */
export const CONTACT_HEALTH = {
  DUE: { label: "Check-in due", tone: "var(--accent)", urgent: true },
  NEVER_CONTACTED: { label: "Never contacted", tone: "var(--accent)", urgent: true },
  QUIET: { label: "Gone quiet", tone: "var(--color-caution)", urgent: true },
  SCHEDULED: { label: "Follow-up booked", tone: "var(--color-info)", urgent: false },
  RECENT: { label: "In touch", tone: "var(--color-positive)", urgent: false },
  ARCHIVED: { label: "Archived", tone: "var(--text-subtle)", urgent: false },
};

/**
 * How a send verdict reads on screen.
 *
 * BLOCKED is shown in the critical colour rather than a soft warning tone on
 * purpose: in those markets a single cold email is actionable by the recipient
 * with no regulator involved, so it is not a "be careful" — it is a stop.
 */
export const SEND_POLICY_STYLE = {
  ALLOWED: { label: "Email OK", tone: "var(--color-positive)", short: "OK" },
  RESTRICTED: { label: "Check first", tone: "var(--color-caution)", short: "Check" },
  BLOCKED: { label: "Email not lawful", tone: "var(--color-critical)", short: "Blocked" },
};

export const CHANNEL_LABELS = {
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  PHONE: "Call",
  CONTACT_FORM: "Contact form",
  SOCIAL: "Social",
};

/**
 * `<input type="date">` speaks "YYYY-MM-DD" and nothing else. Built from the
 * local calendar date rather than `toISOString()`, which shifts the day for
 * anyone east or west of UTC at the wrong hour.
 */
export const toDateInput = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** A phone number reduced to what `tel:` and `wa.me` accept. */
export const dialable = (phone) => {
  if (!phone) return null;
  const cleaned = String(phone).replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return cleaned.replace(/\D/g, "").length >= 7 ? cleaned : null;
};

/** wa.me refuses a leading "+" and any separator, so it gets digits only. */
export const whatsappNumber = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
};

/** "acme.com/work" — a URL as a person would read it aloud. */
export const prettyUrl = (url) => {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return String(url);
  }
};

export const ACTION_LABELS = {
  CONTACT_IMMEDIATELY: "Contact immediately",
  EMAIL_PITCH: "Send email pitch",
  PHONE_CALL: "Call",
  CONTACT_FORM_MSG: "Message via contact form",
  SEND_AUDIT_REPORT: "Send website audit",
  PROPOSE_MEETING: "Propose a meeting",
  RESEARCH_FURTHER: "Research further",
  FOLLOW_UP_LATER: "Follow up later",
  LOW_PRIORITY: "Low priority",
  DO_NOT_CONTACT: "Do not contact",
};

export const JOB_STATUS_LABELS = {
  ACTIVE: "Active",
  RECENTLY_ACTIVE: "Recently active",
  EXPIRED: "Expired",
  CLOSED: "Closed",
  UNKNOWN: "Unverified",
};

/**
 * Confidence is a first-class visual concept here: a verified header match and
 * an AI-written sentence must never look the same.
 */
export const CONFIDENCE_STYLES = {
  VERIFIED: { label: "Verified", className: "bg-[color-mix(in_oklch,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]" },
  DETECTED: { label: "Detected", className: "bg-[color-mix(in_oklch,var(--color-info)_16%,transparent)] text-[var(--color-info)]" },
  INFERRED: { label: "Inferred", className: "bg-[color-mix(in_oklch,var(--color-caution)_20%,transparent)] text-[color-mix(in_oklch,var(--color-caution)_75%,black)] dark:text-[var(--color-caution)]" },
  AI_GENERATED: { label: "AI-generated", className: "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] text-[var(--accent)]" },
};

export const scoreTone = (score) =>
  score >= 75 ? "var(--color-positive)"
  : score >= 55 ? "var(--color-info)"
  : score >= 35 ? "var(--color-caution)"
  : "var(--text-subtle)";

export const freshnessTone = (bucket) =>
  bucket === "NEW_TODAY" ? "var(--color-positive)"
  : bucket === "NEW_THIS_WEEK" ? "var(--color-info)"
  : bucket === "THIS_MONTH" ? "var(--color-caution)"
  : "var(--text-subtle)";

export const FRESHNESS_LABELS = {
  NEW_TODAY: "Today",
  NEW_THIS_WEEK: "This week",
  THIS_MONTH: "This month",
  THIS_QUARTER: "This quarter",
  OLDER: "Older",
};

export const formatDate = (value) => {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

export const formatDateTime = (value) => {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const titleize = (value) =>
  String(value || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * "2h ago", "in 3 days", "just now" — the phrasing a person uses when asked
 * when something happened. Past and future both, because the Inbox shows when
 * a reply landed and when the next chase is due in the same column.
 */
export const relativeTime = (value) => {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";

  const diff = then - Date.now();
  const future = diff > 0;
  const mins = Math.round(Math.abs(diff) / 60000);

  if (mins < 1) return "just now";
  const [amount, unit] =
    mins < 60 ? [mins, "min"]
    : mins < 1440 ? [Math.round(mins / 60), "hour"]
    : mins < 43200 ? [Math.round(mins / 1440), "day"]
    : [Math.round(mins / 43200), "month"];

  const phrase = `${amount} ${unit}${amount === 1 ? "" : "s"}`;
  return future ? `in ${phrase}` : `${phrase} ago`;
};

/** Same idea, compressed for a badge: "2h", "3d", "in 5d". */
export const relativeShort = (value) => {
  if (!value) return "—";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);

  const compact =
    mins < 1 ? "now"
    : mins < 60 ? `${mins}m`
    : mins < 1440 ? `${Math.round(mins / 60)}h`
    : `${Math.round(mins / 1440)}d`;

  return diff > 0 && compact !== "now" ? `in ${compact}` : compact;
};
