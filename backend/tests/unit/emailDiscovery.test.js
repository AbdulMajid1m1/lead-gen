import { describe, it, expect } from "vitest";
import {
  decodeCloudflareEmail, decodeWordSeparators, decodeCandidate,
  emailsFromMailto, emailsFromJson, normaliseForMatching,
} from "../../lib/extract/emailDecode.js";
import { extractContacts } from "../../lib/extract/contacts.js";
import { selectFollowUpUrls } from "../../lib/ingest/websiteIngest.js";

/**
 * Finding the email a business already published.
 *
 * Most leads reach outreach with a phone and no address, and the reason is
 * rarely that no address exists — it is that the page hides it from scrapers,
 * or that the page carrying it was never fetched. These tests pin the two
 * halves of that: decoding what is on the page, and choosing the right page.
 */

/** Encode exactly the way Cloudflare does: key byte first, rest XORed with it. */
const cfEncode = (email, key) => {
  const hex = [key.toString(16).padStart(2, "0")];
  for (const b of Buffer.from(email, "utf8")) hex.push((b ^ key).toString(16).padStart(2, "0"));
  return hex.join("");
};

describe("decodeCloudflareEmail", () => {
  it("round-trips every key, including a UTF-8 domain", () => {
    for (const email of ["info@acme.de", "sales@muster-bau.berlin", "kontakt@händler.de"]) {
      for (const key of [0x01, 0x43, 0x7a, 0xff]) {
        expect(decodeCloudflareEmail(cfEncode(email, key))).toBe(email);
      }
    }
  });

  it("decodes the canonical published vector", () => {
    expect(decodeCloudflareEmail("43263b222e332f2603263b222e332f266d202c2e")).toBe("example@example.com");
  });

  it("returns null rather than a garbage contact", () => {
    expect(decodeCloudflareEmail("zzz")).toBeNull();
    expect(decodeCloudflareEmail("4326")).toBeNull();   // decodes, but has no "@"
    expect(decodeCloudflareEmail("432")).toBeNull();    // odd length
    expect(decodeCloudflareEmail("")).toBeNull();
    expect(decodeCloudflareEmail(null)).toBeNull();
  });
});

describe("decodeWordSeparators", () => {
  it("reads the markets we actually sell into", () => {
    expect(decodeWordSeparators("buero (ät) muster-bau punkt de")).toContain("buero@muster-bau.de");
    expect(decodeWordSeparators("contact arobase acme point fr")).toContain("contact@acme.fr");
    expect(decodeWordSeparators("info arroba acme punto es")).toContain("info@acme.es");
    expect(decodeWordSeparators("info chiocciola acme punto it")).toContain("info@acme.it");
    expect(decodeWordSeparators("hello [at] acme [dot] com")).toContain("hello@acme.com");
  });

  it("leaves ordinary prose alone", () => {
    // The regression this guards: requiring only the "at" to be disguised once
    // turned "Learn more at stripe.com" into the contact "an@stripe.com".
    expect(decodeWordSeparators("Learn more at stripe.com for details")).not.toMatch(/@/);
    expect(decodeWordSeparators("We are open at 9 point sharp")).not.toMatch(/@/);
  });
});

describe("normaliseForMatching", () => {
  it("folds the tricks that split an address the eye still reads as whole", () => {
    expect(normaliseForMatching("info＠acme.de")).toBe("info@acme.de");          // fullwidth @
    expect(normaliseForMatching("in​fo@acme.de")).toBe("info@acme.de");     // zero-width space
    expect(normaliseForMatching("info-NOSPAM@acme.de")).toBe("info@acme.de");    // remove-marker
  });
});

describe("decodeCandidate", () => {
  it("recovers cheap reversible encodings", () => {
    expect(decodeCandidate("ed.emca@ofni")?.email).toBe("info@acme.de");                         // reversed
    expect(decodeCandidate(Buffer.from("info@acme.de").toString("base64"))?.email).toBe("info@acme.de");
    // TYPO3 rot-encodes the entire href, scheme included, so the raw value is
    // not itself address-shaped. (A rot-encoded bare address still *looks* like
    // an address, and decodeCandidate rightly takes such a string at face
    // value rather than guessing it is encrypted.)
    expect(decodeCandidate("znvygb:vasb@npzr.qr")?.email).toBe("info@acme.de");
  });

  it("does not manufacture an address out of noise", () => {
    expect(decodeCandidate("hello world")).toBeNull();
    expect(decodeCandidate("")).toBeNull();
    expect(decodeCandidate("1234567890")).toBeNull();
  });
});

describe("emailsFromMailto", () => {
  it("reads every recipient, including the ones in the query string", () => {
    expect(emailsFromMailto("mailto:a@x.de,b@x.de")).toEqual(["a@x.de", "b@x.de"]);
    expect(emailsFromMailto("mailto:?to=Info%40Acme.de&cc=zweite@acme.de"))
      .toEqual(["info@acme.de", "zweite@acme.de"]);
  });

  it("yields nothing when the URI carries no address", () => {
    // RFC 6068 makes the address optional; a naive prefix strip invents a
    // contact out of "?subject=Hi".
    expect(emailsFromMailto("mailto:?subject=Hi")).toEqual([]);
    expect(emailsFromMailto("mailto:")).toEqual([]);
    expect(emailsFromMailto("https://acme.de")).toEqual([]);
  });
});

describe("emailsFromJson", () => {
  it("finds an address wherever schema.org happens to put it", () => {
    const graph = {
      "@graph": [
        { "@type": "WebSite" },
        {
          "@type": "Organization",
          contactPoint: [{ "@type": "ContactPoint", contactType: "sales", email: "mailto:sales@acme.de" }],
          founder: { "@type": "Person", email: "owner@acme.de" },
        },
      ],
    };
    expect(emailsFromJson(graph).sort()).toEqual(["owner@acme.de", "sales@acme.de"]);
  });

  it("survives the shapes framework state blobs actually take", () => {
    expect(emailsFromJson({ props: { pageProps: { contact_email: "hi@acme.de" } } })).toEqual(["hi@acme.de"]);
    expect(emailsFromJson({ email: { "@value": "wrapped@acme.de" } })).toEqual(["wrapped@acme.de"]);
    const cyclic = { email: "a@x.de" };
    cyclic.self = cyclic;                       // hand-rolled state blobs do this
    expect(emailsFromJson(cyclic)).toEqual(["a@x.de"]);
  });
});

describe("extractContacts — the whole page", () => {
  const page = `<html><body>
    <a href="mailto:?to=Info%40Acme.berlin&cc=zweite@acme.berlin">write</a>
    <span class="__cf_email__" data-cfemail="${cfEncode("kontakt@acme.berlin", 0x2b)}">[email protected]</span>
    <div style="display:none">trap@honeypot.example.org</div>
    <p>Schreiben Sie an buero (ät) muster-bau punkt de</p>
    <span data-user="team" data-domain="acme.immo"></span>
    <script type="application/ld+json">
      {"@type":"Organization","contactPoint":[{"@type":"ContactPoint","email":"mailto:sales@acme.berlin"}]}
    </script>
    <p>Learn more at stripe.com for details</p>
    <p>hallo@test-labor.de</p>
  </body></html>`;

  const found = extractContacts(page, { pageUrl: "https://acme.berlin/kontakt" });
  const values = found.emails.map((e) => e.value);

  it("decodes a Cloudflare-obfuscated address", () => {
    expect(values).toContain("kontakt@acme.berlin");
  });

  it("reads the to/cc fields of a mailto with no primary address", () => {
    expect(values).toContain("info@acme.berlin");
    expect(values).toContain("zweite@acme.berlin");
  });

  it("reads schema.org and split data- attributes", () => {
    expect(values).toContain("sales@acme.berlin");
    expect(values).toContain("team@acme.immo");
  });

  it("accepts a declared address on a TLD the prose allowlist does not carry", () => {
    // .berlin and .immo are real and common for German SMEs. The allowlist
    // exists to stop prose reading as an address, not to veto a site's own
    // stated contact point.
    expect(values.some((v) => v.endsWith(".berlin"))).toBe(true);
    expect(values.some((v) => v.endsWith(".immo"))).toBe(true);
  });

  it("does not treat a real business as placeholder text", () => {
    // `test\b` matched before a hyphen, so test-labor.de was discarded.
    expect(values).toContain("hallo@test-labor.de");
  });

  it("never ingests an address hidden from the reader", () => {
    // A display:none block is where spam-trap honeypots live, and a trap hit
    // costs the sending domain its reputation.
    expect(values.some((v) => v.includes("honeypot"))).toBe(false);
  });

  it("still refuses prose that merely looks like an address", () => {
    expect(values.some((v) => /stripe/.test(v))).toBe(false);
  });
});

describe("selectFollowUpUrls — choosing the page that carries the address", () => {
  const origin = "https://acme.de";
  const links = [
    { href: "https://acme.de/datenschutz", text: "Datenschutz" },
    { href: "https://acme.de/impressum", text: "Impressum" },
    { href: "https://acme.de/kontakt", text: "Kontakt" },
    { href: "https://acme.de/de/rechtliche-hinweise-2024", text: "Impressum" },
    { href: "https://acme.de/blog/hello", text: "Blog" },
  ];

  it("ranks the imprint above the privacy policy", () => {
    // The EU e-Commerce Directive mandates an email address on the imprint; a
    // privacy notice carries one far less reliably. They previously shared one
    // slot, so /datenschutz routinely consumed it and /impressum was skipped.
    const picked = selectFollowUpUrls(links, origin, new Set(), 5);
    const labels = picked.map((p) => p.label);
    expect(labels.indexOf("imprint")).toBeLessThan(labels.indexOf("policy"));
  });

  it("follows an imprint whose slug we do not recognise, on its link text", () => {
    // Sites version and localise the slug freely, and German sites legitimately
    // nest the imprint under /kontakt (BGH I ZR 228/03).
    const picked = selectFollowUpUrls(links, origin, new Set(), 5);
    expect(picked.map((p) => p.url)).toContain("https://acme.de/de/rechtliche-hinweise-2024");
  });

  it("still ignores pages that carry no contact value", () => {
    const picked = selectFollowUpUrls(links, origin, new Set(), 5);
    expect(picked.map((p) => p.url)).not.toContain("https://acme.de/blog/hello");
  });
});

describe("extractContacts — phones and socials declared in structured data", () => {
  const page = `<html><body>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"LocalBusiness","name":"Acme Kebab",
       "telephone":"+971 4 340 6401",
       "contactPoint":[{"@type":"ContactPoint","telephone":"tel:+971501234567","contactType":"sales"}],
       "sameAs":["https://www.instagram.com/acmekebab","https://www.facebook.com/acmekebab",
                 "https://linkedin.com/company/acme-kebab"]}
    </script>
    <script>window.__NUXT__ = {"config":{"phone":"04 340 6402"},"build":"2.15.8"}</script>
    <p>Best kebab since 2019. Rated 4.9 of 5 from 12345 reviews.</p>
  </body></html>`;

  const found = extractContacts(page, { pageUrl: "https://acme.ae/" });
  const phones = found.phones.map((p) => p.value);
  const networks = found.socials.map((s) => s.network);

  it("reads a JSON-LD telephone even when no email appears anywhere", () => {
    // The old walk skipped any script without an "@", so a LocalBusiness block
    // carrying only a phone was invisible.
    expect(phones).toContain("+97143406401");
  });

  it("reads contactPoint telephones and strips the tel: prefix", () => {
    expect(phones).toContain("+971501234567");
  });

  it("marks structured-data phones as declared, not scraped", () => {
    const declared = found.phones.find((p) => p.value === "+97143406401");
    expect(declared.method).toBe("STRUCTURED_DATA");
  });

  it("reads a phone out of a framework state blob", () => {
    expect(phones).toContain("043406402");
  });

  it("does not read review counts or version strings as phones", () => {
    expect(phones).not.toContain("12345");
    expect(phones.some((v) => v.replace(/\D/g, "") === "2158")).toBe(false);
  });

  it("collects sameAs profiles the page renders no icons for", () => {
    expect(networks).toEqual(expect.arrayContaining(["INSTAGRAM", "FACEBOOK", "LINKEDIN"]));
  });

  it("keeps the sameAs handle, not just the URL", () => {
    const ig = found.socials.find((s) => s.network === "INSTAGRAM");
    expect(ig.handle).toBe("acmekebab");
  });
});
