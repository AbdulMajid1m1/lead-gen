/**
 * Technology fingerprints — Wappalyzer-style, but hand-curated for the signals
 * that actually change the sales pitch.
 *
 * Each fingerprint declares how it can be proven. `evidence` is what gets
 * written to ExtractedFact so the UI can say *why* we claim WooCommerce, not
 * just that we do.
 *
 * confidence: VERIFIED  → unambiguous, vendor-authored marker (meta generator,
 *                         vendor header, vendor-namespaced asset path)
 *             DETECTED  → strong but shared/heuristic marker
 */
export const FINGERPRINTS = [
  // ─── CMS ────────────────────────────────────────────────────────────────────
  { name: "WordPress", category: "CMS", confidence: "VERIFIED",
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]+)?/i],
    urls: [/\/wp-content\//i, /\/wp-includes\//i, /\/wp-json\//i],
    headers: { link: /wp-json/i } },
  { name: "Shopify", category: "ECOMMERCE", confidence: "VERIFIED",
    html: [/cdn\.shopify\.com/i, /Shopify\.theme/i, /window\.Shopify/i],
    headers: { "x-shopid": /.+/, "powered-by": /shopify/i } },
  { name: "Wix", category: "SITE_BUILDER", confidence: "VERIFIED",
    html: [/static\.parastorage\.com/i, /<meta[^>]+content=["']Wix\.com Website Builder/i],
    headers: { "x-wix-request-id": /.+/ } },
  { name: "Squarespace", category: "SITE_BUILDER", confidence: "VERIFIED",
    html: [/static1\.squarespace\.com/i, /Static\.SQUARESPACE_CONTEXT/i] },
  { name: "Webflow", category: "SITE_BUILDER", confidence: "VERIFIED",
    html: [/<meta[^>]+content=["']Webflow["']/i, /assets(?:-global)?\.website-files\.com/i] },
  { name: "GoDaddy Website Builder", category: "SITE_BUILDER", confidence: "VERIFIED",
    html: [/img1\.wsimg\.com/i, /nonprod-cdn\.godaddysites\.com/i] },
  { name: "Joomla", category: "CMS", confidence: "VERIFIED",
    html: [/<meta[^>]+name=["']generator["'][^>]+content=["']Joomla/i, /\/media\/jui\//i] },
  { name: "Drupal", category: "CMS", confidence: "VERIFIED",
    html: [/<meta[^>]+content=["']Drupal\s*([\d.]+)?/i, /\/sites\/default\/files\//i],
    headers: { "x-generator": /drupal/i } },
  { name: "Ghost", category: "CMS", confidence: "VERIFIED",
    html: [/<meta[^>]+content=["']Ghost\s*([\d.]+)?/i] },
  { name: "HubSpot CMS", category: "CMS", confidence: "VERIFIED",
    html: [/hs-scripts\.com/i, /cdn2?\.hubspot\.net/i] },

  // ─── E-commerce ─────────────────────────────────────────────────────────────
  { name: "WooCommerce", category: "ECOMMERCE", confidence: "VERIFIED",
    html: [/woocommerce(?:-|\.)/i, /\/plugins\/woocommerce\//i, /wc-ajax/i] },
  { name: "Magento", category: "ECOMMERCE", confidence: "VERIFIED",
    html: [/\/static\/version\d+\/frontend\//i, /Magento_/i, /mage\/cookies/i] },
  { name: "BigCommerce", category: "ECOMMERCE", confidence: "VERIFIED",
    html: [/cdn\d*\.bigcommerce\.com/i] },
  { name: "PrestaShop", category: "ECOMMERCE", confidence: "VERIFIED",
    html: [/<meta[^>]+content=["']PrestaShop/i, /prestashop\.js/i] },
  { name: "Squarespace Commerce", category: "ECOMMERCE", confidence: "DETECTED",
    html: [/squarespace[^"']*commerce/i] },

  // ─── Frontend frameworks (a modern stack = less likely a rebuild lead) ──────
  { name: "Next.js", category: "FRAMEWORK", confidence: "VERIFIED",
    html: [/\/_next\/static\//i, /__NEXT_DATA__/],
    headers: { "x-powered-by": /next\.js/i } },
  { name: "Nuxt", category: "FRAMEWORK", confidence: "VERIFIED",
    html: [/\/_nuxt\//i, /__NUXT__/] },
  { name: "React", category: "FRAMEWORK", confidence: "DETECTED",
    html: [/data-reactroot/i, /react(?:-dom)?(?:\.production)?(?:\.min)?\.js/i] },
  { name: "Vue.js", category: "FRAMEWORK", confidence: "DETECTED",
    html: [/data-v-[0-9a-f]{8}/i, /vue(?:\.runtime)?(?:\.min)?\.js/i] },
  { name: "Angular", category: "FRAMEWORK", confidence: "DETECTED",
    html: [/ng-version=/i, /<app-root/i] },
  { name: "jQuery", category: "LIBRARY", confidence: "DETECTED",
    html: [/jquery[.-]?([\d.]+)?(?:\.min)?\.js/i, /jQuery v?([\d.]+)/i] },
  { name: "Bootstrap", category: "LIBRARY", confidence: "DETECTED",
    html: [/bootstrap(?:\.bundle)?(?:\.min)?\.(?:js|css)/i] },
  { name: "Tailwind CSS", category: "LIBRARY", confidence: "DETECTED",
    html: [/tailwind(?:css)?(?:\.min)?\.css/i, /class="[^"]*\b(?:flex|grid)\s+(?:items-center|justify-between)\b/] },

  // ─── Analytics / marketing (absence is itself a signal) ─────────────────────
  { name: "Google Analytics 4", category: "ANALYTICS", confidence: "VERIFIED",
    html: [/gtag\/js\?id=G-/i, /googletagmanager\.com\/gtag/i] },
  { name: "Google Analytics (Universal)", category: "ANALYTICS", confidence: "VERIFIED",
    html: [/google-analytics\.com\/analytics\.js/i, /ga\(\s*['"]create['"]/i] },
  { name: "Google Tag Manager", category: "ANALYTICS", confidence: "VERIFIED",
    html: [/googletagmanager\.com\/gtm\.js/i, /GTM-[A-Z0-9]{4,9}/] },
  { name: "Meta Pixel", category: "ANALYTICS", confidence: "VERIFIED",
    html: [/connect\.facebook\.net\/[^"']*fbevents\.js/i, /fbq\(\s*['"]init['"]/i] },
  { name: "Hotjar", category: "ANALYTICS", confidence: "VERIFIED", html: [/static\.hotjar\.com/i] },
  { name: "Plausible", category: "ANALYTICS", confidence: "VERIFIED", html: [/plausible\.io\/js/i] },

  // ─── CRM / marketing automation (presence ⇒ NOT a CRM lead) ────────────────
  { name: "HubSpot", category: "CRM", confidence: "VERIFIED",
    html: [/js\.hs-scripts\.com/i, /hsforms\.(?:net|com)/i, /hubspot\.com\/analytics/i] },
  { name: "Salesforce", category: "CRM", confidence: "VERIFIED",
    html: [/salesforce(?:liveagent)?\.com/i, /pardot\.com/i, /force\.com/i] },
  { name: "Zoho", category: "CRM", confidence: "VERIFIED",
    html: [/zoho\.(?:com|eu)\/(?:crm|salesiq|bookings)/i, /js\.zohocdn\.com/i] },
  { name: "Mailchimp", category: "MARKETING", confidence: "VERIFIED",
    html: [/list-manage\.com\/subscribe/i, /chimpstatic\.com/i] },
  { name: "Klaviyo", category: "MARKETING", confidence: "VERIFIED", html: [/static\.klaviyo\.com/i] },
  { name: "Intercom", category: "SUPPORT", confidence: "VERIFIED",
    html: [/widget\.intercom\.io/i, /intercomSettings/i] },
  { name: "Zendesk", category: "SUPPORT", confidence: "VERIFIED",
    html: [/static\.zdassets\.com/i, /zendesk\.com\/embeddable/i] },
  { name: "Crisp", category: "SUPPORT", confidence: "VERIFIED", html: [/client\.crisp\.chat/i] },
  { name: "Tawk.to", category: "SUPPORT", confidence: "VERIFIED", html: [/embed\.tawk\.to/i] },

  // ─── Booking / scheduling (absence + appointment industry ⇒ opportunity) ───
  { name: "Calendly", category: "BOOKING", confidence: "VERIFIED", html: [/assets\.calendly\.com/i, /calendly\.com\/[a-z0-9-]/i] },
  { name: "OpenTable", category: "BOOKING", confidence: "VERIFIED", html: [/opentable\.[a-z.]+\/(?:restref|widget)/i] },
  { name: "Resy", category: "BOOKING", confidence: "VERIFIED", html: [/resy\.com\/cities/i, /widgets\.resy\.com/i] },
  { name: "Acuity Scheduling", category: "BOOKING", confidence: "VERIFIED", html: [/acuityscheduling\.com/i] },
  { name: "Booksy", category: "BOOKING", confidence: "VERIFIED", html: [/booksy\.com/i] },
  { name: "SimplyBook", category: "BOOKING", confidence: "VERIFIED", html: [/simplybook\.(?:me|it)/i] },

  // ─── Payments ───────────────────────────────────────────────────────────────
  { name: "Stripe", category: "PAYMENT", confidence: "VERIFIED", html: [/js\.stripe\.com/i] },
  { name: "PayPal", category: "PAYMENT", confidence: "VERIFIED", html: [/paypal(?:objects)?\.com\/(?:sdk|api)/i] },
  { name: "Square", category: "PAYMENT", confidence: "VERIFIED", html: [/squareupsandbox|web\.squarecdn\.com|squareup\.com\/(?:appointments|store)/i] },

  // ─── Infrastructure ─────────────────────────────────────────────────────────
  { name: "Cloudflare", category: "CDN", confidence: "VERIFIED", headers: { "cf-ray": /.+/, server: /cloudflare/i } },
  { name: "Vercel", category: "HOSTING", confidence: "VERIFIED", headers: { server: /vercel/i, "x-vercel-id": /.+/ } },
  { name: "Netlify", category: "HOSTING", confidence: "VERIFIED", headers: { server: /netlify/i, "x-nf-request-id": /.+/ } },
  { name: "Apache", category: "SERVER", confidence: "DETECTED", headers: { server: /apache/i } },
  { name: "Nginx", category: "SERVER", confidence: "DETECTED", headers: { server: /nginx/i } },
  { name: "Microsoft IIS", category: "SERVER", confidence: "DETECTED", headers: { server: /iis|microsoft-httpapi/i } },
  { name: "PHP", category: "LANGUAGE", confidence: "DETECTED", headers: { "x-powered-by": /php\/?([\d.]+)?/i } },
  { name: "ASP.NET", category: "LANGUAGE", confidence: "DETECTED",
    headers: { "x-aspnet-version": /.+/, "x-powered-by": /asp\.net/i },
    html: [/__VIEWSTATE/] },
];

/**
 * Versions worth flagging as an outdated/EOL stack. These drive the
 * "legacy technology" signal, so each entry names the business consequence.
 */
export const EOL_MARKERS = [
  { tech: "jQuery",  test: (v) => v && Number.parseFloat(v) < 3, note: "jQuery 1.x/2.x is unsupported and carries known XSS advisories." },
  { tech: "PHP",     test: (v) => v && Number.parseFloat(v) < 8, note: "PHP 7.x and below are end-of-life — no security patches." },
  { tech: "Bootstrap", test: (v) => v && Number.parseFloat(v) < 4, note: "Bootstrap 3 predates modern responsive practice." },
];
