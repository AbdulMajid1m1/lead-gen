import { normalizeCompanyName } from "../../utils/normalize.js";
import { countryName } from "../../utils/countries.js";

/**
 * Client-book domain rules.
 *
 * Everything here is pure: sanitising, shaping and deriving. It is kept out of
 * the controller so the rules that decide what a "stale" client is, or what a
 * safe link looks like, can be unit-tested without an HTTP layer or a database.
 */

/** How long a client may go unheard-from before the book nudges you. */
export const QUIET_AFTER_DAYS = 90;

/**
 * Links are rendered into anchor hrefs, so the scheme is an injection surface,
 * not a formatting detail. Only absolute http(s) URLs survive; a bare host is
 * upgraded to https rather than rejected, because "acme.com" is what people
 * actually type.
 *
 * Returns null for anything else — including javascript:, data: and mailto:.
 */
export const safeExternalUrl = (input) => {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // A host is what makes it a link; "https:///x" parses but points nowhere.
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return url.href;
};

/** Empty string from a form means "clear this field", never the literal "". */
export const nullifyBlank = (value) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * The duplicate key. Shares `normalizeCompanyName` with the discovery engine so
 * a client entered as "Acme Ltd." collides with one entered as "acme" — and so
 * the same company resolves identically on both sides of the product.
 *
 * Falls back to a lowercased trim when normalisation strips everything (a name
 * made entirely of legal suffixes, e.g. "Group"), because an empty key would
 * make every such client collide with every other.
 */
export const clientKey = (name) => {
  const normalized = normalizeCompanyName(name);
  return normalized || String(name || "").trim().toLowerCase();
};

/**
 * Contacts, ordered the way a human scans them: the primary first, then anyone
 * named, then the rest. Stable within each tier by creation order, so the list
 * does not reshuffle between renders.
 */
const orderContacts = (contacts = []) =>
  [...contacts].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const aNamed = Boolean(a.name), bNamed = Boolean(b.name);
    if (aNamed !== bNamed) return aNamed ? -1 : 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

/**
 * Projects, newest work first, using the most meaningful date each one has:
 * when it was delivered, else when it started, else when it was recorded.
 */
const projectDate = (p) => new Date(p.deliveredAt || p.startedAt || p.createdAt).getTime();
const orderProjects = (projects = []) => [...projects].sort((a, b) => projectDate(b) - projectDate(a));

const daysBetween = (from, to) => Math.floor((to - from) / 86_400_000);

/**
 * The "should I call them?" verdict, computed server-side so the list, the
 * detail page and the counters can never disagree about it.
 *
 * ARCHIVED clients are deliberately never due: archiving is the way to say
 * "stop suggesting this one".
 */
export const contactHealth = (client, now = Date.now()) => {
  if (client.status === "ARCHIVED") return { state: "ARCHIVED", daysSinceContact: null, isDue: false };

  const daysSinceContact = client.lastContactedAt
    ? daysBetween(new Date(client.lastContactedAt).getTime(), now)
    : null;

  // An explicit follow-up date always wins: someone decided when to call back,
  // and that beats any rule of thumb.
  if (client.nextFollowUpAt) {
    const due = new Date(client.nextFollowUpAt).getTime() <= now;
    return { state: due ? "DUE" : "SCHEDULED", daysSinceContact, isDue: due };
  }
  if (daysSinceContact === null) return { state: "NEVER_CONTACTED", daysSinceContact, isDue: true };
  if (daysSinceContact >= QUIET_AFTER_DAYS) return { state: "QUIET", daysSinceContact, isDue: true };
  return { state: "RECENT", daysSinceContact, isDue: false };
};

const toContact = (c) => ({
  id: c.id,
  isPrimary: c.isPrimary,
  name: c.name,
  role: c.role,
  email: c.email,
  phone: c.phone,
  notes: c.notes,
});

const toProject = (p) => ({
  id: p.id,
  name: p.name,
  url: p.url,
  description: p.description,
  status: p.status,
  startedAt: p.startedAt,
  deliveredAt: p.deliveredAt,
  createdAt: p.createdAt,
});

const toTouchpoint = (t) => ({
  id: t.id,
  channel: t.channel,
  summary: t.summary,
  occurredAt: t.occurredAt,
  createdAt: t.createdAt,
});

/** The shape every client list row is rendered from. */
export const toClientCard = (client, now = Date.now()) => {
  const contacts = orderContacts(client.contacts || []);
  const projects = orderProjects(client.projects || []);
  const primary = contacts.find((c) => c.isPrimary) || contacts[0] || null;

  return {
    id: client.id,
    name: client.name,
    status: client.status,
    website: client.website,
    industry: client.industry,
    city: client.city,
    countryCode: client.countryCode,
    countryName: countryName(client.countryCode),
    tags: client.tags || [],
    clientSince: client.clientSince,
    lastContactedAt: client.lastContactedAt,
    nextFollowUpAt: client.nextFollowUpAt,
    createdAt: client.createdAt,
    leadId: client.leadId,
    primaryContact: primary ? toContact(primary) : null,
    // Counts rather than the rows themselves: the card shows "3 people",
    // and the detail view is one click away for the rest.
    teamSize: contacts.length,
    projectCount: client._count?.projects ?? projects.length,
    latestProject: projects[0] ? toProject(projects[0]) : null,
    health: contactHealth(client, now),
  };
};

/** The full record behind one client. */
export const toClientDetail = (client, now = Date.now()) => ({
  ...toClientCard(client, now),
  notes: client.notes,
  updatedAt: client.updatedAt,
  contacts: orderContacts(client.contacts || []).map(toContact),
  projects: orderProjects(client.projects || []).map(toProject),
  touchpoints: (client.touchpoints || []).map(toTouchpoint),
});
