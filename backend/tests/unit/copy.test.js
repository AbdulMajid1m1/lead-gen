import { describe, it, expect } from "vitest";
import { initialTemplate, followUpTemplate, whatsappInitialTemplate, whatsappFollowUpTemplate, shortName } from "../../lib/research/templates.js";
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

  it("a stale no-website reason never opens an email to a business whose own domain is on file", () => {
    // Moda Cafe: no CompanyDomain row, but the address was info@modacafe.com —
    // and the email told them they had "no website at all".
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "Its email is on its own domain, brightdental.co.uk.", "VERIFIED"),
        fact(3, "Bright Dental is listed as an operating business with contact details but has no website at all.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.body).not.toMatch(/no website|can't find|own domain/i);
    // Same with a verified website fact and the stale reason still ranked first.
    const withSite = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "Bright Dental is listed as an operating business with contact details but has no website at all."),
        fact(3, "Its website is brightdental.co.uk.", "VERIFIED")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(withSite.body).not.toMatch(/no website|can't find/i);
  });

  it("slow-site lead gets a speed subject and a speed pain, not an invisibility pitch", () => {
    const draft = initialTemplate({
      company,
      facts: [fact(1, "Bright Dental is a dental clinic in London.", "VERIFIED"),
        fact(2, "The home page took 5.5s to respond.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "website development",
    });
    expect(draft.subject).toBe("Bright Dental page speed");
    expect(draft.body).toMatch(/takes 5.5s to load/);
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
    expect(draft.subject).toBe("booking at Bright Dental");
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
    expect(draft.subject).not.toMatch(/speed/);
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
    // Said the way a person would, not quoted from the signal catalogue.
    expect(body).toMatch(/structured data/);
    expect(body).not.toMatch(/schema\.org|rich search results/);
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

  it("reads as a sentence when the observation opens with a participle", () => {
    // The catalogue writes reasons as standalone lines ("Currently hiring X"),
    // which lower-cased into "I noticed currently hiring X" — the exact wording
    // that prompted the complaint about these emails reading as generated.
    const hiring = initialTemplate({
      company: { name: "Acme Ltd", countryCode: "GB" },
      facts: [{ id: "h1", text: "Currently hiring a Senior Machine Learning Engineer, indicating an active AI programme.", confidenceLevel: "DETECTED" }],
      serviceKey: "CUSTOM_SOFTWARE",
      serviceLabel: "custom software",
    });
    expect(hiring.body).toMatch(/I noticed you're hiring a Senior Machine Learning Engineer\./);
    expect(hiring.body).not.toMatch(/I noticed currently hiring|indicating an active/);
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


/**
 * Saying what was observed the way a person would.
 *
 * The catalogue writes reasons for the lead card — third person, then the
 * analyst's inference after a dash. Quoted after "I noticed" that inference
 * was the most visible tell in the 1,900 rule-generated drafts in production:
 * "I noticed restaurant sells to walk-in customers…", "…— an active technology
 * initiative that often needs outside delivery capacity". These pin the
 * rewrite: the specific survives, the analyst does not.
 */
describe("observations are said, not quoted", () => {
  const berlin = { name: "Restaurant Borchardt", city: "Berlin", countryCode: "DE", industry: "Restaurant" };

  it("turns the walk-in signal into a sentence about the reader, with restaurant wording", () => {
    const draft = initialTemplate({
      company: berlin,
      facts: [fact(1, "Restaurant Borchardt is a Restaurant in Berlin.", "VERIFIED"),
        fact(2, "Restaurant sells to walk-in customers but offers no way to order or buy online.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    });
    expect(draft.body).toMatch(/I noticed customers can't order from you online/);
    expect(draft.body).not.toMatch(/I noticed restaurant|walk-in customers but/);
    // Hook, pain and value all speak the same trade.
    expect(draft.body).toMatch(/takes orders around the clock/);
    expect(draft.body).not.toMatch(/those searches/);
    expect(draft.subject).toBe("ordering from Restaurant Borchardt");
  });

  it("drops the analyst's inference from a hiring signal", () => {
    const draft = initialTemplate({
      company: { name: "alphacoders GmbH", city: "Bonn", countryCode: "DE" },
      facts: [fact(1, "alphacoders GmbH is a Technology employer in Bonn.", "VERIFIED"),
        fact(2, "Currently hiring Software Developer Cloud Services (m/w/d) in Bonn — an active technology initiative that often needs outside delivery capacity.")],
      serviceKey: "CUSTOM_SOFTWARE", serviceLabel: "x",
    });
    expect(draft.body).toMatch(/I noticed you're hiring a Software Developer Cloud Services \(m\/w\/d\) in Bonn\./);
    expect(draft.body).not.toMatch(/delivery capacity|active technology initiative/);
  });

  it("never says the same kind of thing twice", () => {
    // "runs WordPress 6.3.10" followed by "Also, built on WordPress 6.3.10"
    // was the one line a reader could be certain a machine wrote.
    const draft = initialTemplate({
      company: { name: "VIP Motors", city: "Dubai", countryCode: "GB" },
      facts: [fact(1, "VIP Motors is a Car dealership in Dubai.", "VERIFIED"),
        fact(2, "Its website is vipmotors.ae.", "VERIFIED"),
        fact(3, "The site runs WordPress 6.3.10."),
        fact(4, "Its website scores 92/100 on a technical audit."),
        fact(5, "Its site is built on WordPress 6.3.10.", "VERIFIED")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    });
    expect(draft.body.match(/WordPress/g)).toHaveLength(1);
    expect(draft.body).not.toMatch(/\.\./);
    expect(draft.body).not.toMatch(/^Also/m);
  });

  it("leads with the costlier observation, not the first non-verified one", () => {
    const draft = initialTemplate({
      company: { name: "Gulf Royal", city: "Riyadh", countryCode: "GB" },
      facts: [fact(1, "Gulf Royal is a Restaurant in Riyadh.", "VERIFIED"),
        fact(2, "Its website is gulfroyal.com.", "VERIFIED"),
        fact(3, "The site runs WordPress."),
        fact(4, "No analytics tag is installed, so the business has no measurement of its own web traffic.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    });
    expect(draft.body).toMatch(/I noticed there's no analytics on your site/);
    expect(draft.subject).toBe("Gulf Royal site traffic");
  });

  it("carries the specific into the subject and the Arabic half", () => {
    const draft = initialTemplate({
      company: { name: "تونتي", city: "Jeddah", countryCode: "SA" },
      facts: [fact(1, "تونتي is a Clothing store in Jeddah.", "VERIFIED"),
        fact(2, "Its website is twenty20-sa.com.", "VERIFIED"),
        fact(3, "The footer copyright still reads 2024, suggesting the site has not been maintained for 2 years.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    });
    expect(draft.body).toMatch(/I noticed your site's footer still says 2024\./);
    expect(draft.body).toMatch(/سنة 2024/);
    expect(draft.body).not.toMatch(/suggesting the site has not been maintained/);
  });

  it("gives each business its own subject line", () => {
    const build = (name) => initialTemplate({
      company: { name, city: "Austin", countryCode: "US" },
      facts: [fact(1, `${name} is a Restaurant in Austin.`, "VERIFIED"),
        fact(2, `${name} is listed as an operating business with contact details but has no website at all.`)],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    }).subject;
    expect(build("Pizza Press")).toBe("finding Pizza Press online");
    expect(build("Champions")).toBe("finding Champions online");
    expect(build("Champions")).not.toBe(build("Pizza Press"));
  });

  it("keeps a brand's '& Co' and drops a real legal suffix", () => {
    expect(shortName("Kay & Co")).toBe("Kay & Co");
    expect(shortName("Al Nabooda Automobiles LLC")).toBe("Al Nabooda Automobiles");
    expect(shortName("Lúcia Mateus - Hair Studio")).toBe("Lúcia Mateus");
    expect(shortName("Gulf Royal Chinese Restaurant Trading Company")).toBeNull();
  });

  it("does not open with a fast load time when nothing else is known", () => {
    const draft = initialTemplate({
      company: { name: "Chase Evans", city: "London", countryCode: "GB", industry: "Real-estate agency" },
      facts: [fact(1, "Chase Evans is a Real-estate agency in London.", "VERIFIED"),
        fact(2, "Its website is chaseevans.co.uk.", "VERIFIED"),
        fact(3, "The home page took 1.6s to respond.")],
      serviceKey: "WEBSITE_DEV", serviceLabel: "x",
    });
    expect(draft.body).not.toMatch(/1\.6s/);
    expect(draft.body).toMatch(/Chase Evans came up while I was looking at local businesses in London\./);
  });

  it("says the second observation in plain words in the follow-up too", () => {
    const { body } = followUpTemplate({
      company: berlin, serviceLabel: "x", followUpNumber: 1,
      facts: [fact(1, "Restaurant Borchardt is a Restaurant in Berlin.", "VERIFIED"),
        fact(2, "Restaurant sells to walk-in customers but offers no way to order or buy online."),
        fact(3, "No analytics tag is installed, so the business has no measurement of its own web traffic.")],
    });
    expect(body).toMatch(/there's no analytics on your site/);
    expect(body).not.toMatch(/no analytics tag is installed/);
  });
});
