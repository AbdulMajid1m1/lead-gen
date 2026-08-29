import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_PRESETS,
  ROLES,
  canManageUsers,
  effectivePermissions,
  hasAnyPermission,
  isPermissionKey,
  isReadOnly,
  normalizePermissions,
  permissionCatalog,
} from "../../lib/auth/permissions.js";
import { publicUser, teamMember } from "../../lib/auth/serialize.js";
import { toActor } from "../../lib/outreach/attribution.js";

const member = (permissions = []) => ({ id: "u1", role: "MEMBER", permissions });
const viewer = (permissions = []) => ({ id: "u2", role: "VIEWER", permissions });
const admin = (permissions = []) => ({ id: "u3", role: "ADMIN", permissions });

describe("permission catalogue", () => {
  it("has a unique, non-empty key per entry", () => {
    expect(PERMISSION_KEYS.length).toBe(PERMISSIONS.length);
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(/^[a-z][a-z-]*$/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.group.length).toBeGreaterThan(0);
    }
  });

  // The whole model rests on "the sidebar is the permission set". A preset that
  // grants a key nobody enforces would be a promise the API cannot keep.
  it("only ever offers presets built from real keys", () => {
    for (const preset of PERMISSION_PRESETS) {
      expect(ROLES[preset.role]).toBeDefined();
      expect(preset.permissions.length).toBeGreaterThan(0);
      for (const key of preset.permissions) expect(isPermissionKey(key)).toBe(true);
    }
  });

  it("exposes a catalogue the admin form can render whole", () => {
    const catalog = permissionCatalog();
    expect(catalog.permissions).toHaveLength(PERMISSIONS.length);
    expect(catalog.roles.map((r) => r.key)).toEqual(["ADMIN", "MEMBER", "VIEWER"]);
    expect(catalog.presets).toHaveLength(PERMISSION_PRESETS.length);
  });
});

describe("normalizePermissions", () => {
  it("drops unknown keys rather than storing them", () => {
    expect(normalizePermissions(["leads", "nope", "root", "clients"])).toEqual(["leads", "clients"]);
  });

  it("de-duplicates and orders by the catalogue, so stored grants compare equal", () => {
    expect(normalizePermissions(["clients", "leads", "leads", "dashboard"]))
      .toEqual(["dashboard", "leads", "clients"]);
  });

  it("treats junk input as no permissions at all", () => {
    for (const junk of [null, undefined, "leads", 7, {}, [null, 3, false]]) {
      expect(normalizePermissions(junk)).toEqual([]);
    }
  });
});

describe("effectivePermissions", () => {
  it("gives a super admin everything, whatever the stored list says", () => {
    expect(effectivePermissions(admin([]))).toEqual(PERMISSION_KEYS);
    expect(effectivePermissions(admin(["leads"]))).toEqual(PERMISSION_KEYS);
  });

  it("gives everyone else exactly what was granted", () => {
    expect(effectivePermissions(member(["leads", "outreach"]))).toEqual(["leads", "outreach"]);
    expect(effectivePermissions(member([]))).toEqual([]);
    expect(effectivePermissions(null)).toEqual([]);
  });

  // The default has to be "nothing": an account whose role we do not recognise
  // must fail closed, not inherit the widest seat.
  it("falls back to the granted list for an unrecognised role", () => {
    expect(effectivePermissions({ role: "WHATEVER", permissions: ["leads"] })).toEqual(["leads"]);
    expect(effectivePermissions({ role: "WHATEVER", permissions: [] })).toEqual([]);
  });
});

describe("hasAnyPermission", () => {
  it("passes when any one of the keys is held", () => {
    const u = member(["promoter"]);
    expect(hasAnyPermission(u, ["leads", "promoter", "outreach"])).toBe(true);
    expect(hasAnyPermission(u, ["leads", "outreach"])).toBe(false);
  });

  it("lets a super admin through every gate", () => {
    expect(hasAnyPermission(admin(), ["settings"])).toBe(true);
  });

  it("refuses an absent user, and treats an empty gate as open", () => {
    expect(hasAnyPermission(null, ["leads"])).toBe(false);
    expect(hasAnyPermission(member([]), [])).toBe(true);
  });
});

describe("roles", () => {
  it("marks only VIEWER read-only", () => {
    expect(isReadOnly(viewer(["leads"]))).toBe(true);
    expect(isReadOnly(member(["leads"]))).toBe(false);
    expect(isReadOnly(admin())).toBe(false);
  });

  it("lets only a super admin manage the team", () => {
    expect(canManageUsers(admin())).toBe(true);
    expect(canManageUsers(member(PERMISSION_KEYS))).toBe(false);
    expect(canManageUsers(viewer(PERMISSION_KEYS))).toBe(false);
    expect(canManageUsers(null)).toBe(false);
  });

  it("still grants a read-only viewer the screens they were given", () => {
    expect(hasAnyPermission(viewer(["clients"]), ["clients"])).toBe(true);
  });
});

describe("user serialisation", () => {
  const row = {
    id: "u9",
    email: "sales@example.com",
    name: "Sales Promoter",
    role: "MEMBER",
    permissions: ["leads", "outreach"],
    passwordHash: "scrypt$secret",
    failedLoginCount: 3,
    lockedUntil: new Date(Date.now() + 60_000),
    lastLoginAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("never leaks the password digest", () => {
    expect(JSON.stringify(publicUser(row))).not.toContain("scrypt$");
    expect(JSON.stringify(teamMember(row))).not.toContain("scrypt$");
  });

  it("resolves the effective set for the client, so the UI never re-derives it", () => {
    expect(publicUser(row).permissions).toEqual(["leads", "outreach"]);
    expect(publicUser({ ...row, role: "ADMIN" }).permissions).toEqual(PERMISSION_KEYS);
  });

  it("shows an administrator the grant as stored, not as expanded", () => {
    expect(teamMember({ ...row, role: "ADMIN" }).grantedPermissions).toEqual(["leads", "outreach"]);
  });

  it("reports a live lockout", () => {
    expect(teamMember(row).isLocked).toBe(true);
    expect(teamMember({ ...row, lockedUntil: new Date(Date.now() - 60_000) }).isLocked).toBe(false);
    expect(teamMember({ ...row, lockedUntil: null }).isLocked).toBe(false);
  });
});

describe("send attribution", () => {
  it("records the person's name, falling back to their address", () => {
    expect(toActor({ id: "u1", name: "Aisha", email: "a@x.com" })).toEqual({ id: "u1", name: "Aisha" });
    expect(toActor({ id: "u1", name: null, email: "a@x.com" })).toEqual({ id: "u1", name: "a@x.com" });
  });

  it("treats a missing user as a system send rather than guessing", () => {
    expect(toActor(null)).toBeNull();
    expect(toActor(undefined)).toBeNull();
    expect(toActor({ name: "No id" })).toBeNull();
  });

  it("keeps the snapshot inside the column width", () => {
    expect(toActor({ id: "u1", name: "n".repeat(400) }).name).toHaveLength(160);
  });
});
