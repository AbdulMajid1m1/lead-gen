import { normaliseIcp } from "../promoter/icp.js";

/**
 * Which of a company's public inboxes the buyer actually reads.
 *
 * A business publishes one address per function, and they are not
 * interchangeable for a cold pitch. The first live TracefyHR run was about to
 * send an HR-platform email to `admissions@` at six Dubai schools — the inbox
 * staffed to answer parents enrolling children, which forwards a vendor pitch
 * to nobody — while `hrm@eischools.ae` sat unused on one of the same leads.
 * That is not a deliverability problem or a copy problem; it is the wrong
 * reader, and no subject line recovers from it.
 *
 * The ranking is derived from the approved ICP's own buyer titles rather than
 * hardcoded, so a product sold to finance prefers a finance inbox without any
 * change here.
 */

/** Local-part fragments that mean "this is the desk that owns the topic". */
const TITLE_TO_INBOX = [
  { match: /\bhr\b|human resource|people|talent|personnel/i, inboxes: ["hr", "humanresources", "people", "talent", "personnel", "recruit", "career", "jobs"] },
  { match: /payroll|compensation|benefit/i, inboxes: ["payroll", "salaries", "compensation"] },
  { match: /financ|account|bursar|controller|cfo|treasur/i, inboxes: ["finance", "accounts", "accounting", "bursar", "payables"] },
  { match: /operation|coo\b|logistic/i, inboxes: ["operations", "ops"] },
  { match: /founder|owner|ceo|managing director|general manager|\bmd\b|\bgm\b|principal|partner/i, inboxes: ["ceo", "founder", "md", "gm", "director", "management", "office"] },
  { match: /it\b|technolog|cto|systems/i, inboxes: ["it", "tech", "systems"] },
  { match: /market|brand|growth/i, inboxes: ["marketing", "brand"] },
  { match: /sales|revenue|commercial/i, inboxes: ["sales", "commercial"] },
];

/**
 * Inboxes that belong to somebody else's job entirely.
 *
 * Not spam traps and not invalid — simply the wrong department for any
 * outbound pitch. A school's admissions desk, a clinic's appointment line and
 * a shop's returns address all reliably reach a person, which is exactly why
 * they outrank nothing on their own and have to be named.
 */
const WRONG_DESK = [
  "admission", "admissions", "enrol", "enroll", "registrar", "reception",
  "booking", "bookings", "appointment", "appointments", "reservations",
  "support", "helpdesk", "complaints", "returns", "refund", "billing",
  "unsubscribe", "noreply", "no-reply", "donotreply", "webmaster", "postmaster",
  "abuse", "privacy", "legal", "press", "media", "parent", "parents", "student", "students",
];

const localPart = (value) => String(value || "").split("@")[0].toLowerCase();

/** The inbox fragments this ICP's buyers would sit behind. */
export const buyerInboxes = (icp) => {
  const safe = normaliseIcp(icp);
  const titles = [...safe.buyerTitles.decisionMakers, ...safe.buyerTitles.champions].join(" ");
  if (!titles.trim()) return [];
  const out = [];
  for (const { match, inboxes } of TITLE_TO_INBOX) {
    if (match.test(titles)) out.push(...inboxes);
  }
  return [...new Set(out)];
};

/**
 * Score one address for this buyer. Higher is better; the caller keeps the max.
 *
 * Deliberately additive over the existing confidence/role ranking rather than
 * replacing it: a verified address is still worth more than an unverified one,
 * and this only decides between addresses that are equally real.
 */
export const inboxScore = (value, buyer = []) => {
  const local = localPart(value);
  if (!local) return 0;
  // Segments, so "hr" matches "hr" and "hr.dubai" but not "chrome" or "hrs".
  const parts = local.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (needle) => parts.some((p) => p === needle || p.startsWith(needle));

  if (WRONG_DESK.some((desk) => has(desk))) return -5;
  if (buyer.some((needle) => has(needle))) return 5;
  // A generic catch-all is neither right nor wrong — it is read by whoever
  // opens the post, which for a small business is often the buyer.
  if (["info", "contact", "hello", "enquiries", "inquiries", "mail", "admin", "office"].some((g) => has(g))) return 1;
  return 0;
};

/**
 * Order a company's addresses by how well each fits the buyer, best first.
 * Ties keep their incoming order, so an existing ranking survives underneath.
 */
export const rankInboxesForBuyer = (contacts, icp) => {
  const buyer = buyerInboxes(icp);
  return [...contacts]
    .map((contact, index) => ({ contact, index, score: inboxScore(contact.value, buyer) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ contact }) => contact);
};
