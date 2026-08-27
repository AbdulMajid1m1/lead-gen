import { countryName } from "../../utils/countries.js";

/**
 * Whether we are allowed to send this lead a cold message on this channel.
 *
 * This is not a style guide or a deliverability heuristic — it is the legal
 * gate, and it is per country and per channel because the law is.
 *
 * The rule that drives the whole module: the ePrivacy Directive Art. 13(5) let
 * each member state decide whether the opt-in requirement protects companies as
 * well as people, and roughly half extended it. In those states a cold
 * marketing email to a business is unlawful however relevant it is, and the
 * EDPB (Guidelines 1/2024, fn. 143) goes further — where national law bars the
 * message, there is no legitimate interest that justifies collecting the
 * address for it either. So this gate exists at *selection* time, not only at
 * send time.
 *
 * Two things this module is careful about:
 *
 *   1. **Channel matters.** Germany's UWG § 7(2) requires prior express consent
 *      for email (Nr. 2) but allows *presumed* consent for a business-to-
 *      business telephone approach (Nr. 1). The distinction is deliberate in
 *      the statute. So a German lead that is closed to email may still be open
 *      on the phone — and blanket-blocking the country would throw that away.
 *
 *   2. **Who the address belongs to matters.** A role mailbox at a company
 *      (`info@`) identifies no individual, so GDPR does not reach it; a named
 *      address does. That distinction is what makes Saudi Arabia workable:
 *      PDPL binds processing of *natural persons'* data, so `info@company.sa`
 *      sits outside it while `ahmed@company.sa` does not.
 *
 * Nothing here is legal advice, and it is deliberately conservative: where the
 * position is genuinely unsettled the answer is RESTRICTED, not ALLOWED.
 */

/** ALLOWED — send. RESTRICTED — send only with a human decision. BLOCKED — do not. */
export const POLICY = { ALLOWED: "ALLOWED", RESTRICTED: "RESTRICTED", BLOCKED: "BLOCKED" };

/**
 * Per-country email position for unsolicited business-to-business mail.
 *
 * `legalPersons: true` means the state extended ePrivacy Art. 13 opt-in to
 * companies, which is what closes the market.
 */
const EMAIL_RULES = {
  // ── Opt-in, extended to companies: cold email is unlawful ───────────────────
  DE: { policy: POLICY.BLOCKED, law: "UWG § 7(2) Nr. 2", note: "Prior express consent is required, and the statute draws no business exception. A single email is actionable (BGH I ZR 218/07), and any recipient can claim — no regulator needed." },
  AT: { policy: POLICY.BLOCKED, law: "TKG 2021 § 174(3)", note: "Prior consent required, businesses included. Administrative fine up to €50,000, and the ECG-Liste must be screened before any send." },
  IT: { policy: POLICY.BLOCKED, law: "Codice privacy art. 130", note: "Opt-in, and the protected 'contraente' includes legal persons." },
  ES: { policy: POLICY.BLOCKED, law: "LSSI art. 21", note: "Unsolicited commercial email is prohibited outright; applies to legal persons." },
  NL: { policy: POLICY.BLOCKED, law: "Telecommunicatiewet art. 11.7", note: "The spam ban was extended to business recipients in 2009." },

  // ── Opt-out: cold email is lawful with the right disclosures ────────────────
  GB: { policy: POLICY.ALLOWED, law: "PECR reg. 22", note: "Lawful to corporate subscribers (Ltd, LLP, Scottish partnerships). Sole traders and ordinary partnerships are individual subscribers and need consent — treat an unresolved legal form as individual." },
  FR: { policy: POLICY.ALLOWED, law: "CNIL B2B guidance", note: "Opt-out, provided the message relates to the recipient's professional function and carries an easy objection route." },
  IE: { policy: POLICY.ALLOWED, law: "SI 336/2011 reg. 13", note: "Opt-out for corporate subscribers." },
  BE: { policy: POLICY.ALLOWED, law: "Boek VI WER", note: "Opt-out for business recipients." },
  US: { policy: POLICY.ALLOWED, law: "CAN-SPAM", note: "Opt-out. Requires a real postal address, honest subject line, and opt-out honoured within 10 business days." },
  CA: { policy: POLICY.RESTRICTED, law: "CASL", note: "Consent-based with narrow business exemptions. Confirm the basis before sending." },

  // ── Lawful only in a narrower shape ─────────────────────────────────────────
  CH: { policy: POLICY.RESTRICTED, law: "UWG Art. 3(1)(o)", note: "The prohibition attaches to mass advertising. Genuinely individual, clearly-identified outreach with a working unsubscribe is defensible; automated bulk sequencing is not." },

  // ── Gulf ────────────────────────────────────────────────────────────────────
  SA: { policy: POLICY.RESTRICTED, law: "PDPL arts. 25-26", note: "Consent required for marketing to individuals, and art. 26 additionally requires the data to have been collected directly from them. A role mailbox at a company identifies no individual and sits outside the law; a named address does not." },
  AE: { policy: POLICY.RESTRICTED, law: "PDPL 45/2021 art. 4", note: "Consent-based on paper, but the Executive Regulations and the penalty decision remain unissued, so there is no operative penalty regime yet. Prefer role addresses." },
  QA: { policy: POLICY.RESTRICTED, law: "Law 13/2016", note: "Consent-based. Prefer role addresses." },
  KW: { policy: POLICY.RESTRICTED, law: "CITRA data privacy regulation", note: "Consent-based. Prefer role addresses." },
  BH: { policy: POLICY.RESTRICTED, law: "PDPL 30/2018", note: "Consent-based. Prefer role addresses." },
  OM: { policy: POLICY.RESTRICTED, law: "Royal Decree 6/2022", note: "Consent-based. Prefer role addresses." },
};

/**
 * Phone and WhatsApp, which several states treat more permissively than email.
 *
 * Germany is the case that matters: UWG § 7(2) Nr. 1 allows a business-to-
 * business call on *presumed* consent, where Nr. 2 demands express consent for
 * email. Every DE/AT lead the email gate closes is therefore still reachable
 * here — which is the whole reason this table exists separately.
 */
const PHONE_RULES = {
  DE: { policy: POLICY.RESTRICTED, law: "UWG § 7(2) Nr. 1", note: "A B2B approach is allowed on presumed consent — there must be concrete grounds to think this business would welcome the call, not merely that it might. Document the reason." },
  AT: { policy: POLICY.BLOCKED, law: "TKG 2021 § 174(1)", note: "Prior consent required for calls as well as email." },
};

/** Markets with no country recorded: we cannot show a rule we do not know. */
const UNKNOWN_RULE = {
  policy: POLICY.RESTRICTED,
  law: null,
  note: "No country recorded for this company, so no send rule can be applied. Establish where it trades before contacting it.",
};

/** A default for countries not in the table — cautious rather than permissive. */
const DEFAULT_RULE = {
  policy: POLICY.RESTRICTED,
  law: null,
  note: "No rule recorded for this market. Confirm the local position on unsolicited business email before sending.",
};

/**
 * Does this address identify a person, or just a company?
 *
 * The distinction carries real legal weight — a role mailbox is not personal
 * data — so it is read from the classification the extractor already recorded
 * rather than guessed at again here.
 */
export const isRoleAddress = (contact) => {
  if (!contact) return false;
  if (contact.roleHint === "ROLE") return true;
  const local = String(contact.value || "").split("@")[0].toLowerCase().replace(/[._-]/g, "");
  return ["info", "contact", "hello", "sales", "office", "admin", "enquiries", "enquiry", "mail", "team", "support"].includes(local);
};

/**
 * The send verdict for one lead on one channel.
 *
 * @param {object} input
 * @param {string|null} input.countryCode  ISO alpha-2 of the company
 * @param {"EMAIL"|"WHATSAPP"|"PHONE"} input.channel
 * @param {boolean} [input.roleAddress]    true when the target is a role mailbox
 * @returns {{policy: string, law: string|null, note: string, country: string|null, channel: string}}
 */
export const sendPolicyFor = ({ countryCode, channel = "EMAIL", roleAddress = false }) => {
  const code = String(countryCode || "").toUpperCase();
  const country = code ? countryName(code) : null;

  if (!code) return { ...UNKNOWN_RULE, country: null, channel };

  if (channel === "PHONE" || channel === "WHATSAPP") {
    const rule = PHONE_RULES[code];
    if (rule) return { ...rule, country, channel };
    // Where no separate rule is recorded, a live conversation is not more
    // restricted than email, so the email position is the safe read.
    const emailRule = EMAIL_RULES[code] || DEFAULT_RULE;
    return { ...emailRule, country, channel };
  }

  const rule = EMAIL_RULES[code] || DEFAULT_RULE;

  // A role mailbox at a company is not personal data, which lifts the GDPR
  // layer — but only where the block came from data-protection law rather than
  // from an ePrivacy opt-in that covers legal persons too. In DE/AT/IT/ES/NL
  // the prohibition reaches the company itself, so the mailbox makes no
  // difference and the answer stays BLOCKED.
  if (roleAddress && rule.policy === POLICY.RESTRICTED && GDPR_ONLY_RESTRICTIONS.has(code)) {
    return {
      policy: POLICY.ALLOWED,
      law: rule.law,
      note: `${rule.note} This is a role mailbox, which identifies no individual and therefore falls outside that law.`,
      country,
      channel,
    };
  }

  return { ...rule, country, channel };
};

/**
 * Markets whose restriction comes from data-protection law binding *natural
 * persons*, and so does not reach a company's role mailbox. Deliberately does
 * not include the ePrivacy opt-in states, where the prohibition covers legal
 * persons as well and a role mailbox changes nothing.
 */
const GDPR_ONLY_RESTRICTIONS = new Set(["SA", "AE", "QA", "KW", "BH", "OM"]);

/** Countries where cold email is closed, for the UI to explain the filter. */
export const BLOCKED_EMAIL_COUNTRIES = Object.entries(EMAIL_RULES)
  .filter(([, rule]) => rule.policy === POLICY.BLOCKED)
  .map(([code]) => code);

/** True when a lead must not receive a cold email on this channel. */
export const isSendBlocked = (verdict) => verdict.policy === POLICY.BLOCKED;
