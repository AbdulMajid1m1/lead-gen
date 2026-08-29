/**
 * Console permissions.
 *
 * One key per sidebar destination, because that is how access to this product
 * is actually reasoned about: "this person works the client book and nothing
 * else". The key set is deliberately coarse — it is a map over screens, not an
 * ACL over rows — and it stays legible precisely because it mirrors the nav.
 *
 * This file is the single source of truth. Routes reference these keys through
 * requirePermission(), /auth/me returns the effective set, and the admin UI
 * renders the catalogue exported here. Adding a screen means adding a key here
 * and referencing it in RootRoute.js — nowhere else.
 *
 * Team management is *not* a key. It is bound to the ADMIN role instead, so the
 * ability to grant permissions can never itself be granted away: a member who
 * could tick "Team" could tick every other box a second later, which would make
 * the whole model decorative.
 */

/** @typedef {{ key: string, label: string, description: string, group: string }} Permission */

/** @type {Permission[]} */
export const PERMISSIONS = [
  {
    key: "dashboard",
    label: "Dashboard",
    description: "The pipeline overview: lead counts, scores and recent activity.",
    group: "Overview",
  },
  {
    key: "research",
    label: "Deep research",
    description: "Run AI research briefs and read their result grids.",
    group: "Finding leads",
  },
  {
    key: "promoter",
    label: "SaaS Promoter",
    description: "Set up promoted products, approve their ICP and launch runs for them.",
    group: "Finding leads",
  },
  {
    key: "search",
    label: "Quick search",
    description: "Search the existing lead set and trigger discovery for a query.",
    group: "Finding leads",
  },
  {
    key: "discovery",
    label: "Discovery runs",
    description: "Start manual discovery runs and watch run progress.",
    group: "Finding leads",
  },
  {
    key: "leads",
    label: "All leads",
    description: "Browse the lead list, open a lead, read its provenance and change its status.",
    group: "Working leads",
  },
  {
    key: "outreach",
    label: "Outreach",
    description: "Send emails and WhatsApp messages, and run bulk campaigns. Every send is recorded against the sender.",
    group: "Working leads",
  },
  {
    key: "inbox",
    label: "Inbox",
    description: "Work the reply queue: read replies, send due follow-ups, sync mailboxes.",
    group: "Working leads",
  },
  {
    key: "clients",
    label: "Clients",
    description: "The client book: companies already won, their projects and check-ins.",
    group: "Working leads",
  },
  {
    key: "settings",
    label: "Settings",
    description: "Connect mailboxes and WhatsApp devices, edit signatures and the suppression list.",
    group: "Administration",
  },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const KEY_SET = new Set(PERMISSION_KEYS);
const ORDER = new Map(PERMISSION_KEYS.map((key, i) => [key, i]));

export const isPermissionKey = (key) => KEY_SET.has(key);

/**
 * Console roles.
 *
 * ADMIN is the seat that already exists — the super admin. It keeps implicit
 * access to everything so that provisioning a colleague can never accidentally
 * lock the owner out of their own console.
 *
 * VIEWER predates this feature and was documented as "a future read-only seat";
 * it now means exactly that — the granted screens, but no writes. MEMBER is the
 * ordinary provisioned seat: the granted screens, with the ability to act.
 */
export const ROLES = {
  ADMIN: {
    key: "ADMIN",
    label: "Super admin",
    description: "Full access to every screen, plus the ability to add people and set their permissions.",
    implicitAll: true,
    manageUsers: true,
    readOnly: false,
  },
  MEMBER: {
    key: "MEMBER",
    label: "Member",
    description: "Sees only the screens ticked below, and can act on them.",
    implicitAll: false,
    manageUsers: false,
    readOnly: false,
  },
  VIEWER: {
    key: "VIEWER",
    label: "Viewer (read-only)",
    description: "Sees only the screens ticked below, and cannot change anything — no sends, no edits.",
    implicitAll: false,
    manageUsers: false,
    readOnly: true,
  },
};

export const ROLE_KEYS = Object.keys(ROLES);

const roleOf = (user) => ROLES[user?.role] || ROLES.MEMBER;

/**
 * Starting points for a new seat, so provisioning someone does not begin with
 * ten unticked boxes and a guess. Every preset is editable after it is applied
 * — they set the tick boxes, they are not a second permission model.
 */
export const PERMISSION_PRESETS = [
  {
    key: "SALES_PROMOTER",
    label: "Sales promoter",
    description: "Promotes products, works the leads they produce and does the outreach.",
    role: "MEMBER",
    permissions: ["dashboard", "promoter", "leads", "outreach", "inbox"],
  },
  {
    key: "OUTREACH_OPERATOR",
    label: "Outreach operator",
    description: "Sends and chases, but does not run discovery or research.",
    role: "MEMBER",
    permissions: ["dashboard", "leads", "outreach", "inbox"],
  },
  {
    key: "CLIENT_MANAGER",
    label: "Client manager",
    description: "Looks after existing clients and the replies coming back from them.",
    role: "MEMBER",
    permissions: ["dashboard", "clients", "inbox"],
  },
  {
    key: "RESEARCHER",
    label: "Researcher",
    description: "Finds and qualifies leads; does not contact anyone.",
    role: "MEMBER",
    permissions: ["dashboard", "research", "search", "discovery", "leads"],
  },
  {
    key: "READ_ONLY",
    label: "Read-only observer",
    description: "Can look at the whole pipeline and change nothing.",
    role: "VIEWER",
    permissions: ["dashboard", "leads", "outreach", "inbox", "clients"],
  },
];

/**
 * Clean an arbitrary list of keys into a canonical permission set: unknown and
 * duplicate keys dropped, catalogue order preserved. Never throws — a bad key
 * in a request body is not worth a 500, and dropping it is the safe reading.
 */
export const normalizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  const unique = new Set(input.filter((k) => typeof k === "string" && KEY_SET.has(k)));
  return [...unique].sort((a, b) => ORDER.get(a) - ORDER.get(b));
};

/**
 * What this account can actually reach right now.
 *
 * An ADMIN's stored list is ignored on purpose: the role *is* the grant, so a
 * super admin whose row happens to carry an empty array still sees everything.
 */
export const effectivePermissions = (user) => {
  if (!user) return [];
  return roleOf(user).implicitAll ? [...PERMISSION_KEYS] : normalizePermissions(user.permissions);
};

/** True when the account holds at least one of `keys`. Empty `keys` = allow. */
export const hasAnyPermission = (user, keys = []) => {
  if (!user) return false;
  if (keys.length === 0) return true;
  if (roleOf(user).implicitAll) return true;
  const granted = new Set(normalizePermissions(user.permissions));
  return keys.some((k) => granted.has(k));
};

/** VIEWER seats may read their granted screens but never write to them. */
export const isReadOnly = (user) => roleOf(user).readOnly === true;

/** Only a super admin provisions accounts or changes what anyone else can see. */
export const canManageUsers = (user) => roleOf(user).manageUsers === true;

/** The catalogue the admin UI renders, so labels can never drift from routes. */
export const permissionCatalog = () => ({
  permissions: PERMISSIONS,
  roles: ROLE_KEYS.map((key) => ({
    key,
    label: ROLES[key].label,
    description: ROLES[key].description,
    implicitAll: ROLES[key].implicitAll,
    readOnly: ROLES[key].readOnly,
    manageUsers: ROLES[key].manageUsers,
  })),
  presets: PERMISSION_PRESETS,
});
