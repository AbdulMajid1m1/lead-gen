/**
 * What the client is allowed to know about an account.
 *
 * Two shapes, deliberately different:
 *
 *   publicUser  — you, about yourself. Enough for the app to decide which nav
 *                 items and actions exist.
 *   teamMember  — a super admin, about a colleague. Adds the operational state
 *                 a person needs to administer the seat (active, locked, who
 *                 provisioned it).
 *
 * Neither ever carries passwordHash. The lockout counters appear only in the
 * admin shape, because "this account is locked" is something an administrator
 * has to be able to see and clear.
 */
import { ROLES, effectivePermissions, isReadOnly, canManageUsers } from "./permissions.js";

/** The signed-in account, as returned by /auth/login and /auth/me. */
export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  roleLabel: ROLES[user.role]?.label || user.role,
  // Already expanded: an ADMIN's implicit "everything" is resolved here so the
  // frontend never has to re-implement the rule that decides it.
  permissions: effectivePermissions(user),
  readOnly: isReadOnly(user),
  canManageUsers: canManageUsers(user),
  lastLoginAt: user.lastLoginAt,
});

/** A colleague, as shown in Team & permissions. */
export const teamMember = (user, { now = Date.now() } = {}) => ({
  ...publicUser(user),
  // The stored grant rather than the effective one: the admin form edits what
  // was ticked, and showing an ADMIN with ten ticks would imply removing one
  // would do something.
  grantedPermissions: Array.isArray(user.permissions) ? user.permissions : [],
  isActive: user.isActive,
  isLocked: Boolean(user.lockedUntil && user.lockedUntil.getTime() > now),
  lockedUntil: user.lockedUntil,
  failedLoginCount: user.failedLoginCount,
  createdById: user.createdById,
  createdByName: user.createdBy?.name || user.createdBy?.email || null,
  activeSessionCount: user._count?.sessions ?? undefined,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});
