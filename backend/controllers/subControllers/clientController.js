import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { countryName } from "../../utils/countries.js";
import {
  QUIET_AFTER_DAYS, clientKey, safeExternalUrl, nullifyBlank,
  toClientCard, toClientDetail,
} from "../../lib/clients/clientBook.js";

/**
 * The client book.
 *
 * Read as a whole, this file has one job the lead side does not: everything in
 * it was typed by a person, so nothing may be silently "corrected". The only
 * transformations applied are the ones a user would expect — trimming, dropping
 * empty strings, lowercasing an email, and refusing a link that is not http(s).
 */

// ─── Shared field schemas ────────────────────────────────────────────────────

const optionalText = (max) =>
  z.union([z.string().trim().max(max), z.literal("")]).nullable().optional();

const optionalEmail = z
  .union([z.string().trim().toLowerCase().email("That does not look like an email address.").max(255), z.literal("")])
  .nullable()
  .optional();

/** A date the user picked, or nothing. Empty string clears it. */
const optionalDate = z
  .union([z.coerce.date(), z.literal("")])
  .nullable()
  .optional();

const contactSchema = z.object({
  /// Present when editing an existing row, absent when adding one. Sending an
  /// id that belongs to another client is rejected rather than reassigned.
  id: z.string().max(64).optional(),
  name: optionalText(120),
  role: optionalText(120),
  email: optionalEmail,
  phone: optionalText(40),
  notes: optionalText(500),
  isPrimary: z.boolean().optional(),
});

const clientBodySchema = z.object({
  name: z.string().trim().min(2, "Give the client a name of at least 2 characters.").max(200),
  status: z.enum(["ACTIVE", "PAST", "ON_HOLD", "ARCHIVED"]).optional(),
  website: optionalText(500),
  industry: optionalText(120),
  city: optionalText(120),
  countryCode: z
    .union([z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter country code."), z.literal("")])
    .nullable()
    .optional(),
  notes: optionalText(4000),
  // Capped so one paste cannot turn the filter bar into a wall of chips.
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  clientSince: optionalDate,
  nextFollowUpAt: optionalDate,
  // Omitted entirely = leave the team untouched. An explicit array replaces it.
  contacts: z.array(contactSchema).max(25).optional(),
});

export const createSchema = clientBodySchema;
export const updateSchema = clientBodySchema;

export const projectSchema = z.object({
  name: z.string().trim().min(1, "Give the project a name.").max(200),
  url: optionalText(500),
  description: optionalText(4000),
  status: z.enum(["IN_PROGRESS", "DELIVERED", "MAINTENANCE", "ON_HOLD", "CANCELLED"]).optional(),
  startedAt: optionalDate,
  deliveredAt: optionalDate,
});

export const touchpointSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP", "PHONE", "CONTACT_FORM", "SOCIAL"]).default("EMAIL"),
  summary: z.string().trim().min(1, "Write a line about what was discussed.").max(2000),
  occurredAt: optionalDate,
  /// Booking the next check-in as part of logging this one — the single most
  /// common follow-on action, so it does not deserve a second round-trip.
  nextFollowUpAt: optionalDate,
});

export const listSchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.string().max(120).optional(),
  country: z.string().max(400).optional(),
  tag: z.string().trim().max(32).optional(),
  /// "true" narrows to clients a check-in is owed for.
  due: z.enum(["true", "false"]).optional(),
  sort: z.enum(["recent", "name", "quiet", "followup", "added"]).default("recent"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

// ─── Query building ──────────────────────────────────────────────────────────

const CLIENT_STATUSES = ["ACTIVE", "PAST", "ON_HOLD", "ARCHIVED"];

/** Anything a check-in is owed on right now, expressed as a Prisma filter. */
const dueFilter = () => {
  const quietBefore = new Date(Date.now() - QUIET_AFTER_DAYS * 86_400_000);
  return {
    status: { not: "ARCHIVED" },
    OR: [
      // An explicit date that has arrived beats every rule of thumb.
      { nextFollowUpAt: { lte: new Date() } },
      // No date booked, and either never contacted or quiet for a season.
      { AND: [{ nextFollowUpAt: null }, { lastContactedAt: null }] },
      { AND: [{ nextFollowUpAt: null }, { lastContactedAt: { lte: quietBefore } }] },
    ],
  };
};

/**
 * One construction of "matching clients", shared by the list, the facet counts
 * and the totals — so a badge and its list can never disagree.
 */
const buildListWhere = (q) => {
  const where = { AND: [] };

  if (q.status) {
    const picked = q.status.split(",").map((s) => s.trim().toUpperCase()).filter((s) => CLIENT_STATUSES.includes(s));
    // An all-invalid status filter matches nothing, rather than silently
    // widening to everything.
    where.AND.push(picked.length ? { status: { in: picked } } : { id: { in: [] } });
  } else {
    // Archived is opt-in: it is the way to say "stop showing me this".
    where.AND.push({ status: { not: "ARCHIVED" } });
  }

  if (q.country) {
    const parts = q.country.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const codes = [...new Set(parts.filter((p) => /^[A-Z]{2}$/.test(p)))];
    const unknown = parts.includes("UNKNOWN");
    if (!codes.length && !unknown) where.AND.push({ id: { in: [] } });
    else {
      where.AND.push({
        OR: [
          ...(codes.length ? [{ countryCode: { in: codes } }] : []),
          ...(unknown ? [{ countryCode: null }] : []),
        ],
      });
    }
  }

  if (q.tag) where.AND.push({ tags: { has: q.tag } });
  if (q.due === "true") where.AND.push(dueFilter());

  // Free-text search reaches the things a person actually remembers about a
  // client: who they are, where they are, who they spoke to, what was built.
  if (q.q) {
    const term = q.q;
    where.AND.push({
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { industry: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        { website: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        { tags: { has: term.toLowerCase() } },
        { contacts: { some: { name: { contains: term, mode: "insensitive" } } } },
        { contacts: { some: { email: { contains: term, mode: "insensitive" } } } },
        { contacts: { some: { phone: { contains: term, mode: "insensitive" } } } },
        { projects: { some: { name: { contains: term, mode: "insensitive" } } } },
        { projects: { some: { description: { contains: term, mode: "insensitive" } } } },
      ],
    });
  }

  return where;
};

const orderFor = (sort) => {
  switch (sort) {
    case "name": return [{ name: "asc" }, { id: "desc" }];
    // Nulls first is the point of this sort: a client nobody has ever called is
    // the quietest one there is.
    case "quiet": return [{ lastContactedAt: { sort: "asc", nulls: "first" } }, { id: "desc" }];
    case "followup": return [{ nextFollowUpAt: { sort: "asc", nulls: "last" } }, { id: "desc" }];
    case "added": return [{ createdAt: "desc" }, { id: "desc" }];
    default: return [{ updatedAt: "desc" }, { id: "desc" }];
  }
};

/** Everything the card and detail serialisers expect to find loaded. */
const cardInclude = {
  contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
  projects: { orderBy: { createdAt: "desc" }, take: 1 },
  _count: { select: { projects: true } },
};

// ─── Input cleaning ──────────────────────────────────────────────────────────

/** Lowercased, de-duplicated, order preserved — chips must not repeat. */
const cleanTags = (tags) => {
  if (tags === undefined) return undefined;
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    const tag = String(raw).trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
};

/** An unparseable date is a caller error, not a silently dropped field. */
const cleanDate = (value, field) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw createError(400, `${field} is not a valid date.`, { field });
  return date;
};

const cleanClientCore = (body) => {
  // `undefined` = the field was not sent and must be left alone; `null` = the
  // user cleared it. Only a non-empty value is put through the scheme guard.
  const rawWebsite = body.website === undefined ? undefined : nullifyBlank(body.website);
  const website = rawWebsite ? safeExternalUrl(rawWebsite) : rawWebsite;
  if (rawWebsite && !website) {
    throw createError(400, "The website must be a web address, e.g. acme.com or https://acme.com.", { field: "website" });
  }

  const tags = cleanTags(body.tags);

  return {
    name: body.name.trim(),
    normalizedName: clientKey(body.name),
    ...(body.status ? { status: body.status } : {}),
    website,
    industry: nullifyBlank(body.industry),
    city: nullifyBlank(body.city),
    countryCode: body.countryCode === undefined ? undefined : (nullifyBlank(body.countryCode)?.toUpperCase() ?? null),
    notes: nullifyBlank(body.notes),
    ...(tags !== undefined ? { tags } : {}),
    clientSince: cleanDate(body.clientSince, "clientSince"),
    nextFollowUpAt: cleanDate(body.nextFollowUpAt, "nextFollowUpAt"),
  };
};

/**
 * A contact row is only worth storing if it can identify or reach someone.
 * Blank repeater rows are dropped rather than saved as empty people.
 */
const meaningfulContact = (c) => Boolean(nullifyBlank(c.name) || nullifyBlank(c.email) || nullifyBlank(c.phone));

const cleanContact = (c) => ({
  name: nullifyBlank(c.name),
  role: nullifyBlank(c.role),
  email: nullifyBlank(c.email)?.toLowerCase() ?? null,
  phone: nullifyBlank(c.phone),
  notes: nullifyBlank(c.notes),
});

/**
 * Exactly one primary, always. The user's tick wins; failing that the first row
 * is promoted, because a client with people but no primary would show a blank
 * contact line on the card for no reason the user could see or fix.
 */
const withSinglePrimary = (contacts) => {
  const explicit = contacts.findIndex((c) => c.isPrimary === true);
  const primaryIndex = explicit >= 0 ? explicit : 0;
  return contacts.map((c, i) => ({ ...c, isPrimary: i === primaryIndex }));
};

const cleanProject = (body) => {
  const rawUrl = body.url === undefined ? undefined : nullifyBlank(body.url);
  const url = rawUrl ? safeExternalUrl(rawUrl) : rawUrl;
  if (rawUrl && !url) {
    throw createError(400, "The project link must be a web address, e.g. https://app.acme.com.", { field: "url" });
  }
  return {
    name: body.name.trim(),
    url,
    description: nullifyBlank(body.description),
    ...(body.status ? { status: body.status } : {}),
    startedAt: cleanDate(body.startedAt, "startedAt"),
    deliveredAt: cleanDate(body.deliveredAt, "deliveredAt"),
  };
};

/** 404 before anything else, so a bad id never reaches a write. */
const mustFindClient = async (id) => {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) throw createError(404, "Client not found.");
  return client;
};

/** The duplicate guard, phrased so the user knows which record to go and find. */
const assertNameFree = async (name, exceptId) => {
  const key = clientKey(name);
  const clash = await prisma.client.findUnique({ where: { normalizedName: key }, select: { id: true, name: true } });
  if (clash && clash.id !== exceptId) {
    throw createError(409, `"${clash.name}" is already in the client book. Open that record instead of creating a second one.`, { field: "name" });
  }
};

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /api/clients */
export const listClients = asyncHandler(async (req, res) => {
  const q = req.validatedQuery;
  const where = buildListWhere(q);

  const [total, clients] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy: orderFor(q.sort),
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: cardInclude,
    }),
  ]);

  const now = Date.now();
  res.json({
    success: true,
    data: { clients: clients.map((c) => toClientCard(c, now)), total, page: q.page, pageSize: q.pageSize },
  });
});

/**
 * GET /api/clients/facets
 *
 * What the filter bar is allowed to offer, derived from the rows that exist.
 * A filter that can only ever return nothing is worse than no filter at all.
 */
export const clientFacets = asyncHandler(async (req, res) => {
  const [byStatus, rows, dueCount, projectTotal] = await Promise.all([
    prisma.client.groupBy({ by: ["status"], _count: { _all: true } }),
    // Tallied in memory rather than with groupBy: `tags` is a Postgres array,
    // which cannot be grouped without raw SQL. Safe because the client book is
    // hand-entered and stays in the hundreds — unlike the lead table.
    prisma.client.findMany({ where: { status: { not: "ARCHIVED" } }, select: { countryCode: true, tags: true } }),
    prisma.client.count({ where: dueFilter() }),
    prisma.clientProject.count(),
  ]);

  const statusCounts = Object.fromEntries(CLIENT_STATUSES.map((s) => [s, 0]));
  for (const row of byStatus) statusCounts[row.status] = row._count._all;

  const countryTally = new Map();
  const tagTally = new Map();
  for (const row of rows) {
    const key = row.countryCode || "UNKNOWN";
    countryTally.set(key, (countryTally.get(key) || 0) + 1);
    for (const tag of row.tags) tagTally.set(tag, (tagTally.get(tag) || 0) + 1);
  }

  res.json({
    success: true,
    data: {
      statusCounts,
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      activeCount: statusCounts.ACTIVE,
      dueCount,
      projectCount: projectTotal,
      countries: [...countryTally.entries()]
        .map(([code, clientCount]) => ({
          code,
          name: code === "UNKNOWN" ? "Not recorded" : countryName(code),
          clientCount,
        }))
        .sort((a, b) => b.clientCount - a.clientCount || a.name.localeCompare(b.name)),
      tags: [...tagTally.entries()]
        .map(([tag, clientCount]) => ({ tag, clientCount }))
        .sort((a, b) => b.clientCount - a.clientCount || a.tag.localeCompare(b.tag)),
    },
  });
});

/** GET /api/clients/:id */
export const getClient = asyncHandler(async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      projects: { orderBy: { createdAt: "desc" } },
      // Capped: the timeline is a memory aid, not an archive to scroll.
      touchpoints: { orderBy: { occurredAt: "desc" }, take: 50 },
      _count: { select: { projects: true } },
    },
  });
  if (!client) throw createError(404, "Client not found.");
  res.json({ success: true, data: { client: toClientDetail(client) } });
});

/** POST /api/clients */
export const createClient = asyncHandler(async (req, res) => {
  await assertNameFree(req.body.name);

  const contacts = withSinglePrimary((req.body.contacts || []).filter(meaningfulContact)).map((c) => ({
    ...cleanContact(c),
    isPrimary: c.isPrimary,
  }));

  const created = await prisma.client.create({
    data: {
      ...cleanClientCore(req.body),
      tags: cleanTags(req.body.tags) ?? [],
      ...(contacts.length ? { contacts: { create: contacts } } : {}),
    },
    include: cardInclude,
  });

  res.status(201).json({
    success: true,
    message: `${created.name} added to the client book.`,
    data: { client: toClientCard(created) },
  });
});

/**
 * PUT /api/clients/:id
 *
 * The team list is reconciled rather than wiped and rebuilt: rows keep their
 * ids, so the check-in history and any future per-contact data stay attached to
 * the same person across an edit.
 */
export const updateClient = asyncHandler(async (req, res) => {
  const existing = await mustFindClient(req.params.id);
  await assertNameFree(req.body.name, existing.id);

  const core = cleanClientCore(req.body);

  if (req.body.contacts === undefined) {
    await prisma.client.update({ where: { id: existing.id }, data: core });
  } else {
    const incoming = withSinglePrimary(req.body.contacts.filter(meaningfulContact));
    const ownedIds = new Set(
      (await prisma.clientContact.findMany({ where: { clientId: existing.id }, select: { id: true } })).map((c) => c.id),
    );
    // An id we do not own is treated as a new row rather than an error: it can
    // only come from a stale form, and refusing the whole save would lose the
    // user's other edits for no benefit.
    const keptIds = incoming.map((c) => c.id).filter((id) => id && ownedIds.has(id));

    await prisma.$transaction([
      prisma.clientContact.deleteMany({ where: { clientId: existing.id, id: { notIn: keptIds.length ? keptIds : ["__none__"] } } }),
      ...incoming.map((c) =>
        c.id && ownedIds.has(c.id)
          ? prisma.clientContact.update({ where: { id: c.id }, data: { ...cleanContact(c), isPrimary: c.isPrimary } })
          : prisma.clientContact.create({ data: { clientId: existing.id, ...cleanContact(c), isPrimary: c.isPrimary } }),
      ),
      prisma.client.update({ where: { id: existing.id }, data: core }),
    ]);
  }

  const saved = await prisma.client.findUnique({ where: { id: existing.id }, include: cardInclude });
  res.json({ success: true, message: `${saved.name} updated.`, data: { client: toClientCard(saved) } });
});

/** DELETE /api/clients/:id */
export const deleteClient = asyncHandler(async (req, res) => {
  const existing = await mustFindClient(req.params.id);
  // Contacts, projects and check-ins go with it via ON DELETE CASCADE — which
  // is why the UI asks twice before getting here.
  await prisma.client.delete({ where: { id: existing.id } });
  res.json({ success: true, message: `${existing.name} removed from the client book.` });
});

/** POST /api/clients/:id/projects */
export const createProject = asyncHandler(async (req, res) => {
  const client = await mustFindClient(req.params.id);
  const project = await prisma.clientProject.create({ data: { clientId: client.id, ...cleanProject(req.body) } });
  // Touch the parent so "recently updated" sorting reflects the new work.
  await prisma.client.update({ where: { id: client.id }, data: { updatedAt: new Date() } });
  res.status(201).json({ success: true, message: `"${project.name}" added.`, data: { project } });
});

/** PUT /api/clients/:id/projects/:projectId */
export const updateProject = asyncHandler(async (req, res) => {
  const existing = await prisma.clientProject.findFirst({
    where: { id: req.params.projectId, clientId: req.params.id },
  });
  if (!existing) throw createError(404, "Project not found.");

  const project = await prisma.clientProject.update({ where: { id: existing.id }, data: cleanProject(req.body) });
  await prisma.client.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });
  res.json({ success: true, message: `"${project.name}" updated.`, data: { project } });
});

/** DELETE /api/clients/:id/projects/:projectId */
export const deleteProject = asyncHandler(async (req, res) => {
  const existing = await prisma.clientProject.findFirst({
    where: { id: req.params.projectId, clientId: req.params.id },
  });
  if (!existing) throw createError(404, "Project not found.");

  await prisma.clientProject.delete({ where: { id: existing.id } });
  res.json({ success: true, message: `"${existing.name}" deleted.` });
});

/**
 * POST /api/clients/:id/touchpoints
 *
 * Logging a conversation is the only thing that moves `lastContactedAt`, and it
 * only ever moves it forward — backdating an old call must not make a client
 * look freshly contacted.
 */
export const logTouchpoint = asyncHandler(async (req, res) => {
  const client = await mustFindClient(req.params.id);
  const occurredAt = cleanDate(req.body.occurredAt, "occurredAt") || new Date();
  if (occurredAt.getTime() > Date.now() + 60_000) {
    throw createError(400, "A check-in cannot be logged in the future. Use the follow-up date for that.", { field: "occurredAt" });
  }
  const nextFollowUpAt = cleanDate(req.body.nextFollowUpAt, "nextFollowUpAt");

  const isNewest = !client.lastContactedAt || occurredAt > client.lastContactedAt;

  /**
   * What happens to the booked follow-up.
   *
   * An explicit value always wins — `null` is how "nothing further needed" is
   * expressed. With nothing supplied, a follow-up that has *already come due* is
   * cleared: the reminder said "call them", and this is the record of that call,
   * so leaving it set would strand the client on the due list forever. A
   * follow-up still in the future is untouched — logging an unrelated chat in
   * September must not cancel the December check-in.
   */
  const followUpUpdate =
    nextFollowUpAt !== undefined ? { nextFollowUpAt }
    : client.nextFollowUpAt && client.nextFollowUpAt <= occurredAt ? { nextFollowUpAt: null }
    : {};

  const [touchpoint] = await prisma.$transaction([
    prisma.clientTouchpoint.create({
      data: { clientId: client.id, channel: req.body.channel, summary: req.body.summary.trim(), occurredAt },
    }),
    prisma.client.update({
      where: { id: client.id },
      data: { ...(isNewest ? { lastContactedAt: occurredAt } : {}), ...followUpUpdate },
    }),
  ]);

  const saved = await prisma.client.findUnique({ where: { id: client.id }, include: cardInclude });
  res.status(201).json({
    success: true,
    message: "Check-in logged.",
    data: { touchpoint, client: toClientCard(saved) },
  });
});
