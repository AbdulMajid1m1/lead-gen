import { describe, it, expect } from "vitest";
import {
  safeExternalUrl, clientKey, contactHealth, nullifyBlank, toClientCard, QUIET_AFTER_DAYS,
} from "../../lib/clients/clientBook.js";

const days = (n) => n * 86_400_000;

/**
 * Project links and websites are typed by hand and then rendered straight into
 * an anchor href, so the scheme guard is the one place a stored XSS could enter
 * the client book.
 */
describe("safeExternalUrl", () => {
  it("upgrades a bare host to https, because that is what people type", () => {
    expect(safeExternalUrl("acme.com")).toBe("https://acme.com/");
    expect(safeExternalUrl("  www.acme.co.uk/work  ")).toBe("https://www.acme.co.uk/work");
  });

  it("keeps an explicit http(s) URL exactly as given", () => {
    expect(safeExternalUrl("http://app.acme.com/x")).toBe("http://app.acme.com/x");
  });

  it("refuses every scheme that is not http(s)", () => {
    for (const hostile of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "mailto:a@b.com"]) {
      expect(safeExternalUrl(hostile)).toBeNull();
    }
  });

  it("refuses input that is not a locatable host", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl("localhost")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
  });
});

describe("clientKey", () => {
  it("collapses legal forms and casing so one company cannot be entered twice", () => {
    expect(clientKey("Acme Ltd.")).toBe(clientKey("acme"));
    expect(clientKey("Café Müller GmbH")).toBe(clientKey("cafe muller"));
  });

  it("never returns an empty key, which would collide every such client", () => {
    // "Group" is a legal-form token and normalises away entirely.
    expect(clientKey("Group")).toBe("group");
  });
});

describe("nullifyBlank", () => {
  it("distinguishes 'clear this field' from 'leave it alone'", () => {
    expect(nullifyBlank(undefined)).toBeUndefined();
    expect(nullifyBlank("")).toBeNull();
    expect(nullifyBlank("   ")).toBeNull();
    expect(nullifyBlank(null)).toBeNull();
    expect(nullifyBlank("  Acme  ")).toBe("Acme");
  });
});

/**
 * The check-in verdict decides which clients the book pushes at you, so its
 * edges matter more than its happy path.
 */
describe("contactHealth", () => {
  const now = Date.now();

  it("never chases an archived client — archiving is how you say stop", () => {
    expect(contactHealth({ status: "ARCHIVED", lastContactedAt: new Date(now - days(999)) }, now).isDue).toBe(false);
  });

  it("treats a booked follow-up date as the final word, in both directions", () => {
    // Due, even though we spoke to them yesterday.
    expect(contactHealth({ status: "ACTIVE", lastContactedAt: new Date(now - days(1)), nextFollowUpAt: new Date(now - days(1)) }, now))
      .toMatchObject({ state: "DUE", isDue: true });
    // Not due, even though they have been silent for a year.
    expect(contactHealth({ status: "PAST", lastContactedAt: new Date(now - days(365)), nextFollowUpAt: new Date(now + days(5)) }, now))
      .toMatchObject({ state: "SCHEDULED", isDue: false });
  });

  it("flags a client nobody has ever contacted", () => {
    expect(contactHealth({ status: "PAST" }, now)).toMatchObject({ state: "NEVER_CONTACTED", isDue: true, daysSinceContact: null });
  });

  it("goes quiet exactly at the threshold, not before it", () => {
    expect(contactHealth({ status: "PAST", lastContactedAt: new Date(now - days(QUIET_AFTER_DAYS - 1)) }, now).isDue).toBe(false);
    expect(contactHealth({ status: "PAST", lastContactedAt: new Date(now - days(QUIET_AFTER_DAYS)) }, now)).toMatchObject({ state: "QUIET", isDue: true });
  });
});

describe("toClientCard", () => {
  const base = {
    id: "c1", name: "Acme", status: "PAST", tags: ["retainer"], countryCode: "SA",
    createdAt: new Date(), contacts: [], projects: [],
  };

  it("surfaces the flagged primary contact, whatever order the rows arrive in", () => {
    const card = toClientCard({
      ...base,
      contacts: [
        { id: "x", isPrimary: false, name: "Junior", createdAt: new Date(1) },
        { id: "y", isPrimary: true, name: "Owner", email: "owner@acme.com", createdAt: new Date(2) },
      ],
    });
    expect(card.primaryContact).toMatchObject({ id: "y", name: "Owner" });
    expect(card.teamSize).toBe(2);
  });

  it("falls back to the first person when nothing is flagged", () => {
    const card = toClientCard({ ...base, contacts: [{ id: "x", isPrimary: false, name: "Only", createdAt: new Date(1) }] });
    expect(card.primaryContact.id).toBe("x");
  });

  it("picks the most recently delivered project as the headline, not the newest row", () => {
    const card = toClientCard({
      ...base,
      projects: [
        { id: "p1", name: "Old site", deliveredAt: new Date("2024-01-01"), createdAt: new Date("2026-08-01") },
        { id: "p2", name: "New app", deliveredAt: new Date("2026-05-01"), createdAt: new Date("2026-01-01") },
      ],
    });
    expect(card.latestProject.name).toBe("New app");
  });

  it("resolves the country code to a name the UI can print", () => {
    expect(toClientCard(base).countryName).toBe("Saudi Arabia");
    expect(toClientCard({ ...base, countryCode: null }).countryName).toBeNull();
  });
});
