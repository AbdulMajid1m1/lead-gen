/**
 * The navigation map, keyed by permission.
 *
 * The backend owns the permission catalogue (labels, descriptions, presets) and
 * serves it to the admin form, so nothing here re-states policy. What lives
 * here is the part that is genuinely the client's: which route each key opens,
 * what it is called in the sidebar, and which icon it wears.
 *
 * Every route in App.jsx is guarded by the same `permission` field the sidebar
 * filters on, so a hidden item can never be reachable by typing its URL — and
 * the API refuses it a third time regardless.
 */
import {
  LayoutDashboard, Search, Users, Radar, Settings, Sparkles,
  Inbox, SendHorizonal, Handshake, Megaphone, ShieldCheck,
} from "lucide-react";

/**
 * @typedef {object} NavItem
 * @property {string} permission  key from the backend catalogue, or "*" for admin-only
 * @property {string} to          the sidebar destination
 * @property {string} label       sidebar label
 * @property {Function} icon      lucide icon component
 * @property {boolean} [end]      exact-match highlighting (the index route)
 * @property {boolean} [badge]    carries the attention count
 * @property {boolean} [adminOnly] visible to super admins only
 */

/** @type {NavItem[]} */
export const NAV_ITEMS = [
  { permission: "dashboard", to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { permission: "research", to: "/research", label: "Deep research", icon: Sparkles },
  // The other way into lead finding: start from a product you sell rather than
  // from a description of who you want, so it belongs beside deep research.
  { permission: "promoter", to: "/promoter", label: "SaaS Promoter", icon: Megaphone },
  { permission: "search", to: "/search", label: "Quick search", icon: Search },
  { permission: "leads", to: "/leads", label: "All leads", icon: Users },
  // `badge` marks the one item that carries a count. Sits directly under the
  // lead-finding screens because it is where a lead goes after you contact it.
  { permission: "outreach", to: "/outreach", label: "Outreach", icon: SendHorizonal },
  { permission: "inbox", to: "/inbox", label: "Inbox", icon: Inbox, badge: true },
  // The post-sale half of the pipeline: everyone the outreach above already won.
  { permission: "clients", to: "/clients", label: "Clients", icon: Handshake },
  { permission: "discovery", to: "/discovery", label: "Discovery runs", icon: Radar },
  { permission: "settings", to: "/settings", label: "Settings", icon: Settings },
  // Not a grantable permission — the ability to hand out access cannot itself
  // be handed out, or the model would be decorative.
  { permission: "*", to: "/users", label: "Team", icon: ShieldCheck, adminOnly: true },
];

/**
 * Does this account hold any one of these permissions?
 *
 * "Any of" matches the API gates: several screens legitimately share an
 * endpoint, and a check that demanded all of them would hide working features.
 * Returns false for a signed-out or still-loading user, so callers can render
 * the restricted state without a separate null check.
 */
export const can = (user, ...keys) => {
  if (!user) return false;
  if (keys.length === 0) return true;
  const granted = user.permissions;
  if (!Array.isArray(granted)) return false;
  return keys.some((key) => granted.includes(key));
};

/** Super admins only: provisioning seats and setting what anyone else can see. */
export const canManageTeam = (user) => Boolean(user?.canManageUsers);

/** A read-only seat sees its screens but is refused every write, here and at the API. */
export const isReadOnly = (user) => Boolean(user?.readOnly);

/** The sidebar for this account, in catalogue order. */
export const navFor = (user) =>
  NAV_ITEMS.filter((item) => (item.adminOnly ? canManageTeam(user) : can(user, item.permission)));

/**
 * Where to send someone who lands on a page they cannot open — their first
 * permitted screen. A member without Dashboard should arrive somewhere useful
 * rather than at a wall, and an account with nothing granted returns null so
 * the app can say so plainly instead of redirecting in a loop.
 */
export const landingPathFor = (user) => navFor(user)[0]?.to ?? null;
