/**
 * The signal catalogue — the single source of truth for what each signal is
 * worth, how fast it goes stale, and which services it points at.
 *
 * Weights and half-lives are copied onto each Signal row at detection time, so
 * re-tuning this table never silently rewrites the history of why an existing
 * lead scored what it scored.
 *
 * `services` maps a signal to the service opportunities it supports, with the
 * share of the signal's points each one receives.
 */
export const SIGNAL_CATALOG = {
  // ─── Digital gap ────────────────────────────────────────────────────────────
  NO_WEBSITE: {
    weight: 30, halfLifeDays: null, leadType: "DIGITAL_GAP",
    label: "No website",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `${c.companyName} is listed as an operating business with contact details but has no website at all.`,
  },
  OUTDATED_WEBSITE: {
    weight: 25, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Outdated website",
    services: { WEBSITE_DEV: 0.8, ECOMMERCE_DEV: 0.2 },
    reason: (c) => `The website scores ${c.auditScore}/100 on a technical quality audit${c.topFinding ? ` — ${c.topFinding}` : ""}.`,
  },
  NO_HTTPS: {
    weight: 15, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "No HTTPS",
    services: { WEBSITE_DEV: 1 },
    reason: () => "The site is served over plain HTTP, so browsers show visitors a “Not secure” warning.",
  },
  NO_MOBILE_VIEWPORT: {
    weight: 12, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Not mobile-friendly",
    services: { WEBSITE_DEV: 0.7, MOBILE_APP: 0.3 },
    reason: () => "The site has no mobile viewport tag, so it renders as a zoomed-out desktop page on phones.",
  },
  SLOW_SITE: {
    weight: 8, halfLifeDays: 180, leadType: "TECH_DEBT",
    label: "Slow site",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `The home page took ${c.seconds}s to respond.`,
  },
  OLD_COPYRIGHT: {
    weight: 8, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Stale copyright",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `The footer copyright still reads ${c.year}, suggesting the site has not been maintained for ${c.yearsBehind} years.`,
  },
  LEGACY_JS_LIB: {
    weight: 8, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Legacy libraries",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `The site runs ${c.library}, which is end-of-life and carries known security advisories.`,
  },
  WORDPRESS_DETECTED: {
    weight: 6, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "WordPress",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `The site runs WordPress${c.version ? ` ${c.version}` : ""}.`,
  },
  WOOCOMMERCE_DETECTED: {
    weight: 12, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "WooCommerce store",
    services: { ECOMMERCE_DEV: 0.6, MOBILE_APP: 0.4 },
    reason: () => "The store runs on WooCommerce, which has no native mobile app and commonly needs performance and checkout work as it grows.",
  },
  SHOPIFY_DETECTED: {
    weight: 8, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Shopify store",
    services: { ECOMMERCE_DEV: 0.5, MOBILE_APP: 0.5 },
    reason: () => "The business sells online through Shopify but has no mobile app presence.",
  },
  WIX_SQUARESPACE: {
    weight: 10, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Website-builder site",
    services: { WEBSITE_DEV: 1 },
    reason: (c) => `The site is built on ${c.builder}, a template builder that businesses typically outgrow when they need custom functionality or integrations.`,
  },
  MAGENTO_LEGACY: {
    weight: 12, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "Legacy Magento",
    services: { ECOMMERCE_DEV: 1 },
    reason: () => "The store runs a legacy Magento version, which is out of support and a frequent replatforming trigger.",
  },
  NO_ONLINE_ORDERING: {
    weight: 12, halfLifeDays: 365, leadType: "DIGITAL_GAP",
    label: "No online ordering",
    services: { ECOMMERCE_DEV: 0.5, MOBILE_APP: 0.3, WEBSITE_DEV: 0.2 },
    reason: (c) => `${c.industry || "The business"} sells to walk-in customers but offers no way to order or buy online.`,
  },
  NO_BOOKING_SYSTEM: {
    weight: 10, halfLifeDays: 365, leadType: "DIGITAL_GAP",
    label: "No online booking",
    services: { AI_AUTOMATION: 0.4, WEBSITE_DEV: 0.4, MOBILE_APP: 0.2 },
    reason: (c) => `${c.industry || "The business"} runs on appointments but has no online booking — every reservation costs staff time on the phone.`,
  },
  NO_SCHEMA_ORG: {
    weight: 5, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "No structured data",
    services: { WEBSITE_DEV: 1 },
    reason: () => "The site publishes no schema.org data, so it cannot appear in rich search results or map panels.",
  },
  NO_ANALYTICS: {
    weight: 5, halfLifeDays: 365, leadType: "TECH_DEBT",
    label: "No analytics",
    services: { WEBSITE_DEV: 0.6, AI_AUTOMATION: 0.4 },
    reason: () => "No analytics tag is installed, so the business has no measurement of its own web traffic.",
  },

  // ─── Hiring intent (short half-lives — this is the freshness engine) ────────
  HIRING_TECH_ROLE: {
    weight: 25, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring technology staff",
    services: { CUSTOM_SOFTWARE: 0.5, SAAS_DEV: 0.3, WEBSITE_DEV: 0.2 },
    reason: (c) => `Currently hiring ${c.jobTitle}${c.location ? ` in ${c.location}` : ""} — an active technology initiative that often needs outside delivery capacity.`,
  },
  HIRING_CRM_ROLE: {
    weight: 28, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring for CRM",
    services: { CRM_DEV: 0.8, AI_AUTOMATION: 0.2 },
    reason: (c) => `Currently hiring ${c.jobTitle}, which usually signals an active CRM rollout, migration or customer-data project.`,
  },
  HIRING_ECOM_ROLE: {
    weight: 26, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring for e-commerce",
    services: { ECOMMERCE_DEV: 0.8, MOBILE_APP: 0.2 },
    reason: (c) => `Currently hiring ${c.jobTitle}, indicating active investment in online sales.`,
  },
  HIRING_MOBILE_ROLE: {
    weight: 26, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring for mobile",
    services: { MOBILE_APP: 0.9, CUSTOM_SOFTWARE: 0.1 },
    reason: (c) => `Currently hiring ${c.jobTitle} — a mobile app is being built or maintained right now.`,
  },
  HIRING_AI_ROLE: {
    weight: 26, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring for AI/automation",
    services: { AI_AUTOMATION: 0.8, CUSTOM_SOFTWARE: 0.2 },
    reason: (c) => `Currently hiring ${c.jobTitle}, indicating an active AI or automation programme.`,
  },
  HIRING_HR_ROLE: {
    weight: 27, halfLifeDays: 14, leadType: "HIRING_INTENT",
    label: "Hiring HR staff",
    services: { HR_SOFTWARE: 0.8, AI_AUTOMATION: 0.2 },
    reason: (c) => `Currently hiring ${c.jobTitle}${c.location ? ` in ${c.location}` : ""} — a company standing up or growing its HR function, which is exactly when payroll, leave and attendance tooling gets bought.`,
  },
  HIRING_MANY_ROLES: {
    weight: 10, halfLifeDays: 21, leadType: "EXPANSION",
    label: "Hiring at scale",
    services: { CUSTOM_SOFTWARE: 0.3, SAAS_DEV: 0.2, CRM_DEV: 0.2, HR_SOFTWARE: 0.3 },
    reason: (c) => `${c.count} roles are open right now — teams growing this fast routinely outrun their internal delivery capacity.`,
  },

  // ─── Newness / growth ───────────────────────────────────────────────────────
  NEW_DOMAIN: {
    weight: 15, halfLifeDays: 30, leadType: "NEW_BUSINESS",
    label: "New domain",
    services: { WEBSITE_DEV: 0.6, SAAS_DEV: 0.2, CUSTOM_SOFTWARE: 0.2 },
    reason: (c) => `The domain first appeared in certificate transparency logs ${c.daysAgo} days ago — a business that is still building out its digital presence.`,
  },
  NEW_SUBDOMAIN: {
    weight: 12, halfLifeDays: 30, leadType: "EXPANSION",
    label: "New subdomain",
    services: { ECOMMERCE_DEV: 0.5, CUSTOM_SOFTWARE: 0.5 },
    reason: (c) => `A new "${c.subdomain}" subdomain appeared ${c.daysAgo} days ago, suggesting a new store or application is being stood up.`,
  },
  CAREERS_PAGE_ACTIVE: {
    weight: 6, halfLifeDays: 60, leadType: "EXPANSION",
    label: "Active careers page",
    services: { CUSTOM_SOFTWARE: 0.5, SAAS_DEV: 0.5 },
    reason: () => "The company runs an active careers page with open positions.",
  },
  GROWTH_MENTION: {
    weight: 8, halfLifeDays: 60, leadType: "EXPANSION",
    label: "Expansion mentioned",
    services: { WEBSITE_DEV: 0.4, CRM_DEV: 0.3, CUSTOM_SOFTWARE: 0.3 },
    reason: () => "The website mentions expansion — a new location, branch or opening.",
  },
  MANUAL_PROCESS_HINT: {
    weight: 10, halfLifeDays: 180, leadType: "DIGITAL_GAP",
    label: "Manual processes",
    services: { AI_AUTOMATION: 0.6, CRM_DEV: 0.4 },
    reason: () => "The site asks customers to phone or email for things competitors handle automatically — a direct automation opportunity.",
  },

  // ─── Reachability (not opportunity points; feeds the reachability category) ─
  CONTACT_EMAIL_FOUND: { weight: 0, halfLifeDays: null, leadType: null, label: "Email found", services: {}, reason: () => "A public business email address was found." },
  CONTACT_PHONE_FOUND: { weight: 0, halfLifeDays: null, leadType: null, label: "Phone found", services: {}, reason: () => "A public business phone number was found." },
  CONTACT_FORM_FOUND:  { weight: 0, halfLifeDays: null, leadType: null, label: "Contact form found", services: {}, reason: () => "The website has a working contact form." },
  NAMED_CONTACT_FOUND: { weight: 0, halfLifeDays: null, leadType: null, label: "Named contact found", services: {}, reason: (c) => `${c.personName}${c.personTitle ? `, ${c.personTitle}` : ""} is published on the company's own site as a contact.` },

  // ─── Disqualifiers (carry no points; they remove a lead from outreach) ──────
  // These exist because the costly mistakes in lead generation are not missed
  // opportunities, they are confidently wrong records: emailing a business that
  // closed years ago, or one whose "website" now belongs to somebody else.
  BUSINESS_CLOSED: {
    weight: 0, halfLifeDays: null, leadType: null,
    label: "Permanently closed",
    services: {},
    reason: (c) => `Google Places lists ${c.companyName} as permanently closed${c.observedOn ? ` (checked ${c.observedOn})` : ""}. Outreach would bounce and damage sending reputation.`,
  },
  WEBSITE_NOT_OWNED: {
    weight: 0, halfLifeDays: null, leadType: null,
    label: "Website does not belong to this business",
    services: {},
    reason: (c) => `The domain on record (${c.domain}) is not this company's website — ${c.detail || "it failed the identity check"}.`,
  },
};

export const REACHABILITY_SIGNALS = new Set(["CONTACT_EMAIL_FOUND", "CONTACT_PHONE_FOUND", "CONTACT_FORM_FOUND", "NAMED_CONTACT_FOUND"]);

/**
 * Signals that invalidate a lead outright.
 *
 * Kept separate from weighting: a disqualified lead is not a low-scoring lead,
 * it is one that must never be contacted, however strong its other signals are.
 */
export const DISQUALIFYING_SIGNALS = new Set(["BUSINESS_CLOSED", "WEBSITE_NOT_OWNED"]);

export const isDisqualifyingSignal = (type) => DISQUALIFYING_SIGNALS.has(type);

/** Opportunity signals are everything that carries weight. */
export const isOpportunitySignal = (type) =>
  !REACHABILITY_SIGNALS.has(type) && !DISQUALIFYING_SIGNALS.has(type) && (SIGNAL_CATALOG[type]?.weight ?? 0) > 0;

export const getSignalDefinition = (type) => SIGNAL_CATALOG[type] || null;

/** Serialisable catalogue for the UI legend. */
export const catalogForApi = () =>
  Object.entries(SIGNAL_CATALOG).map(([type, def]) => ({
    type,
    label: def.label,
    weight: def.weight,
    halfLifeDays: def.halfLifeDays,
    leadType: def.leadType,
    services: Object.keys(def.services),
    isReachability: REACHABILITY_SIGNALS.has(type),
    isDisqualifying: DISQUALIFYING_SIGNALS.has(type),
  }));
