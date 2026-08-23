import * as cheerio from "cheerio";
import { normalizeUrl } from "../../utils/normalize.js";

/** Page-level facts that both the auditor and the signal engine consume. */
export const extractPageMeta = (html, pageUrl) => {
  const $ = cheerio.load(html || "");

  const metaContent = (selector) => {
    const v = $(selector).attr("content");
    return v ? String(v).trim() : null;
  };

  const title = $("title").first().text().trim() || null;
  const description = metaContent('meta[name="description" i]') || metaContent('meta[property="og:description" i]');
  const viewport = metaContent('meta[name="viewport" i]');
  const generator = metaContent('meta[name="generator" i]');
  const lang = $("html").attr("lang")?.trim() || null;
  const canonical = $('link[rel="canonical" i]').attr("href") || null;

  // JSON-LD is the highest-value structured data: it often carries the legal
  // business name, address, phone and opening hours in one clean object.
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw?.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      for (const node of Array.isArray(parsed) ? parsed : [parsed]) {
        if (node && typeof node === "object") jsonLd.push(node);
      }
    } catch {
      // Malformed JSON-LD is extremely common; ignore rather than fail the page.
    }
  });
  const hasMicrodata = $("[itemscope]").length > 0;

  // Copyright year drives the OLD_COPYRIGHT signal — a footer still claiming
  // 2019 is one of the most reliable "nobody maintains this site" markers.
  const bodyText = $("script, style, noscript").remove().end().text().replace(/\s+/g, " ");
  const years = [...bodyText.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[–—-]\s*)?(\d{4})/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1995 && y <= new Date().getFullYear() + 1);
  const copyrightYear = years.length ? Math.max(...years) : null;

  // Signals of transactional capability. Their *absence* on a business that
  // obviously needs them is the opportunity.
  const links = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const abs = normalizeUrl(href, pageUrl);
    if (abs) links.push({ href: abs, text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 120) });
  });

  const linkBlob = links.map((l) => `${l.href} ${l.text}`).join(" ").toLowerCase();
  const pageBlob = `${bodyText} ${linkBlob}`.toLowerCase();

  const hasContactForm = $("form").toArray().some((el) => {
    const $f = $(el);
    const hasEmailField = $f.find('input[type="email" i], input[name*="email" i]').length > 0;
    const hasMessage = $f.find("textarea").length > 0;
    const isSearch = $f.attr("role") === "search" || $f.find('input[type="search" i]').length > 0;
    return !isSearch && (hasEmailField || hasMessage);
  });

  return {
    title,
    description,
    viewport,
    hasViewport: Boolean(viewport),
    generator,
    lang,
    canonical,
    jsonLd,
    hasJsonLd: jsonLd.length > 0,
    hasMicrodata,
    hasSchemaOrg: jsonLd.length > 0 || hasMicrodata,
    copyrightYear,
    hasContactForm,
    links,
    textLength: bodyText.trim().length,
    imageCount: $("img").length,
    imagesWithoutAlt: $("img:not([alt])").length,
    // Transactional capability markers
    hasCartLink: /\b(?:add to cart|shopping cart|\/cart|basket|checkout)\b/.test(pageBlob),
    hasOnlineOrdering: /\b(?:order online|order now|\/order|delivery|deliveroo|talabat|ubereats|uber eats|doordash|just ?eat|zomato|grubhub)\b/.test(pageBlob),
    hasBookingLink: /\b(?:book (?:now|online|a table|an appointment)|reservation|reserve a table|make an appointment|schedule a|calendly|opentable|resy)\b/.test(pageBlob),
    hasMenuPdf: /\.pdf\b/.test(linkBlob) && /\bmenu\b/.test(pageBlob),
    mentionsCallToOrder: /\b(?:call (?:us )?to order|phone (?:us )?to order|call for (?:reservations|bookings|appointment))\b/.test(pageBlob),
    mentionsGrowth: /\b(?:now open|newly opened|we(?:'| a)re (?:expanding|growing|hiring)|second location|new branch|coming soon|grand opening)\b/.test(pageBlob),
    bodyTextSample: bodyText.trim().slice(0, 4000),
  };
};

/** Pull the business identity fields out of schema.org LocalBusiness/Organization. */
export const extractOrganizationFromJsonLd = (jsonLd = []) => {
  const flatten = (node, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      node.forEach((n) => flatten(n, out));
      return out;
    }
    out.push(node);
    if (node["@graph"]) flatten(node["@graph"], out);
    return out;
  };

  const ORG_TYPES = /organization|localbusiness|restaurant|store|hotel|professionalservice|medicalbusiness|dentist|corporation/i;
  for (const node of flatten(jsonLd)) {
    const type = [].concat(node["@type"] || []).join(" ");
    if (!ORG_TYPES.test(type)) continue;
    const addr = node.address || {};
    return {
      name: typeof node.name === "string" ? node.name : null,
      legalName: node.legalName || null,
      email: typeof node.email === "string" ? node.email.replace(/^mailto:/, "") : null,
      telephone: typeof node.telephone === "string" ? node.telephone : null,
      url: typeof node.url === "string" ? node.url : null,
      description: typeof node.description === "string" ? node.description.slice(0, 2000) : null,
      streetAddress: addr.streetAddress || null,
      city: addr.addressLocality || null,
      region: addr.addressRegion || null,
      postalCode: addr.postalCode || null,
      country: typeof addr.addressCountry === "string" ? addr.addressCountry : addr.addressCountry?.name || null,
      openingHours: node.openingHours || node.openingHoursSpecification || null,
      schemaType: type,
    };
  }
  return null;
};
