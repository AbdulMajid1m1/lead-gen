import { describe, it, expect } from "vitest";
import { initialTemplate, followUpTemplate, whatsappInitialTemplate } from "../../lib/research/templates.js";
import { emailLooksMangled, BROKER_DOMAIN_RE } from "../../lib/outreach/hygiene.js";

/**
 * Copy coherence: the subject and pain line must agree with the observation
 * that opens the email. A lead WITH a website must never be told it has none,
 * and vice versa — one contradictory sentence reads as automation.
 */
const fact = (id, text, confidenceLevel = "DETECTED") => ({ id, text, confidenceLevel, observedAt: null });
const company = { name: "Bright Dental", city: "London", countryCode: "GB", industry: "Dental clinic" };

describe("initialTemplate coherence", () => {
  it("no-website lead gets the found-online pitch, no mention of a current site", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "Bright Dental is listed as an operating business with contact details but has no website at all.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.body).not.toMatch(/current site|your site/i);
    expect(draft.body).toMatch(/no website at all/);
  });

  it("slow-site lead gets a speed subject and a speed pain, not an invisibility pitch", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "The home page took 5.5s to respond.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.subject).toBe("your website speed");
    expect(draft.body).toMatch(/slow page/);
    expect(draft.body).not.toMatch(/can't find|no website/i);
  });

  it("booking observation pairs with the busy-phone pain", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "Dental clinic runs on appointments but has no online booking — every reservation costs staff time on the phone.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.subject).toBe("online bookings");
    expect(draft.body).toMatch(/line is busy|after hours/);
  });

  it("a fast load time is not pitched as a slow site", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "Its website is brightdental.co.uk.", "VERIFIED"),
        fact(3, "The home page took 1.6s to respond.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.subject).not.toBe("your website speed");
    expect(draft.body).not.toMatch(/slow page/);
    // And with a verified website, the can't-find-you premise is off the table.
    expect(draft.subject).not.toMatch(/can't find/i);
  });

  it("a Gulf-market business with a Latin name still gets Arabic first", () => {
    const draft = initialTemplate({
      company: { name: "French Corner", city: "Riyadh", countryCode: "SA" },
      facts: [fact(1, "French Corner is a restaurant in Riyadh.", "VERIFIED"),
        fact(2, "French Corner is listed as an operating business with contact details but has no website at all.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.body).toMatch(/^مرحباً/);
    expect(draft.body).toMatch(/Hello,/);
  });

  it("stays under 90 words and never uses known AI tells", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "The site runs WordPress 7.1.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.body.split(/\s+/).length).toBeLessThan(90);
    expect(draft.body).not.toMatch(/I came across|hope this finds you well|leverage|best-in-class/i);
  });

  it("Arabic business gets an Arabic-first bilingual body whose opener matches the observation", () => {
    const draft = initialTemplate({
      company: { name: "مقهى الكنافة", city: "الرياض", countryCode: "SA" },
      facts: [fact(1, "مقهى الكنافة is a business in الرياض.", "VERIFIED"),
        fact(2, "مقهى الكنافة is listed as an operating business with contact details but has no website at all.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.body).toMatch(/^مرحباً/);
    expect(draft.body).toMatch(/لا يوجد له موقع/);
    expect(draft.body).toMatch(/Hello,/); // English half below
  });
});

describe("follow-ups add new value", () => {
  it("first follow-up leads with a second observation, not 'checking in'", () => {
    const { body } = followUpTemplate({
      company, serviceLabel: "website development", followUpNumber: 1,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "The home page took 5.5s to respond."),
        fact(3, "The site publishes no schema.org data, so it cannot appear in rich search results.")],
    });
    expect(body).toMatch(/schema\.org|rich search/);
    expect(body).not.toMatch(/floating|checking in|top of your inbox/i);
  });

  it("without facts it still offers something specific rather than a nudge", () => {
    const { body } = followUpTemplate({ company, serviceLabel: "website development", followUpNumber: 1, facts: [] });
    expect(body).toMatch(/things I would change first/);
  });
});

describe("whatsapp first touch", () => {
  it("dropped the 'I came across' tell", () => {
    const { body } = whatsappInitialTemplate({ company, facts: [fact(1, "x", "VERIFIED"), fact(2, "The site runs WordPress 7.1.")], serviceLabel: "website development" });
    expect(body).not.toMatch(/I came across/);
  });
});

describe("address hygiene", () => {
  it("flags extraction-mangled locals but keeps real short mailboxes", () => {
    expect(emailLooksMangled("pl@form.it")).toBe(true);
    expect(emailLooksMangled("upd@es.email")).toBe(true);
    expect(emailLooksMangled("hr@mway.io")).toBe(false);
    expect(emailLooksMangled("gm@shurfa.com")).toBe(false);
    expect(emailLooksMangled("info@company.com")).toBe(false);
  });

  it("recognises broker domains", () => {
    expect(BROKER_DOMAIN_RE.test("domainmarket.com")).toBe(true);
    expect(BROKER_DOMAIN_RE.test("hugedomains.com")).toBe(true);
    expect(BROKER_DOMAIN_RE.test("brightdental.co.uk")).toBe(false);
  });
});
