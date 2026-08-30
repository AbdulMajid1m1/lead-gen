import { FINGERPRINTS, EOL_MARKERS } from "./fingerprints.js";

const VERSION_RE = {
  jQuery: [/jquery[.-]?v?(\d+\.\d+(?:\.\d+)?)(?:\.min)?\.js/i, /jQuery v?(\d+\.\d+(?:\.\d+)?)/i],
  Bootstrap: [/bootstrap[.-]?v?(\d+\.\d+(?:\.\d+)?)/i],
  WordPress: [/content=["']WordPress\s+(\d+\.\d+(?:\.\d+)?)/i],
  Drupal: [/content=["']Drupal\s+(\d+)/i],
};

const versionFrom = (name, html, headers) => {
  if (name === "PHP") {
    const m = /php\/?\s*(\d+\.\d+(?:\.\d+)?)/i.exec(String(headers["x-powered-by"] || ""));
    return m?.[1] || null;
  }
  for (const re of VERSION_RE[name] || []) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
};

/** Keep evidence short and quotable — it is rendered verbatim in the UI. */
const snippet = (html, re) => {
  const m = re.exec(html);
  if (!m) return null;
  const start = Math.max(0, m.index - 30);
  return html.slice(start, Math.min(html.length, m.index + m[0].length + 30)).replace(/\s+/g, " ").trim();
};

/**
 * Detect the technologies behind a page from its HTML + response headers.
 *
 * @param {{html:string, headers:object, url:string}} input
 * @returns {Array<{name, category, confidence, version, evidence, matchedOn}>}
 */
export const detectTechnologies = ({ html = "", headers = {}, url = null } = {}) => {
  const found = new Map();
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
  );

  for (const fp of FINGERPRINTS) {
    let matchedOn = null;
    let evidence = null;

    // Header matches are the strongest: the server itself declared it.
    for (const [header, re] of Object.entries(fp.headers || {})) {
      const value = lowerHeaders[header];
      if (value && re.test(value)) {
        matchedOn = "HEADER";
        evidence = `response header "${header}: ${value.slice(0, 120)}"`;
        break;
      }
    }

    if (!matchedOn) {
      for (const re of fp.html || []) {
        if (re.test(html)) {
          matchedOn = "HTML";
          evidence = `page markup matched ${re.source.slice(0, 60)} → "${snippet(html, re)?.slice(0, 140)}"`;
          break;
        }
      }
    }

    if (!matchedOn) {
      for (const re of fp.urls || []) {
        if (re.test(html)) {
          matchedOn = "ASSET_URL";
          evidence = `asset path matched ${re.source}`;
          break;
        }
      }
    }

    if (!matchedOn) continue;

    // A marker that proves the *software* is present is not always proof
    // the site *uses* it: every WordPress theme that bundles the WooCommerce
    // plugin ships its stylesheet, shop or no shop. `htmlAll` lists markers
    // that must all be present as well — for WooCommerce, actual product or
    // cart markup — before the fingerprint counts.
    if (fp.htmlAll && !fp.htmlAll.every((re) => re.test(html))) continue;

    const version = versionFrom(fp.name, html, lowerHeaders);
    found.set(fp.name, {
      name: fp.name,
      category: fp.category,
      // A header proof upgrades a DETECTED fingerprint to VERIFIED.
      confidence: matchedOn === "HEADER" ? "VERIFIED" : fp.confidence,
      version,
      matchedOn,
      evidence,
      sourceUrl: url,
    });
  }

  const technologies = [...found.values()];

  // WooCommerce/Elementor imply WordPress even when the generator tag is stripped.
  if (found.has("WooCommerce") && !found.has("WordPress")) {
    technologies.push({
      name: "WordPress", category: "CMS", confidence: "INFERRED", version: null,
      matchedOn: "INFERENCE", evidence: "WooCommerce only runs on WordPress.", sourceUrl: url,
    });
  }

  const outdated = [];
  for (const marker of EOL_MARKERS) {
    const tech = technologies.find((t) => t.name === marker.tech);
    if (tech && marker.test(tech.version)) {
      outdated.push({ name: tech.name, version: tech.version, note: marker.note, evidence: tech.evidence });
    }
  }

  return { technologies, outdated };
};

/** Convenience roll-up the signal engine reads. */
export const summarizeStack = ({ technologies }) => {
  const by = (cat) => technologies.filter((t) => t.category === cat).map((t) => t.name);
  return {
    cms: by("CMS")[0] || by("SITE_BUILDER")[0] || null,
    ecommerce: by("ECOMMERCE")[0] || null,
    crm: by("CRM")[0] || null,
    booking: by("BOOKING")[0] || null,
    analytics: by("ANALYTICS"),
    payment: by("PAYMENT"),
    support: by("SUPPORT"),
    frameworks: by("FRAMEWORK"),
    hasModernFramework: technologies.some((t) => t.category === "FRAMEWORK" && ["Next.js", "Nuxt", "React", "Vue.js", "Angular"].includes(t.name)),
    hasAnalytics: by("ANALYTICS").length > 0,
    hasCrm: by("CRM").length > 0,
    hasBooking: by("BOOKING").length > 0,
    hasEcommerce: by("ECOMMERCE").length > 0,
    hasLiveChat: by("SUPPORT").length > 0,
  };
};
