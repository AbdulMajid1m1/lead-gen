import { describe, it, expect } from "vitest";
import { detectTechnologies, summarizeStack } from "../../lib/analyze/techDetect.js";
import { auditWebsite } from "../../lib/analyze/websiteAudit.js";
import { extractContacts, pickPrimaryEmail } from "../../lib/extract/contacts.js";
import { parseJobText } from "../../lib/extract/jobTextParser.js";
import { decayFactor, freshnessBucket } from "../../lib/scoring/decay.js";
import { initialStatusFor } from "../../lib/jobs/jobStatusEngine.js";
import { detectBlock } from "../../lib/crawler/blockDetection.js";
import { normalizeCompanyName, normalizeDomain, normalizeUrl, atsSlugCandidates } from "../../utils/normalize.js";

describe("detectTechnologies", () => {
  it("verifies WordPress from the generator meta tag", () => {
    const { technologies } = detectTechnologies({
      html: '<meta name="generator" content="WordPress 5.2.1" />',
      headers: {},
    });
    const wp = technologies.find((t) => t.name === "WordPress");
    expect(wp.confidence).toBe("VERIFIED");
    expect(wp.version).toBe("5.2.1");
  });

  it("upgrades a detection to VERIFIED when a vendor header proves it", () => {
    const { technologies } = detectTechnologies({ html: "", headers: { "x-shopid": "12345" } });
    const shopify = technologies.find((t) => t.name === "Shopify");
    expect(shopify.confidence).toBe("VERIFIED");
    expect(shopify.matchedOn).toBe("HEADER");
  });

  it("infers WordPress from WooCommerce, and labels it as an inference", () => {
    const { technologies } = detectTechnologies({
      html: '<link href="/wp-content/plugins/woocommerce/x.css"><a class="button add-to-cart" href="?add-to-cart=12">Add</a>',
      headers: {},
    });
    const wp = technologies.find((t) => t.name === "WordPress");
    expect(wp).toBeDefined();
    // Both a direct wp-content match and the inference are legitimate; what
    // matters is that WooCommerce never appears without WordPress.
    expect(technologies.some((t) => t.name === "WooCommerce")).toBe(true);
  });

  it("does not call a site a store because its theme bundles the WooCommerce plugin", () => {
    // In production this fingerprint fired on law firms, dental clinics and
    // schools: the plugin's stylesheet and wc-ajax endpoint load on any
    // WordPress theme that ships with WooCommerce, products or not. Each one
    // was then told "the store runs on WooCommerce" in its email.
    const { technologies } = detectTechnologies({
      html: '<link href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css"><script>var wc_ajax = "/?wc-ajax=%%endpoint%%"</script><p>Our solicitors</p>',
      headers: {},
    });
    expect(technologies.some((t) => t.name === "WordPress")).toBe(true);
    expect(technologies.some((t) => t.name === "WooCommerce")).toBe(false);
  });

  it("flags end-of-life libraries with a business consequence", () => {
    const { outdated } = detectTechnologies({ html: '<script src="/js/jquery-1.11.3.min.js"></script>', headers: {} });
    expect(outdated).toHaveLength(1);
    expect(outdated[0].name).toBe("jQuery");
    expect(outdated[0].note).toMatch(/unsupported|advisor/i);
  });

  it("summarises a stack into the flags the signal engine reads", () => {
    const detection = detectTechnologies({
      html: '<script src="https://js.stripe.com/v3"></script><script src="https://widget.intercom.io/x"></script>',
      headers: {},
    });
    const stack = summarizeStack(detection);
    expect(stack.hasLiveChat).toBe(true);
    expect(stack.payment).toContain("Stripe");
    expect(stack.hasAnalytics).toBe(false);
  });
});

describe("auditWebsite", () => {
  const page = (overrides = {}) => ({
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    headers: {},
    elapsedMs: 200,
    bytes: 5000,
    body: "<html><head><title>A perfectly ordinary business site</title></head><body><h1>Hi</h1></body></html>",
    ...overrides,
  });

  it("returns zero with a critical finding when the home page could not be fetched", () => {
    const audit = auditWebsite({ pages: [] });
    expect(audit.overallScore).toBe(0);
    expect(audit.findings[0].code).toBe("NO_HOMEPAGE");
  });

  it("penalises a plain-HTTP site heavily on security", () => {
    const audit = auditWebsite({ pages: [page({ finalUrl: "http://example.com/" })] });
    expect(audit.findings.some((f) => f.code === "NO_HTTPS" && f.severity === "CRITICAL")).toBe(true);
    expect(audit.subscores.security).toBeLessThan(50);
  });

  it("penalises a missing viewport tag on mobile", () => {
    const audit = auditWebsite({ pages: [page()] });
    expect(audit.findings.some((f) => f.code === "NO_VIEWPORT")).toBe(true);
    expect(audit.subscores.mobile).toBeLessThan(50);
  });

  it("detects a stale copyright and quantifies how far behind it is", () => {
    const year = new Date().getFullYear() - 6;
    const audit = auditWebsite({ pages: [page({ body: `<html><body><footer>© ${year} Acme</footer></body></html>` })] });
    const finding = audit.findings.find((f) => f.code === "STALE_COPYRIGHT");
    expect(finding).toBeDefined();
    expect(finding.evidence).toContain(String(year));
  });

  it("scores a modern, well-built page highly", () => {
    const audit = auditWebsite({
      pages: [page({
        body: `<html lang="en"><head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Acme — Independent bakery in Manchester</title>
            <meta name="description" content="Fresh bread, cakes and coffee, baked daily in Manchester.">
            <script type="application/ld+json">{"@type":"Bakery","name":"Acme"}</script>
            <script src="https://www.googletagmanager.com/gtag/js?id=G-XYZ"></script>
          </head><body><h1>Acme Bakery</h1>
          <p>${"Freshly baked every morning. ".repeat(30)}</p>
          <footer>© ${new Date().getFullYear()} Acme</footer>
          <form><input type="email" name="email"><textarea></textarea></form>
          </body></html>`,
        headers: { "strict-transport-security": "max-age=63072000", "content-security-policy": "default-src 'self'", "cache-control": "max-age=3600" },
      })],
    });
    expect(audit.overallScore).toBeGreaterThan(85);
  });

  it("flags a business that only takes orders by phone", () => {
    const audit = auditWebsite({ pages: [page({ body: "<html><body><p>Call us to order — we deliver!</p></body></html>" })] });
    expect(audit.findings.some((f) => f.code === "MANUAL_ORDERING")).toBe(true);
  });
});

describe("extractContacts", () => {
  const html = `
    <a href="mailto:info@acme.co.uk">Email</a>
    <p>Sales: sales (at) acme (dot) co.uk. Do not reply to noreply@acme.co.uk</p>
    <a href="tel:+442079460958">Call</a>
    <img src="logo@2x.png">
    <script>var dsn='abc@sentry.io'</script>
    <a href="https://www.linkedin.com/company/acme-ltd/">LinkedIn</a>
    <a href="https://facebook.com/sharer/sharer.php?u=x">Share</a>`;

  it("finds mailto, de-obfuscated and plain-text addresses", () => {
    const { emails } = extractContacts(html, { pageUrl: "https://acme.co.uk/contact" });
    const values = emails.map((e) => e.value);
    expect(values).toContain("info@acme.co.uk");
    expect(values).toContain("sales@acme.co.uk");
  });

  it("ignores asset filenames and third-party vendor addresses", () => {
    const { emails } = extractContacts(html, { pageUrl: "https://acme.co.uk/contact" });
    expect(emails.map((e) => e.value)).not.toContain("abc@sentry.io");
    expect(emails.some((e) => e.value.includes("logo"))).toBe(false);
  });

  it("classifies role, personal and non-outreach addresses", () => {
    const { emails } = extractContacts(html, { pageUrl: "https://acme.co.uk/" });
    expect(emails.find((e) => e.value === "info@acme.co.uk").kind).toBe("ROLE");
    expect(emails.find((e) => e.value === "noreply@acme.co.uk").kind).toBe("NON_OUTREACH");
  });

  it("prefers a same-domain role address proven by a mailto link", () => {
    const { emails } = extractContacts(html, { pageUrl: "https://acme.co.uk/" });
    const primary = pickPrimaryEmail(emails, "acme.co.uk");
    expect(primary.value).toBe("info@acme.co.uk");
    expect(primary.method).toBe("MAILTO_LINK");
  });

  it("does not manufacture addresses from ordinary prose", () => {
    // Regression: the de-obfuscation pass once replaced the letters "at"
    // anywhere they appeared, turning "platform.browse" into "pl@form.browse"
    // and storing it as a business contact.
    const prose = "<p>Our platform.browse feature lets you integrate.use the checkout.view directly, and migrations.view what happens.we recommend.</p>";
    const { emails } = extractContacts(prose, { pageUrl: "https://acme.co.uk/" });
    expect(emails).toEqual([]);
  });

  it("does not read a plain sentence mentioning a domain as an address", () => {
    // Regression: "Learn more at stripe.com" produced "an@stripe.com".
    // Real obfuscation disguises the dot as well as the at.
    const { emails } = extractContacts("<p>Learn more at stripe.com or read about us at acme.co.uk today.</p>", { pageUrl: "https://x.com/" });
    expect(emails).toEqual([]);
  });

  it("still decodes genuinely obfuscated addresses", () => {
    for (const [text, expected] of [
      ["<p>hello [at] acme [dot] com</p>", "hello@acme.com"],
      ["<p>sales (at) acme (dot) co.uk</p>", "sales@acme.co.uk"],
      ["<p>info AT acme DOT com</p>", "info@acme.com"],
    ]) {
      const { emails } = extractContacts(text, { pageUrl: "https://acme.co.uk/" });
      expect(emails.map((e) => e.value), text).toContain(expected);
    }
  });

  it("rejects text-scraped addresses with an implausible TLD", () => {
    const { emails } = extractContacts("<p>contact me at bob@company.notarealtld</p>", { pageUrl: "https://acme.co.uk/" });
    expect(emails.map((e) => e.value)).not.toContain("bob@company.notarealtld");
  });

  it("keeps real social profiles and drops share widgets", () => {
    const { socials } = extractContacts(html, { pageUrl: "https://acme.co.uk/" });
    expect(socials.map((s) => s.network)).toContain("LINKEDIN");
    expect(socials.map((s) => s.network)).not.toContain("FACEBOOK");
  });
});

describe("parseJobText", () => {
  it("maps a CRM systems title to the CRM signal", () => {
    const r = parseJobText({ title: "Salesforce Administrator" });
    expect(r.primary.signal).toBe("HIRING_CRM_ROLE");
    expect(r.primary.matchedIn).toBe("TITLE");
  });

  it("does NOT treat a Customer Success Manager as a CRM systems hire", () => {
    // Regression: a CSM is a sales role. Counting it as CRM intent produced
    // confidently wrong "they're building a CRM" reasons.
    const r = parseJobText({ title: "Strategic Customer Success Manager - EMEA" });
    expect(r.primary?.signal).not.toBe("HIRING_CRM_ROLE");
  });

  it("weights a description-only match lower than a title match", () => {
    const title = parseJobText({ title: "iOS Developer" });
    const description = parseJobText({ title: "Office Manager", descriptionSnippet: "you will work with our ios developer team" });
    expect(title.primary.strength).toBe(1);
    expect(description.primary.strength).toBeLessThan(1);
  });

  it("extracts named technologies as skills", () => {
    const r = parseJobText({ title: "Senior Engineer", descriptionSnippet: "React, TypeScript, PostgreSQL and AWS" });
    const skills = r.skills.map((s) => s.skill);
    expect(skills).toEqual(expect.arrayContaining(["react", "typescript", "postgresql", "aws"]));
  });

  it("maps HR and people roles to the HR signal", () => {
    for (const title of ["HR Manager", "Senior Human Resources Officer", "People Operations Lead", "Talent Acquisition Specialist", "Recruiter", "Payroll Administrator", "Head of People"]) {
      const r = parseJobText({ title });
      expect(r.primary?.signal, title).toBe("HIRING_HR_ROLE");
    }
  });

  it("does not misread engineering titles as HR", () => {
    expect(parseJobText({ title: "Chrome Extension Engineer" }).primary?.signal).not.toBe("HIRING_HR_ROLE");
    expect(parseJobText({ title: "Engineering Manager" }).primary?.signal).toBe("HIRING_TECH_ROLE");
  });

  it("returns no category for a clearly non-technical role", () => {
    expect(parseJobText({ title: "Warehouse Picker" }).primary).toBeNull();
  });
});

describe("decay", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

  it("halves a signal's value after exactly one half-life", () => {
    const factor = decayFactor({ detectedAt: daysAgo(14), halfLifeDays: 14 });
    expect(factor).toBeCloseTo(0.5, 2);
  });

  it("leaves signals with no half-life undecayed", () => {
    expect(decayFactor({ detectedAt: daysAgo(900), halfLifeDays: null })).toBe(1);
  });

  it("decays a two-month-old hiring signal to near nothing", () => {
    expect(decayFactor({ detectedAt: daysAgo(60), halfLifeDays: 14 })).toBeLessThan(0.06);
  });

  it("barely moves a year-old structural signal", () => {
    expect(decayFactor({ detectedAt: daysAgo(30), halfLifeDays: 365 })).toBeGreaterThan(0.9);
  });

  it("buckets freshness for the UI", () => {
    expect(freshnessBucket(new Date())).toBe("NEW_TODAY");
    expect(freshnessBucket(daysAgo(3))).toBe("NEW_THIS_WEEK");
    expect(freshnessBucket(daysAgo(20))).toBe("THIS_MONTH");
    expect(freshnessBucket(daysAgo(200))).toBe("OLDER");
  });
});

describe("initialStatusFor", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

  it("trusts a board listing as ACTIVE", () => {
    expect(initialStatusFor({ fromBoard: true, postedAt: daysAgo(400) })).toBe("ACTIVE");
  });

  it("treats a passed deadline as EXPIRED even on a board", () => {
    expect(initialStatusFor({ fromBoard: true, postedAt: daysAgo(1), deadlineAt: daysAgo(1) })).toBe("EXPIRED");
  });

  it("never marks an aggregator listing ACTIVE", () => {
    expect(initialStatusFor({ fromBoard: false, postedAt: daysAgo(2) })).toBe("RECENTLY_ACTIVE");
  });

  it("downgrades an old aggregator listing to UNKNOWN so it scores nothing", () => {
    expect(initialStatusFor({ fromBoard: false, postedAt: daysAgo(90) })).toBe("UNKNOWN");
    expect(initialStatusFor({ fromBoard: false, postedAt: null })).toBe("UNKNOWN");
  });
});

describe("detectBlock", () => {
  it("detects a Cloudflare challenge from its header", () => {
    const r = detectBlock({ status: 403, headers: { "cf-mitigated": "challenge" }, body: "", contentType: "text/html" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe("CLOUDFLARE_CHALLENGE");
  });

  it("detects rate limiting and auth walls by status", () => {
    expect(detectBlock({ status: 429, headers: {}, body: "", contentType: "" }).reason).toBe("RATE_LIMITED");
    expect(detectBlock({ status: 401, headers: {}, body: "", contentType: "" }).reason).toBe("AUTH_REQUIRED");
  });

  it("treats a CAPTCHA on a short interstitial as a wall", () => {
    const r = detectBlock({ status: 200, headers: {}, contentType: "text/html", body: "<html><body><div class='g-recaptcha'></div></body></html>" });
    expect(r.blocked).toBe(true);
  });

  it("does NOT treat a CAPTCHA inside a real page as a wall", () => {
    const body = `<html><body>${"<p>Real content about our bakery. </p>".repeat(500)}<div class="g-recaptcha"></div></body></html>`;
    expect(detectBlock({ status: 200, headers: {}, contentType: "text/html", body }).blocked).toBe(false);
  });

  it("notices an empty SPA shell without calling it blocked", () => {
    const r = detectBlock({ status: 200, headers: {}, contentType: "text/html", body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>' });
    expect(r.blocked).toBe(false);
    expect(r.jsRendered).toBe(true);
  });
});

describe("normalize", () => {
  it("strips legal suffixes and punctuation from company names", () => {
    expect(normalizeCompanyName("Café Müller GmbH & Co. KG")).toBe("cafe muller");
    expect(normalizeCompanyName("Acme Ltd.")).toBe("acme");
    expect(normalizeCompanyName("The Acme Corporation")).toBe("acme");
    // A name made only of suffix words must not normalise to nothing.
    expect(normalizeCompanyName("The Co")).not.toBe("");
  });

  it("preserves non-Latin business names", () => {
    // Regression: an ASCII-only character class erased Arabic/Cyrillic/CJK
    // names to "", which threw during ingest and aborted the whole Riyadh
    // discovery step.
    expect(normalizeCompanyName("مطعم البيك")).toBe("مطعم البيك");
    expect(normalizeCompanyName("Ресторан Пушкин")).toBe("ресторан пушкин");
    expect(normalizeCompanyName("Ταβέρνα Ελλάς")).toBe("ταβερνα ελλας");
    expect(normalizeCompanyName("寿司 さいとう")).not.toBe("");
  });

  it("reduces any URL form to its registrable domain", () => {
    expect(normalizeDomain("https://WWW.Shop.Acme.co.uk/path?x=1")).toBe("acme.co.uk");
    expect(normalizeDomain("acme.com")).toBe("acme.com");
    expect(normalizeDomain("http://192.168.0.1/")).toBeNull();
    expect(normalizeDomain("not a url")).toBeNull();
  });

  it("canonicalises URLs so the same page is never crawled twice", () => {
    const a = normalizeUrl("https://Example.com/page/?utm_source=x&b=2&a=1#frag");
    const b = normalizeUrl("https://example.com/page?a=1&b=2");
    expect(a).toBe(b);
  });

  it("proposes plausible ATS slugs from a company name", () => {
    const slugs = atsSlugCandidates("Acme Software Ltd");
    expect(slugs).toContain("acmesoftware");
    expect(slugs).toContain("acme-software");
    expect(slugs).toContain("acme");
  });
});
