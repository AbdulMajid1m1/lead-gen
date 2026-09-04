import { describe, it, expect } from "vitest";
import { hostedPlatformFor, isHostedPlatformDomain, emailBelongsToPlatform, isOwnDomainEmail, isFreemailDomain } from "../../lib/verify/hostedPlatforms.js";
import { normalizeElement } from "../../lib/adapters/overpass.js";
import { extractContacts } from "../../lib/extract/contacts.js";
import { verifyDomainIdentity } from "../../lib/verify/domainIdentity.js";

/**
 * A URL on a shared platform identifies the platform, not the business. The
 * Bombay Bistro case: an OSM website tag of bombay-bistro-larmar.menufy.com
 * became the company domain menufy.com, the crawler described Menufy as the
 * restaurant, and the pitch went to Menufy's support desk.
 */
describe("hostedPlatformFor", () => {
  it("recognises platform subdomains and reports what the page is", () => {
    expect(hostedPlatformFor("http://bombay-bistro-larmar.menufy.com/")).toMatchObject({ domain: "menufy.com", kind: "ORDERING" });
    expect(hostedPlatformFor("https://www.ubereats.com/store/keto-kitchen/abc")).toMatchObject({ domain: "ubereats.com", kind: "ORDERING" });
    expect(hostedPlatformFor("https://www.facebook.com/BombayBistroAustin/")).toMatchObject({ kind: "SOCIAL" });
    expect(hostedPlatformFor("https://linktr.ee/aimcoffee")).toMatchObject({ kind: "SOCIAL" });
    expect(hostedPlatformFor("https://mysalon.wixsite.com/home")).toMatchObject({ kind: "SITE_BUILDER" });
    expect(hostedPlatformFor("https://sites.google.com/view/plumber")).toMatchObject({ kind: "SITE_BUILDER" });
    expect(hostedPlatformFor("https://www.lieferando.de/speisekarte/pizza-hut")).toMatchObject({ kind: "ORDERING" });
  });

  it("leaves real first-party sites alone, including ones that merely resemble a platform", () => {
    expect(hostedPlatformFor("https://www.kerbeylanecafe.com")).toBeNull();
    expect(hostedPlatformFor("https://menufy-restaurant.co.uk")).toBeNull();
    expect(hostedPlatformFor("https://notfacebook.com")).toBeNull();
    expect(isHostedPlatformDomain("tibethaus.com")).toBe(false);
  });
});

describe("emailBelongsToPlatform", () => {
  it("flags the platform's own inbox and a help desk's, never the business's", () => {
    expect(emailBelongsToPlatform("info@menufy.com")).toMatchObject({ domain: "menufy.com" });
    expect(emailBelongsToPlatform("support@acme.zendesk.com")).toMatchObject({ kind: "HELPDESK" });
    expect(emailBelongsToPlatform("info@kerbeylanecafe.com")).toBeNull();
    // Even if a business's own domain were listed, its address is its own.
    expect(emailBelongsToPlatform("hello@shop.myshopify.com", "shop.myshopify.com")).toBeNull();
  });
});

describe("the map ingest with a hosted 'website' tag", () => {
  const el = normalizeElement({
    type: "node", id: 1, lat: 30.2, lon: -97.7,
    tags: { name: "Bombay Bistro", amenity: "restaurant", website: "http://bombay-bistro-larmar.menufy.com/", phone: "+1 512 462 7227" },
  });

  it("does not claim the platform's domain as the company's", () => {
    expect(el.domain).toBeNull();
    expect(el.hostedOn).toMatchObject({ domain: "menufy.com", kind: "ORDERING" });
    // It counts as having no website of its own.
    expect(el.hasWebsiteTag).toBe(false);
    expect(el.website).toBe("http://bombay-bistro-larmar.menufy.com/");
  });

  it("still treats a first-party website tag as before", () => {
    const own = normalizeElement({ type: "node", id: 2, tags: { name: "June's All Day", amenity: "restaurant", website: "https://junesallday.com" } });
    expect(own.domain).toBe("junesallday.com");
    expect(own.hasWebsiteTag).toBe(true);
    expect(own.hostedOn).toBeNull();
  });
});

describe("contact extraction on a platform page", () => {
  it("keeps the platform's address out of outreach and drops vendor tracking DSNs", () => {
    const html = `<html><body>
      <a href="mailto:info@menufy.com">Support</a>
      <p>Questions? Email owner@bombaybistroaustin.com</p>
      <script>Sentry.init({dsn:"https://605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com/123"})</script>
      <script>dsn:"https://e081c35a018348d18e09ed427bf39b65@o462166.ingest.sentry.io/1"</script>
    </body></html>`;
    const { emails } = extractContacts(html, { pageUrl: "https://restaurant.menufy.com/" });
    const byValue = Object.fromEntries(emails.map((e) => [e.value, e.kind]));
    expect(byValue["info@menufy.com"]).toBe("NON_OUTREACH");
    expect(byValue["owner@bombaybistroaustin.com"]).toBe("PERSONAL");
    expect(emails.some((e) => /sentry/i.test(e.value))).toBe(false);
  });
});

describe("domain identity on a hosted platform", () => {
  it("rejects the domain as SHARED_PLATFORM without fetching", async () => {
    const verdict = await verifyDomainIdentity("bombay-bistro-larmar.menufy.com", { name: "Bombay Bistro" });
    expect(verdict.verdict).toBe("REJECTED");
    expect(verdict.disqualifier).toBe("SHARED_PLATFORM");
  });
});

describe("own-domain addresses", () => {
  it("treats a company-domain address as evidence the business has a domain", () => {
    expect(isOwnDomainEmail("info@modacafe.com")).toBe(true);
    expect(isOwnDomainEmail("hello@vapiano.eu")).toBe(true);
  });
  it("does not read a consumer mailbox or a platform desk that way", () => {
    expect(isFreemailDomain("gmail.com")).toBe(true);
    expect(isOwnDomainEmail("goldhawkdentalpractice@gmail.com")).toBe(false);
    expect(isOwnDomainEmail("someone@hotmail.co.uk")).toBe(false);
    expect(isOwnDomainEmail("info@menufy.com")).toBe(false);
    expect(isOwnDomainEmail("not-an-address")).toBe(false);
  });
});

