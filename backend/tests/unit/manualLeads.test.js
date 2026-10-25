import { describe, it, expect } from "vitest";
import {
  normalizeImportRow, countryCodeFromInput, sizeBucketFromInput, emailsFromInput, phonesFromInput,
} from "../../lib/leads/importLeads.js";
import { manualLeadRefusal } from "../../lib/outreach/service.js";
import { buildRecipientRows } from "../../lib/outreach/campaigns.js";

/**
 * Leads a person uploads, and the Manual switch that keeps automation off
 * them. The failure that matters is a cold email the person did not mean to
 * send: a MANUAL lead must be refused by every automated path, while the same
 * person writing to it by hand must still go through.
 */
describe("normalizeImportRow", () => {
  it("needs a company name and nothing else", () => {
    expect(normalizeImportRow({}).ok).toBe(false);
    expect(normalizeImportRow({ company: "  " }).ok).toBe(false);
    const { ok, row, warnings } = normalizeImportRow({ company: "Royex Technologies" });
    expect(ok).toBe(true);
    expect(row.company).toBe("Royex Technologies");
    expect(row.emails).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("reads a website from a full URL and keeps only the domain", () => {
    expect(normalizeImportRow({ company: "Element8", website: "https://www.element8.ae/contact" }).row.domain).toBe("element8.ae");
    const bad = normalizeImportRow({ company: "Element8", website: "not a site" });
    expect(bad.row.domain).toBeNull();
    expect(bad.warnings[0]).toMatch(/not a website/);
  });

  it("takes every address in a cell and drops what is not an email", () => {
    expect(emailsFromInput("Info <INFO@x.ae>; sales@x.ae, info@x.ae")).toEqual(["info@x.ae", "sales@x.ae"]);
    expect(emailsFromInput("mailto:hr@x.ae")).toEqual(["hr@x.ae"]);
    const row = normalizeImportRow({ company: "X LLC", email: "call us" });
    expect(row.row.emails).toEqual([]);
    expect(row.warnings[0]).toMatch(/not an email/);
  });

  it("splits several phone numbers but keeps a number's own spaces", () => {
    expect(phonesFromInput("+971 4 582 0203; +971 50 123 4567")).toEqual(["+971 4 582 0203", "+971 50 123 4567"]);
    expect(phonesFromInput("123")).toEqual([]);
  });
});

describe("countryCodeFromInput", () => {
  it("accepts codes, full names and the short forms people actually type", () => {
    expect(countryCodeFromInput("ae")).toBe("AE");
    expect(countryCodeFromInput("United Arab Emirates")).toBe("AE");
    expect(countryCodeFromInput("UAE")).toBe("AE");
    expect(countryCodeFromInput("Dubai")).toBe("AE");
    expect(countryCodeFromInput("UK")).toBe("GB");
    expect(countryCodeFromInput("USA")).toBe("US");
  });

  it("returns null rather than guessing", () => {
    expect(countryCodeFromInput("Atlantis")).toBeNull();
    expect(normalizeImportRow({ company: "X LLC", country: "Atlantis" }).warnings[0]).toMatch(/not recognised/);
  });
});

describe("sizeBucketFromInput", () => {
  it("reads the middle of a range on the usual thresholds", () => {
    expect(sizeBucketFromInput("1-10")).toBe("MICRO");
    expect(sizeBucketFromInput("11–50 staff")).toBe("SMALL");
    expect(sizeBucketFromInput("about 120")).toBe("MEDIUM");
    expect(sizeBucketFromInput("1,200")).toBe("LARGE");
    expect(sizeBucketFromInput("unknown")).toBeNull();
  });
});

describe("the Manual switch", () => {
  const manual = { sendMode: "MANUAL", status: "NEW" };
  const auto = { sendMode: "AUTO", status: "NEW" };

  it("refuses every automated send to a MANUAL lead, without the word that marks a failure", () => {
    const refusal = manualLeadRefusal(manual, true);
    expect(refusal).toMatch(/Manual/);
    // Campaigns file a refusal containing "failed" as FAILED; this is a skip.
    expect(refusal).not.toMatch(/failed/i);
  });

  it("lets a person send to a MANUAL lead by hand, and leaves AUTO leads alone", () => {
    expect(manualLeadRefusal(manual, false)).toBeNull();
    expect(manualLeadRefusal(auto, true)).toBeNull();
    expect(manualLeadRefusal(undefined, true)).toBeNull();
  });

  it("keeps MANUAL leads out of every campaign queue, on both channels", () => {
    const lead = (sendMode) => ({
      id: sendMode, status: "NEW", sendMode, threads: [], discoveryRun: null,
      company: {
        name: "Gulf Bridge LLC", industry: "Construction", countryCode: "AE", people: [],
        contacts: [
          { kind: "EMAIL", value: "info@gulfbridge.ae", roleHint: "ROLE", isSuppressed: false },
          { kind: "PHONE", value: "+971501234567", isSuppressed: false },
        ],
      },
    });
    const [m, a] = buildRecipientRows([lead("MANUAL"), lead("AUTO")], { wantEmail: true, wantWa: true });
    expect(m.emailState).toBe("SKIPPED");
    expect(m.emailDetail).toMatch(/Manual/);
    expect(m.waState).toBe("SKIPPED");
    expect(a.emailState).toBe("PENDING");
    expect(a.emailDetail).toBe("info@gulfbridge.ae");
  });
});
