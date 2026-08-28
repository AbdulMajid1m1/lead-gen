import dns from "node:dns/promises";
import prisma from "../../prismaClient.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:hygiene");

/**
 * List hygiene for outbound email.
 *
 * Bounce rate is the one metric a sending domain cannot recover from quickly:
 * past ~4% providers start junk-foldering everything from the domain. Three
 * classes of address are caught here before they ever cost a bounce:
 *
 *  - broker/parking domains (domainmarket.com etc.) — spam-trap territory;
 *  - mangled extractions from the pre-fix deobfuscator, which turned prose
 *    like "platform.it" into "pl@form.it" (1-3 letter local parts that are
 *    not a real short mailbox like hr@ or gm@);
 *  - domains with no MX record, which cannot receive mail at all.
 */

/** Domain brokers and parking services — an address there is a trap, never a lead. */
export const BROKER_DOMAIN_RE =
  /(?:^|\.)(?:domainmarket|domainster|hugedomains|brandbucket|sedo|afternic|undeveloped|dynadot|epik|escrow|bodis|parkingcrew|sedoparking|dan)\.(?:com|net|org|co|io)$/i;

/** Real short mailboxes businesses actually publish — never flag these. */
const SHORT_LOCAL_ALLOW = new Set([
  "hr", "gm", "pr", "md", "dr", "ceo", "cto", "cfo", "coo", "job", "ask", "hi",
  "spa", "bar", "fix", "vip", "ops", "hq", "art", "law", "tax", "med", "dev",
  "api", "pos", "po", "ad", "it",
]);

// MX answers are cached per process: a campaign hitting 50 leads on the same
// domain must not issue 50 identical DNS queries.
const mxCache = new Map();

/**
 * Whether a domain can receive mail at all. Fails open on resolver trouble —
 * only a definitive "domain/records do not exist" may condemn an address,
 * a DNS timeout must not.
 */
export const domainHasMx = async (domain) => {
  const key = String(domain || "").toLowerCase();
  if (!key) return false;
  if (mxCache.has(key)) return mxCache.get(key);
  let ok = true;
  try {
    const mx = await dns.resolveMx(key);
    ok = mx.length > 0;
  } catch (err) {
    ok = !["ENOTFOUND", "ENODATA"].includes(err.code);
  }
  mxCache.set(key, ok);
  return ok;
};

/**
 * The English word-endings that are left over when a word is split on "at".
 *
 * The deobfuscator used to treat the "at" inside an ordinary word as a hidden
 * at-sign, so "…more information point it…" became `inform@ion.it`. The split
 * always leaves the tail of the word standing where the domain should be, and
 * that tail comes from a small closed set — a real business domain is never
 * "ion" or "ment". Checking the *domain* rather than the local part is what
 * separates these from `careers@stripe.com`, which has the same shape.
 *
 * An MX lookup does not settle it: `ion.it`, `ion.live` and `ion.be` are real
 * domains that accept mail, so the address is deliverable — to a company that
 * has nothing to do with the lead. That is worse than a bounce.
 */
const WORD_TAIL_LABELS = new Set([
  "ion", "ions", "ional", "ing", "ings", "ment", "ments", "ients", "ient",
  "ure", "ures", "ed", "es", "e", "h", "or", "ors", "us", "ic", "ics", "ive",
]);

/** Shortest reconstructed word we will treat as evidence of the split. */
const MIN_SPLIT_WORD = 7;   // "operate" is the shortest real case seen

/**
 * True when the address cannot be a real mailbox.
 *
 * Two signatures, both from the same extraction bug: a local part too short to
 * be a mailbox, and a domain whose first label is an English word-ending that
 * only a mid-word split could have produced.
 */
export const emailLooksMangled = (value) => {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(String(value || ""));
  if (!m) return true;
  const local = m[1].toLowerCase();
  const [label] = m[2].toLowerCase().split(".");

  if (local.length <= 3 && !SHORT_LOCAL_ALLOW.has(local)) return true;

  // `inform` + `at` + `ion` is `information`; `careers` + `at` + `stripe` is
  // not a word, and `stripe` is not a word-ending, so it is left alone.
  if (WORD_TAIL_LABELS.has(label) && /^[a-z]+$/.test(local)
      && local.length + 2 + label.length >= MIN_SPLIT_WORD) return true;

  return false;
};

const suppress = async (contact, reason) => {
  await prisma.contact.update({ where: { id: contact.id }, data: { isSuppressed: true } });
  await prisma.suppressionEntry.upsert({
    where: { kind_value: { kind: "EMAIL", value: contact.value.toLowerCase() } },
    create: { kind: "EMAIL", value: contact.value.toLowerCase(), reason: reason.slice(0, 500) },
    update: { reason: reason.slice(0, 500) },
  });
};

/**
 * Sweep every active email contact and suppress the unsendable ones.
 * Safe to run repeatedly; already-suppressed rows are never revisited.
 */
export const runContactHygiene = async ({ checkMx = true } = {}) => {
  const contacts = await prisma.contact.findMany({
    where: { kind: "EMAIL", isSuppressed: false },
    select: { id: true, value: true },
  });

  const summary = { checked: contacts.length, suppressed: 0, broker: 0, mangled: 0, noMx: 0 };

  for (const contact of contacts) {
    const domain = contact.value.split("@")[1]?.toLowerCase() || "";

    let reason = null;
    if (BROKER_DOMAIN_RE.test(domain)) { reason = "Domain broker / parking service — never a business contact."; summary.broker += 1; }
    else if (emailLooksMangled(contact.value)) { reason = "Malformed address from a prose-extraction bug — would bounce."; summary.mangled += 1; }
    else if (checkMx && !(await domainHasMx(domain))) { reason = "Domain has no MX record — cannot receive mail."; summary.noMx += 1; }

    if (reason) {
      await suppress(contact, reason);
      summary.suppressed += 1;
      logger.info({ value: contact.value, reason }, "contact suppressed by hygiene");
    }
  }

  return summary;
};
