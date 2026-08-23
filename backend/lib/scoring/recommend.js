import { SIGNAL_CATALOG } from "../signals/signalCatalog.js";

/**
 * Turns a scored lead into "what should I actually do next".
 *
 * Deterministic templates only. The optional LLM layer may later rewrite the
 * opening line into something more natural, but it is handed *these* verified
 * talking points rather than the raw website — it embellishes wording, never
 * facts, and its output is labelled AI_GENERATED.
 */

export const SERVICE_PITCH = {
  WEBSITE_DEV: {
    label: "website development",
    angle: "rebuilding the site as a fast, mobile-first presence that converts visitors into enquiries",
    problem: "the current site is losing enquiries it should be capturing",
  },
  CRM_DEV: {
    label: "CRM development",
    angle: "getting customer data into one place and automating the follow-up that currently happens by hand",
    problem: "customer records and follow-ups are scattered across inboxes and spreadsheets",
  },
  MOBILE_APP: {
    label: "mobile app development",
    angle: "giving repeat customers an app that makes ordering or booking a two-tap job",
    problem: "loyal customers have no fast, repeatable way to transact",
  },
  AI_AUTOMATION: {
    label: "AI automation",
    angle: "automating the repetitive phone-and-email work that currently eats staff hours",
    problem: "staff time is going into work software should be handling",
  },
  ECOMMERCE_DEV: {
    label: "e-commerce development",
    angle: "opening an online sales channel alongside the existing walk-in trade",
    problem: "there is no way to buy without physically showing up",
  },
  SAAS_DEV: {
    label: "SaaS development",
    angle: "turning the internal process into a product-grade platform",
    problem: "growth is outrunning the internal tooling",
  },
  HR_SOFTWARE: {
    label: "HR software",
    angle: "putting payroll, leave, attendance and hiring in one platform before the spreadsheet chaos compounds",
    problem: "HR is being run across spreadsheets and inboxes while headcount grows",
  },
  CUSTOM_SOFTWARE: {
    label: "custom software development",
    angle: "adding delivery capacity to the roadmap the team is already hiring for",
    problem: "the roadmap is bigger than the team currently building it",
  },
};

/**
 * @returns {{actions:Array, outreach:object|null}}
 */
export const buildRecommendation = ({ company, lead, contributions, reasons, contacts }) => {
  const pitch = SERVICE_PITCH[lead.primaryOpportunity] || SERVICE_PITCH.WEBSITE_DEV;
  const actions = [];

  const hiringSignal = contributions.find((c) => c.type.startsWith("HIRING_"));
  const isFresh = contributions.some((c) => c.decay > 0.7 && SIGNAL_CATALOG[c.type]?.halfLifeDays <= 30);
  const channel = contacts.hasEmail ? "EMAIL" : contacts.hasPhone ? "PHONE" : contacts.hasForm ? "CONTACT_FORM" : null;

  // ─── Priority action ────────────────────────────────────────────────────────
  if (!channel) {
    actions.push({
      actionType: "RESEARCH_FURTHER",
      title: "Find a contact route before outreach",
      rationale: "No public email, phone or contact form was found, so there is nothing to reach out to yet.",
      priority: 40,
    });
  } else if (lead.score >= 70 && isFresh) {
    actions.push({
      actionType: "CONTACT_IMMEDIATELY",
      title: `Contact now — ${pitch.label} opportunity is live`,
      rationale: hiringSignal
        ? `${hiringSignal.context?.jobTitle ? `They are actively hiring for "${hiringSignal.context.jobTitle}"` : "They are actively hiring"}, so the budget conversation is happening right now.`
        : "The strongest signals behind this lead were detected recently, so the timing is good.",
      priority: 100,
    });
  } else if (lead.score >= 50) {
    actions.push({
      actionType: channel === "EMAIL" ? "EMAIL_PITCH" : channel === "PHONE" ? "PHONE_CALL" : "CONTACT_FORM_MSG",
      title: `Send a ${pitch.label} pitch`,
      rationale: `Score ${lead.score}/100 with ${contributions.length} supporting signals — worth a targeted approach.`,
      priority: 80,
    });
  } else if (lead.score >= 35) {
    actions.push({
      actionType: "FOLLOW_UP_LATER",
      title: "Add to the nurture list",
      rationale: `Score ${lead.score}/100 — real but not urgent. Re-check when a fresher signal appears.`,
      priority: 50,
    });
  } else {
    actions.push({
      actionType: "LOW_PRIORITY",
      title: "Low priority",
      rationale: `Score ${lead.score}/100 with limited supporting evidence.`,
      priority: 20,
    });
  }

  // ─── Supporting actions ─────────────────────────────────────────────────────
  const auditSignal = contributions.find((c) => c.type === "OUTDATED_WEBSITE");
  if (auditSignal) {
    actions.push({
      actionType: "SEND_AUDIT_REPORT",
      title: "Lead with the website audit",
      rationale: `Their site scores ${auditSignal.context?.auditScore ?? "low"}/100 — a one-page audit is concrete, specific and hard to ignore.`,
      priority: 70,
    });
  }
  if (hiringSignal && lead.score >= 50) {
    actions.push({
      actionType: "PROPOSE_MEETING",
      title: "Offer delivery capacity alongside the hire",
      rationale: "Hiring takes months. Offering to start now, while the role is still open, addresses the immediate gap.",
      priority: 65,
    });
  }

  actions.sort((a, b) => b.priority - a.priority);

  if (!channel) return { actions, outreach: null };

  // ─── Outreach draft ─────────────────────────────────────────────────────────
  const topReasons = reasons.slice(0, 3);
  const hook = topReasons[0]?.text || pitch.problem;

  const subjectLine = hiringSignal?.context?.jobTitle
    ? `${company.name} — delivery help while you hire the ${shortTitle(hiringSignal.context.jobTitle)}`
    : auditSignal
      ? `${company.name} — a few specific issues on your website`
      : `${company.name} — ${pitch.label} idea`;

  const openingLine = hiringSignal?.context?.jobTitle
    ? `I noticed ${company.name} is hiring a ${shortTitle(hiringSignal.context.jobTitle)}${hiringSignal.context.location ? ` in ${hiringSignal.context.location}` : ""}. That usually means a project is already underway and the team needs capacity before the hire lands.`
    : `I had a look at ${company.name}'s website and noticed ${lowerFirst(hook)}`;

  return {
    actions,
    outreach: {
      channel,
      subjectLine: subjectLine.slice(0, 200),
      openingLine: openingLine.slice(0, 1000),
      // Every talking point carries the evidence it came from, so nothing said
      // in an outreach message is untraceable.
      talkingPoints: topReasons.map((r) => ({
        point: r.text,
        signalType: r.type,
        confidenceLevel: r.confidenceLevel,
      })).concat([{
        point: `Pitch angle: ${pitch.angle}.`,
        signalType: "DERIVED",
        confidenceLevel: "INFERRED",
      }]),
    },
  };
};

const shortTitle = (title) => String(title).replace(/\s*[-–—(].*$/, "").trim().slice(0, 60);
const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
