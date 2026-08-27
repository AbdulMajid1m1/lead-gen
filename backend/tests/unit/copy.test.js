import { describe, it, expect } from "vitest";
import { initialTemplate, followUpTemplate, whatsappInitialTemplate, whatsappFollowUpTemplate } from "../../lib/research/templates.js";
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


/**
 * Where proof and links are allowed to appear.
 *
 * A link in a first cold email measurably hurts deliverability, and since
 * November 2025 Gmail rejects distrusted mail outright rather than filtering
 * it. So the opener carries no URL at all — our website already rides along in
 * the signature block — and the portfolio waits for the proof chase, once the
 * address has taken two messages without bouncing.
 */
const URL_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|sa|ae)\b/i;
const bookingLead = {
  company: { name: "Nakheel Dental", city: "Riyadh", countryCode: "SA", industry: "Dental clinic" },
  facts: [
    fact(1, "Nakheel Dental is a dental clinic in Riyadh.", "VERIFIED"),
    fact(2, "Its website has no online booking — appointments are by phone only."),
    fact(3, "Its site is built on Wix.", "VERIFIED"),
  ],
};

describe("first email carries no link and asks for no meeting", () => {
  const draft = initialTemplate({ ...bookingLead, serviceKey: "WEBSITE_DEV", serviceLabel: "website development" });

  it("contains no URL of any kind", () => {
    expect(URL_RE.test(draft.body)).toBe(false);
  });

  it("does not request a call, meeting or demo", () => {
    expect(draft.body).not.toMatch(/book a (?:call|meeting)|schedule|calendar|demo|\b\d+[- ]?min(?:ute)?s?\b/i);
  });

  it("asks for a one-word reply instead", () => {
    // The *property* — a single question a one-word reply answers — not a
    // literal string. Pinning the exact sentence here is what allowed one
    // identical closing line to survive on every email the product sent.
    const [ask] = draft.body.split("\n\n").slice(-2, -1);
    expect(ask).toMatch(/\?/);
    expect(ask.match(/\?/g)).toHaveLength(1);
    expect(ask.split(/\s+/).length).toBeLessThanOrEqual(16);
  });

  it("does not close every email with the same sentence", () => {
    // The complaint that prompted this: two different companies, two different
    // observations, one identical last line.
    const other = initialTemplate({
      company: { name: "Nordlicht Cafe", countryCode: "DE" },
      facts: [
        { id: "n1", text: "Nordlicht Cafe is a cafe in Hamburg.", confidenceLevel: "DETECTED" },
        { id: "n2", text: "Nordlicht Cafe is listed as an operating business with contact details but has no website at all.", confidenceLevel: "DETECTED" },
      ],
      serviceKey: "WEBSITE_DEV",
      serviceLabel: "website development",
    });
    const lastLine = (body) => body.trim().split("\n\n").slice(-2, -1)[0];
    expect(lastLine(other.body)).not.toBe(lastLine(draft.body));
  });

  it("greets a named person when the business published one, and no one otherwise", () => {
    const named = initialTemplate({
      company: { name: "Muster Bau GmbH", countryCode: "DE" },
      facts: [{ id: "m1", text: "The home page took 4.2s to respond.", confidenceLevel: "DETECTED" }],
      serviceKey: "WEBSITE_DEV",
      serviceLabel: "website development",
      recipient: { fullName: "Sara Klein", firstName: "Sara" },
    });
    expect(named.body).toMatch(/^Hi Sara,/);
    // Never a surname, and never a guessed name where none was published.
    expect(named.body).not.toMatch(/Klein/);
    expect(draft.body).toMatch(/^(?:Hello,|مرحباً)/);
  });

  it("uses a second observed fact when one is available", () => {
    const twoFacts = initialTemplate({
      company: { name: "Muster Bau GmbH", countryCode: "DE" },
      facts: [
        { id: "m1", text: "The home page took 4.2s to respond.", confidenceLevel: "DETECTED" },
        { id: "m2", text: "It is currently hiring: Bauleiter.", confidenceLevel: "DETECTED" },
      ],
      serviceKey: "WEBSITE_DEV",
      serviceLabel: "website development",
    });
    // Both facts are cited, so the grounding check can still trace every claim.
    // Order follows which sentence each became, not the order they arrived in.
    expect([...twoFacts.factIdsUsed].sort()).toEqual(["m1", "m2"]);
    expect(twoFacts.body).toMatch(/Bauleiter/);
  });

  it("produces the same wording for the same lead every time", () => {
    // Drafts get regenerated. A closing line that changes on every run makes a
    // sent thread impossible to reconcile against what is on screen.
    const build = () => initialTemplate({
      company: { name: "Muster Bau GmbH", countryCode: "DE" },
      facts: [{ id: "m1", text: "The home page took 4.2s to respond.", confidenceLevel: "DETECTED" }],
      serviceKey: "WEBSITE_DEV",
      serviceLabel: "website development",
    });
    expect(build().body).toBe(build().body);
  });

  it("does not list our other services", () => {
    // A reader told we do web, mobile, AI and cloud learns only that we are a
    // general agency — the opposite of the relevance that earns a reply.
    const services = draft.body.match(/\b(?:mobile app|cloud|marketing|AI|ai automation)\b/gi) || [];
    expect(services.length).toBeLessThanOrEqual(1);
  });

  it("answers the hook it opened with", () => {
    // The value line used to come from the service alone, so a booking hook was
    // answered with a "customers can't find you in search" promise.
    const english = draft.body.split("———").pop();
    expect(english).toMatch(/booking/i);
    expect(english).not.toMatch(/those searches/i);
  });
});

describe("proof follow-up", () => {
  const proof = (serviceKey) => followUpTemplate({
    company: bookingLead.company, serviceLabel: "website development",
    serviceKey, followUpNumber: 2, facts: bookingLead.facts,
  }).body;

  it("is the first message in the sequence allowed to carry a link", () => {
    const chase1 = followUpTemplate({ ...bookingLead, serviceLabel: "x", serviceKey: "WEBSITE_DEV", followUpNumber: 1 }).body;
    expect(URL_RE.test(chase1)).toBe(false);
    expect(URL_RE.test(proof("WEBSITE_DEV"))).toBe(true);
  });

  it("shows exactly one piece of work, not the whole portfolio", () => {
    const body = proof("WEBSITE_DEV");
    const shown = ["tracefyhr.com", "mynime.com", "isaconsulting.com", "isaworkbridge.com"]
      .filter((u) => body.includes(u));
    expect(shown).toHaveLength(1);
  });

  it("matches the example to the service being pitched", () => {
    expect(proof("HR_SOFTWARE")).toContain("tracefyhr.com");
    expect(proof("MOBILE_APP")).toContain("mynime.com");
    expect(proof("SAAS_DEV")).toContain("isaworkbridge.com");
  });

  it("still does not ask for a meeting", () => {
    expect(proof("WEBSITE_DEV")).not.toMatch(/book a (?:call|meeting)|schedule|calendar/i);
  });

  it("goes out in Arabic first for a Gulf lead", () => {
    expect(proof("WEBSITE_DEV")).toMatch(/[\u0600-\u06FF]/);
  });

  it("keeps the breakup as the final chase, not the second", () => {
    const last = followUpTemplate({
      company: bookingLead.company, serviceLabel: "website development",
      serviceKey: "WEBSITE_DEV", followUpNumber: 3, facts: bookingLead.facts,
    }).body;
    expect(last).toMatch(/Last note from me/);
    expect(proof("WEBSITE_DEV")).not.toMatch(/Last note from me/);
  });

  it("sends no link in a first WhatsApp touch but does in the proof chase", () => {
    const first = whatsappInitialTemplate({ company: bookingLead.company, facts: bookingLead.facts, serviceLabel: "website development" }).body;
    expect(URL_RE.test(first)).toBe(false);
    const wa = whatsappFollowUpTemplate({ company: bookingLead.company, serviceLabel: "x", serviceKey: "HR_SOFTWARE", followUpNumber: 2, facts: [] }).body;
    expect(wa).toContain("tracefyhr.com");
  });
});


/**
 * Length and shape discipline.
 *
 * Under 75 words is the single largest lever on reply rate, and the reader is
 * on a phone: one sentence per paragraph, answerable with one thumb-typed word.
 */
describe("length and phone-readability", () => {
  const scenarios = [
    ["no booking", "WEBSITE_DEV", [
      fact(1, "Nakheel Dental is a dental clinic in Riyadh.", "VERIFIED"),
      fact(2, "Its website has no online booking — appointments are by phone only.")]],
    ["no website", "WEBSITE_DEV", [
      fact(1, "Bright Cafe is a cafe in London.", "VERIFIED"),
      fact(2, "Bright Cafe is listed as an operating business with contact details but has no website at all.")]],
    ["hiring", "CUSTOM_SOFTWARE", [
      fact(1, "Acme is a technology employer.", "VERIFIED"),
      fact(2, "It is currently hiring: Senior Backend Engineer.", "VERIFIED")]],
    ["slow site", "WEBSITE_DEV", [
      fact(1, "Vista Clinic is a clinic in Manchester.", "VERIFIED"),
      fact(2, "Its home page took 5.5s to load.")]],
  ];

  for (const [label, serviceKey, facts] of scenarios) {
    it(`${label}: body stays under 70 words`, () => {
      const co = { name: facts[0].text.split(" is ")[0], city: "London", countryCode: "GB", industry: "x" };
      const draft = initialTemplate({ company: co, facts, serviceKey, serviceLabel: "x" });
      const english = draft.body.includes("———") ? draft.body.split("———")[1] : draft.body;
      expect(english.trim().split(/\s+/).length).toBeLessThanOrEqual(70);
    });

    it(`${label}: subject reads like a colleague, not a pitch`, () => {
      const co = { name: facts[0].text.split(" is ")[0], city: "London", countryCode: "GB", industry: "x" };
      const { subject } = initialTemplate({ company: co, facts, serviceKey, serviceLabel: "x" });
      expect(subject.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(subject).not.toMatch(/idea|proposal|opportunity|solution|can't find|—/i);
    });
  }

  it("keeps every paragraph short enough to read on a phone", () => {
    const draft = initialTemplate({
      company: { name: "Vista Clinic", city: "Manchester", countryCode: "GB", industry: "Clinic" },
      facts: [fact(1, "Vista Clinic is a clinic in Manchester.", "VERIFIED"), fact(2, "Its home page took 5.5s to load.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    for (const para of draft.body.split("\n\n")) {
      // ~25 words is about two lines on a phone. Anything longer is a block
      // the reader skims past rather than reads.
      expect(para.trim().split(/\s+/).length).toBeLessThanOrEqual(25);
    }
  });
});
