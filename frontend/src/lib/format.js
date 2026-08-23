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
  INTERESTED: "Interested",
  CONVERTED: "Converted",
  NOT_INTERESTED: "Not interested",
  DISQUALIFIED: "Disqualified",
  ARCHIVED: "Archived",
  DO_NOT_CONTACT: "Do not contact",
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
