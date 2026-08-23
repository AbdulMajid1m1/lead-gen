import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../../lib/auth/password.js";
import { parseCookies } from "../../middlewares/requireAuth.js";

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", digest)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const digest = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", digest)).toBe(false);
    expect(await verifyPassword("", digest)).toBe(false);
  });

  it("salts, so the same password never produces the same digest", async () => {
    const a = await hashPassword("same-password-twice");
    const b = await hashPassword("same-password-twice");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-twice", a)).toBe(true);
    expect(await verifyPassword("same-password-twice", b)).toBe(true);
  });

  it("encodes its parameters so cost can be raised later", async () => {
    const digest = await hashPassword("whatever");
    expect(digest.split("$")).toHaveLength(6);
    expect(digest.startsWith("scrypt$")).toBe(true);
  });

  // A corrupted or truncated row must lock that account out, not 500 the
  // login route for everyone.
  it("returns false rather than throwing on a malformed digest", async () => {
    for (const bad of ["", "not-a-digest", "scrypt$1$2$3", "bcrypt$1$2$3$4$5", "scrypt$x$y$z$!!$!!"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword(null, "scrypt$1$2$3$4$5")).toBe(false);
  });

  it("flags weak provisioning passwords", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("alllowercaseletters")).toMatch(/upper-case/);
    expect(passwordProblem("1DeventiaTech00@30")).toBeNull();
  });
});

describe("cookie parsing", () => {
  it("reads a single cookie", () => {
    expect(parseCookies("leadsignal_session=abc123")).toEqual({ leadsignal_session: "abc123" });
  });

  it("reads several cookies and trims whitespace", () => {
    expect(parseCookies("a=1; b=2;   c=3")).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("keeps the first occurrence, as browsers do", () => {
    expect(parseCookies("s=first; s=second").s).toBe("first");
  });

  it("handles quoted and percent-encoded values", () => {
    expect(parseCookies('q="quoted"').q).toBe("quoted");
    expect(parseCookies("e=a%40b.com").e).toBe("a@b.com");
    // A malformed escape must not throw — the value is still usable opaquely.
    expect(parseCookies("bad=%E0%A4%A").bad).toBe("%E0%A4%A");
  });

  it("returns an empty object for absent or junk headers", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("novalue")).toEqual({});
    expect(parseCookies("=novalue")).toEqual({});
  });
});
