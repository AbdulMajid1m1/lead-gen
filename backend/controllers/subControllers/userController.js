/**
 * Team & permissions — provisioning colleagues and deciding what each may see.
 *
 * Every route in this file is super-admin only (requireUserAdmin in
 * RootRoute.js). Three invariants are enforced here rather than in the UI,
 * because the UI is not the security boundary:
 *
 *   · The last active super admin cannot be demoted, deactivated or deleted.
 *     Losing it would leave a console nobody can administer, recoverable only
 *     by hand at the database.
 *   · Nobody can demote, deactivate or delete themselves. A misclick must not
 *     end with the person holding the keys locked outside.
 *   · A permission grant is stored as keys from the catalogue and nothing else.
 *     Unknown keys are dropped rather than persisted, so a future rename can
 *     never silently resurrect access under an old name.
 *
 * Deactivation is the ordinary way to remove someone: it kills their sessions
 * immediately and keeps every message they ever sent attributable. Deletion is
 * offered too, and is safe — the outreach foreign keys are SetNull and each
 * outbound row carries a name snapshot — but it loses the seat's history of
 * *who they were*, so the UI presents it as the sharper of the two tools.
 */
import { z } from "zod";
import prisma from "../../prismaClient.js";
import { asyncHandler } from "../../middlewares/validate.js";
import { createError } from "../../utils/createError.js";
import { hashPassword, passwordProblem } from "../../lib/auth/password.js";
import { revokeAllSessionsForUser } from "../../lib/auth/session.js";
import { normalizePermissions, permissionCatalog, ROLES } from "../../lib/auth/permissions.js";
import { teamMember } from "../../lib/auth/serialize.js";
import { logger } from "../../utils/logger.js";

const ROLE_VALUES = Object.keys(ROLES);

/** Live sessions per account, so "signed in on 2 devices" is real, not implied. */
const LIVE_SESSIONS = {
  sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
};

const withRelations = {
  createdBy: { select: { id: true, name: true, email: true } },
  _count: { select: LIVE_SESSIONS },
};

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .max(255);

const nameField = z
  .string()
  .trim()
  .min(2, "Enter the person's name, so their sends are attributable.")
  .max(120, "Names are capped at 120 characters.");

const permissionsField = z
  .array(z.string().max(40))
  .max(50)
  .default([]);

export const createUserSchema = z.object({
  name: nameField,
  email: emailField,
  password: z.string().min(1, "Set a password for this account.").max(200),
  role: z.enum(ROLE_VALUES).default("MEMBER"),
  permissions: permissionsField,
});

export const updateUserSchema = z.object({
  name: nameField.optional(),
  role: z.enum(ROLE_VALUES).optional(),
  permissions: permissionsField.optional(),
  isActive: z.boolean().optional(),
});

export const setPasswordSchema = z.object({
  password: z.string().min(1, "Enter the new password.").max(200),
});

/**
 * The grant actually written to the row.
 *
 * A super admin's access comes from the role, so their list is stored empty.
 * That is not cosmetic: it means demoting someone to MEMBER leaves them with
 * nothing until an administrator deliberately ticks boxes, which is the safe
 * direction for a mistake to fail in.
 */
const grantFor = (role, permissions) =>
  role === "ADMIN" ? [] : normalizePermissions(permissions);

/** How many super admins could still sign in if this one went away. */
const otherActiveAdmins = (excludeId) =>
  prisma.adminUser.count({ where: { role: "ADMIN", isActive: true, id: { not: excludeId } } });

/**
 * Refuse a change that would leave nobody able to administer the console, or
 * that the requester is making to their own seat.
 *
 * `intent` is used only in the message — an operator who is stopped deserves to
 * know which of the two rules stopped them.
 */
const guardSeat = async ({ target, actorId, intent, losesAdmin }) => {
  if (target.id === actorId) {
    throw createError(400, `You cannot ${intent} your own account. Ask another super admin to do it.`);
  }
  if (losesAdmin && target.role === "ADMIN" && target.isActive) {
    if ((await otherActiveAdmins(target.id)) === 0) {
      throw createError(400, "This is the last active super admin. Promote someone else first.");
    }
  }
};

const findTarget = async (id) => {
  const user = await prisma.adminUser.findUnique({ where: { id }, include: withRelations });
  if (!user) throw createError(404, "That team member no longer exists.");
  return user;
};

/** GET /api/users/permissions — the catalogue the admin form renders. */
export const catalog = asyncHandler(async (req, res) => {
  res.json({ success: true, data: permissionCatalog() });
});

/** GET /api/users — the team, super admins first, then newest seats. */
export const list = asyncHandler(async (req, res) => {
  const users = await prisma.adminUser.findMany({
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    include: withRelations,
  });
  const now = Date.now();
  res.json({
    success: true,
    data: {
      users: users.map((u) => teamMember(u, { now })),
      activeAdmins: users.filter((u) => u.role === "ADMIN" && u.isActive).length,
    },
  });
});

/** POST /api/users — provision a seat. */
export const create = asyncHandler(async (req, res) => {
  const { name, email, password, role, permissions } = req.body;

  const problem = passwordProblem(password);
  if (problem) throw createError(400, problem, { field: "password" });

  const grant = grantFor(role, permissions);
  if (role !== "ADMIN" && grant.length === 0) {
    throw createError(400, "Give this person at least one section, or they will sign in to an empty console.", {
      field: "permissions",
    });
  }

  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) throw createError(409, "An account with that email address already exists.", { field: "email" });

  const user = await prisma.adminUser.create({
    data: {
      name,
      email,
      passwordHash: await hashPassword(password),
      role,
      permissions: grant,
      createdById: req.auth.user.id,
    },
    include: withRelations,
  });

  logger.info({ userId: user.id, email: user.email, role, grant, by: req.auth.user.id }, "team member provisioned");
  res.status(201).json({
    success: true,
    message: `${user.name} can now sign in with ${user.email}.`,
    data: { user: teamMember(user) },
  });
});

/** PATCH /api/users/:id — name, role, permissions, active state. */
export const update = asyncHandler(async (req, res) => {
  const target = await findTarget(req.params.id);
  const { name, role, permissions, isActive } = req.body;

  const nextRole = role ?? target.role;
  const nextActive = isActive ?? target.isActive;
  const demoting = nextRole !== "ADMIN" && target.role === "ADMIN";
  const deactivating = nextActive === false && target.isActive;

  if (demoting || deactivating) {
    await guardSeat({
      target,
      actorId: req.auth.user.id,
      intent: demoting ? "change the role of" : "deactivate",
      losesAdmin: true,
    });
  }

  const data = {};
  if (name !== undefined) data.name = name;
  if (role !== undefined) data.role = role;
  // Permissions are rewritten whenever either half of the pair moves: switching
  // to ADMIN clears the stored grant, switching away from it must not leave the
  // previous "everything" implied by a stale list.
  if (permissions !== undefined || role !== undefined) {
    data.permissions = grantFor(nextRole, permissions ?? target.permissions);
  }
  if (isActive !== undefined) data.isActive = isActive;

  if (Object.keys(data).length === 0) {
    return res.json({ success: true, message: "Nothing to change.", data: { user: teamMember(target) } });
  }

  if (nextRole !== "ADMIN" && data.permissions?.length === 0 && nextActive) {
    throw createError(400, "Give this person at least one section, or they will sign in to an empty console.", {
      field: "permissions",
    });
  }

  const user = await prisma.adminUser.update({
    where: { id: target.id },
    data,
    include: withRelations,
  });

  // A deactivated account must lose its live sessions now, not whenever they
  // happen to expire. A permission change needs no such sweep: rights are read
  // from this row on every request.
  if (deactivating) await revokeAllSessionsForUser(user.id);

  logger.info({ userId: user.id, changes: Object.keys(data), by: req.auth.user.id }, "team member updated");
  res.json({
    success: true,
    message: deactivating
      ? `${user.name || user.email} has been deactivated and signed out everywhere.`
      : `${user.name || user.email} updated.`,
    data: { user: teamMember(user) },
  });
});

/**
 * POST /api/users/:id/password — set a colleague's password.
 *
 * Every session of theirs is revoked: an administrator resetting a password is
 * either onboarding someone or responding to a suspected compromise, and both
 * want the old sessions gone.
 */
export const setPassword = asyncHandler(async (req, res) => {
  const target = await findTarget(req.params.id);
  if (target.id === req.auth.user.id) {
    throw createError(400, "Change your own password from Settings, so it is confirmed with the current one.");
  }

  const problem = passwordProblem(req.body.password);
  if (problem) throw createError(400, problem, { field: "password" });

  await prisma.adminUser.update({
    where: { id: target.id },
    data: {
      passwordHash: await hashPassword(req.body.password),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await revokeAllSessionsForUser(target.id);

  logger.warn({ userId: target.id, by: req.auth.user.id }, "team member password reset by a super admin");
  res.json({
    success: true,
    message: `Password set. ${target.name || target.email} has been signed out everywhere and must use the new one.`,
    data: null,
  });
});

/** POST /api/users/:id/unlock — clear a credential-stuffing lockout. */
export const unlock = asyncHandler(async (req, res) => {
  const target = await findTarget(req.params.id);
  const user = await prisma.adminUser.update({
    where: { id: target.id },
    data: { failedLoginCount: 0, lockedUntil: null },
    include: withRelations,
  });
  res.json({
    success: true,
    message: `${user.name || user.email} can sign in again.`,
    data: { user: teamMember(user) },
  });
});

/** POST /api/users/:id/sessions/revoke — sign a colleague out of every device. */
export const revokeSessions = asyncHandler(async (req, res) => {
  const target = await findTarget(req.params.id);
  await revokeAllSessionsForUser(target.id);
  logger.info({ userId: target.id, by: req.auth.user.id }, "team member sessions revoked");
  res.json({
    success: true,
    message: `${target.name || target.email} has been signed out on every device.`,
    data: null,
  });
});

/**
 * DELETE /api/users/:id — remove a seat for good.
 *
 * Sessions cascade. Outreach does not: threads, messages and campaigns keep
 * their name snapshot and drop the foreign key, so the record of who contacted
 * a lead survives the account that did it.
 */
export const remove = asyncHandler(async (req, res) => {
  const target = await findTarget(req.params.id);
  await guardSeat({ target, actorId: req.auth.user.id, intent: "delete", losesAdmin: true });

  await prisma.adminUser.delete({ where: { id: target.id } });
  logger.warn({ userId: target.id, email: target.email, by: req.auth.user.id }, "team member deleted");
  res.json({
    success: true,
    message: `${target.name || target.email} has been removed. Their outreach history is kept under their name.`,
    data: null,
  });
});
