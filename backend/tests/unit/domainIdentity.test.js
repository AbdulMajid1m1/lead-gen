import { describe, it, expect } from "vitest";
import { verifyDomainIdentity } from "../../lib/verify/domainIdentity.js";
import { canonicalPath } from "../../lib/ingest/websiteIngest.js";
import { extractPeople, pickPrimaryPerson, emailMatchesName, classifySeniority } from "../../lib/extract/people.js";
import { __testables as placesInternals } from "../../lib/adapters/googlePlaces.js";

/**
 * The rules that decide whether a website really belongs to a lead.
 *
 * Every case here is drawn from a way the pipeline has actually been wrong. The
 * headline one: a Riyadh restaurant that closed, lost its domain to an SEO
 * network, and kept being emailed at a Vietnamese gambling site because the
 * domain still answered HTTP 200.
 */

const page = ({ title = "", ogSite = "", body = "", copyright = "", jsonLd = null }) => `
<html><head>
  <title>${title}</title>
  ${ogSite ? `<meta property="og:site_name" content="${ogSite}">` : ""}
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
</head><body>${body}${copyright ? `<footer>© 2024 ${copyright}</footer>` : ""}</body></html>`;

const verify = (html, company, domain = "example.com") =>
  verifyDomainIdentity(domain, company, { html, finalUrl: `https://${domain}/` });

describe("domain identity — hostile takeovers", () => {
  it("rejects an expired domain now serving gambling content", async () => {
    const html = page({
      title: "App tài xỉu online: 20 Link tải game tài xỉu đổi tiền thật uy tín",
      body: "<p>nhà cái uy tín</p>",
    });
    const v = await verify(html, { name: "TOPKAPI Tahlia", city: "Riyadh", countryCode: "SA" }, "topkapirest.com");
    expect(v.verdict).toBe("REJECTED");
    expect(v.disqualifier).toBe("TAKEOVER_GAMBLING");
  });

  it("rejects a takeover even when the page still echoes the company name", async () => {
    // The dangerous case: SEO squatters often keep the old title for its
    // residual search equity, so a name match alone must never be enough.
    const html = page({ title: "Topkapi Restaurant", body: "<p>situs judi slot gacor terpercaya</p>" });
    const v = await verify(html, { name: "Topkapi Restaurant", city: "Riyadh", countryCode: "SA" }, "topkapirest.com");
    expect(v.verdict).toBe("REJECTED");
    expect(v.disqualifier).toBe("TAKEOVER_GAMBLING");
  });

  it("rejects a parked domain-broker page", async () => {
    const html = page({ title: "Gad", body: "<p>This domain is for sale. Inquire about this domain.</p>" });
    const v = await verify(html, { name: "Gad", city: "Riyadh", countryCode: "SA" }, "gad.com");
    expect(v.verdict).toBe("REJECTED");
    expect(v.disqualifier).toBe("PARKED");
  });

  it("rejects a bare hosting placeholder", async () => {
    const v = await verify(page({ title: "Welcome to nginx!", body: "Welcome to nginx!" }), { name: "Acme Dental" });
    expect(v.verdict).toBe("REJECTED");
    expect(v.disqualifier).toBe("HOLDING_PAGE");
  });

  it("rejects a shared platform that cannot identify one company", async () => {
    const v = await verify(page({ title: "Acme" }), { name: "Acme" }, "linkedin.com");
    expect(v.disqualifier).toBe("SHARED_PLATFORM");
  });
});

describe("domain identity — acceptance", () => {
  it("accepts a site that names itself in its title and matches the city", async () => {
    const html = page({ title: "Pearl Dental Clinic — Business Bay", body: "<p>Visit us in Dubai</p>" });
    const v = await verify(html, { name: "Pearl Dental Clinic", city: "Dubai", countryCode: "AE" }, "pearldentalclinics.com");
    expect(v.verdict).toBe("OWNED");
  });

  it("treats a matching known phone number as decisive", async () => {
    // A takeover page has no reason to carry the real business's number, so
    // this alone clears the threshold even with an unhelpful title.
    const html = page({ title: "Home", body: '<a href="tel:+966559404600">Call us</a>' });
    const v = await verify(html, { name: "Some Business", phones: ["+966 55 940 4600"] }, "somebusiness.sa");
    expect(v.verdict).toBe("OWNED");
    expect(v.signals.join(" ")).toMatch(/phone/);
  });

  it("accepts a schema.org Organization name", async () => {
    const html = page({ title: "Home", jsonLd: { "@type": "LocalBusiness", name: "Al Rashid Motors" } });
    const v = await verify(html, { name: "Al Rashid Motors", city: "Riyadh", countryCode: "SA" }, "alrashidmotors.com");
    expect(v.verdict).toBe("OWNED");
  });
});

describe("domain identity — name collisions", () => {
  it("rejects a same-named business with no link to the right place", async () => {
    const html = page({ title: "Topkapi Palace Istanbul", body: "<p>Historic museum in Turkey</p>" });
    const v = await verify(html, { name: "TOPKAPI Tahlia", city: "Riyadh", countryCode: "SA" }, "topkapi.com");
    expect(v.verdict).toBe("REJECTED");
    expect(v.disqualifier).toBe("NO_IDENTITY");
  });

  it("does not accept a name-shaped domain on its own", async () => {
    // The old resolver's worst habit: <name>.com resolving to *something* was
    // treated as proof. A bare domain-stem match scores below the threshold.
    const v = await verify(page({ title: "Untitled" }), { name: "French Corner" }, "frenchcorner.com");
    expect(v.verdict).toBe("REJECTED");
    expect(v.score).toBeLessThan(60);
  });
});

describe("crawl frontier — page classification", () => {
  it("canonicalises the contact-page shapes real sites use", () => {
    // Each of these used to be classified "other" and never fetched, which is
    // the single largest cause of leads with no email address.
    expect(canonicalPath("/en/contact-us")).toBe("/contact-us");
    expect(canonicalPath("/ar/contact")).toBe("/contact");
    expect(canonicalPath("/pages/contact")).toBe("/contact");
    expect(canonicalPath("/en/pages/contact-us")).toBe("/contact-us");
    expect(canonicalPath("/contact.html")).toBe("/contact");
    expect(canonicalPath("/contact_us")).toBe("/contact-us");
    expect(canonicalPath("/CONTACT/")).toBe("/contact");
  });

  it("treats a bare locale root as the home page", () => {
    expect(canonicalPath("/en")).toBe("/");
    expect(canonicalPath("/ar-sa")).toBe("/");
  });

  it("does not mistake ordinary paths for locale prefixes", () => {
    expect(canonicalPath("/energy")).toBe("/energy");
    expect(canonicalPath("/enterprise")).toBe("/enterprise");
    expect(canonicalPath("/deals")).toBe("/deals");
  });
});

describe("people extraction", () => {
  const teamPage = `<html><body>
    <div class="team-member"><h3>Ahmed Al Rashid</h3><p class="role">Founder &amp; Managing Director</p>
      <a href="https://www.linkedin.com/in/ahmed-al-rashid-9f8a7b">LinkedIn</a></div>
    <div class="team-member"><h3>Sarah Mitchell</h3><p class="role">Head of Marketing</p></div>
    <div class="team-member"><h3>Priya Nair</h3><p class="role">Reception Manager</p></div>
    <div class="team-member"><h3>Read More</h3><p class="role">Click Here</p></div>
  </body></html>`;

  it("finds published team members with their titles", () => {
    const people = extractPeople(teamPage, { pageUrl: "https://acme.sa/team" });
    expect(people.map((p) => p.fullName).sort()).toEqual(["Ahmed Al Rashid", "Priya Nair", "Sarah Mitchell"]);
  });

  it("keeps two-word job titles that look like names", () => {
    const people = extractPeople(teamPage, { pageUrl: "https://acme.sa/team" });
    expect(people.find((p) => p.fullName === "Priya Nair").title).toBe("Reception Manager");
  });

  it("rejects call-to-action text as a person", () => {
    const people = extractPeople(teamPage, { pageUrl: "https://acme.sa/team" });
    expect(people.some((p) => p.fullName === "Read More")).toBe(false);
  });

  it("picks the most senior reachable person as the outreach target", () => {
    const people = extractPeople(teamPage, { pageUrl: "https://acme.sa/team", emails: [{ value: "ahmed@acme.sa" }] });
    const primary = pickPrimaryPerson(people);
    expect(primary.fullName).toBe("Ahmed Al Rashid");
    expect(primary.seniority).toBe("OWNER");
  });

  it("links only addresses the site already published", () => {
    expect(emailMatchesName("s.mitchell@acme.sa", "Sarah Mitchell")).toBe(true);
    expect(emailMatchesName("sarah@acme.sa", "Sarah Mitchell")).toBe(true);
    expect(emailMatchesName("info@acme.sa", "Sarah Mitchell")).toBe(false);
  });

  it("ranks seniority by decision authority", () => {
    expect(classifySeniority("Co-Founder")).toBe("OWNER");
    expect(classifySeniority("Chief Executive Officer")).toBe("EXECUTIVE");
    expect(classifySeniority("Marketing Executive")).toBe("MARKETING");
    expect(classifySeniority("Receptionist")).toBe("OPERATIONS");
  });
});

describe("google places matching", () => {
  const { matchConfidence, MATCH_THRESHOLD, SEARCH_FIELD_MASK } = placesInternals;

  it("treats a matching phone number as near-proof", () => {
    const score = matchConfidence(
      { name: "Something Else", phone: "+966 55 940 4600", address: "Riyadh" },
      { name: "Topkapi", phones: ["+966559404600"] },
    );
    expect(score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it("does not match a different business on name alone", () => {
    const score = matchConfidence(
      { name: "Topkapi Al Ghadir", address: "Al Ghadir, Riyadh" },
      { name: "Pearl Dental Clinic", city: "Dubai", phones: [] },
    );
    expect(score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("never lets the domain under test justify its own match", () => {
    // Corroborating a website by a Places record that we matched *using* that
    // same website would be circular, so the domain contributes only 10 points.
    const score = matchConfidence(
      { name: "Totally Different", domain: "acme.com", address: "Nowhere" },
      { name: "Acme", domain: "acme.com", phones: [] },
    );
    expect(score).toBeLessThan(MATCH_THRESHOLD);
  });

  it("requests an explicit field mask, because Places bills per field", () => {
    expect(SEARCH_FIELD_MASK).toContain("places.businessStatus");
    expect(SEARCH_FIELD_MASK).not.toContain("places.reviews");
  });
});
