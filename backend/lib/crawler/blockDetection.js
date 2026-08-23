/**
 * Detects bot-walls, CAPTCHA interstitials and JS challenges.
 *
 * The system never attempts to solve or bypass any of these — detection exists
 * so the crawl is *abandoned* with an honest `blockReason`, the host is backed
 * off, and the lead falls back to another legitimate source.
 */

const SIGNATURES = [
  // vendor bot-walls
  { reason: "CLOUDFLARE_CHALLENGE", test: (b) => /cf-browser-verification|cf_chl_opt|Checking your browser before accessing|__cf_chl_/i.test(b) },
  { reason: "CLOUDFLARE_BLOCK",     test: (b) => /Attention Required!\s*\|\s*Cloudflare|Sorry, you have been blocked/i.test(b) },
  { reason: "AKAMAI_BOT_MANAGER",   test: (b) => /Access Denied[\s\S]{0,200}Reference #\d|akamai reference/i.test(b) },
  { reason: "IMPERVA_INCAPSULA",    test: (b) => /_Incapsula_Resource|incident_id|Incapsula/i.test(b) },
  { reason: "PERIMETERX",           test: (b) => /_pxhd|px-captcha|perimeterx/i.test(b) },
  { reason: "DATADOME",             test: (b) => /datadome|dd_cookie_test/i.test(b) },
  { reason: "SUCURI_FIREWALL",      test: (b) => /sucuri_cloudproxy|Access Denied - Sucuri/i.test(b) },
  // CAPTCHA widgets
  { reason: "RECAPTCHA",            test: (b) => /google\.com\/recaptcha|grecaptcha\.|g-recaptcha/i.test(b) },
  { reason: "HCAPTCHA",             test: (b) => /hcaptcha\.com\/|h-captcha/i.test(b) },
  { reason: "TURNSTILE",            test: (b) => /challenges\.cloudflare\.com\/turnstile|cf-turnstile/i.test(b) },
  // generic walls
  { reason: "LOGIN_WALL",           test: (b) => /<form[^>]*(?:login|signin|sign-in)[^>]*>[\s\S]{0,600}type=["']password["']/i.test(b) },
  { reason: "PAYWALL",              test: (b) => /(?:subscribe|subscription) (?:to )?(?:continue reading|read the full)|isAccessibleForFree["']?\s*:\s*["']?False/i.test(b) },
  { reason: "AGE_GATE",             test: (b) => /are you (?:over|at least) (?:18|21)|age.?verification/i.test(b) },
];

const JS_APP_SHELL = /<div id=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i;

/**
 * @param {{status:number, headers:object, body:string, contentType:string}} res
 * @returns {{blocked:boolean, reason:string|null, detail:string|null, jsRendered:boolean}}
 */
export const detectBlock = (res) => {
  const { status, headers = {}, body = "", contentType = "" } = res;
  const server = String(headers.server || "").toLowerCase();

  // Header-level tells, cheaper and more reliable than body matching.
  if (headers["cf-mitigated"] === "challenge") {
    return { blocked: true, reason: "CLOUDFLARE_CHALLENGE", detail: "cf-mitigated: challenge", jsRendered: false };
  }
  if (status === 403 && (server.includes("cloudflare") || headers["cf-ray"])) {
    return { blocked: true, reason: "CLOUDFLARE_BLOCK", detail: "403 from Cloudflare edge", jsRendered: false };
  }
  if (status === 401) {
    return { blocked: true, reason: "AUTH_REQUIRED", detail: "401 Unauthorized", jsRendered: false };
  }
  if (status === 402) {
    return { blocked: true, reason: "PAYMENT_REQUIRED", detail: "402 Payment Required", jsRendered: false };
  }
  if (status === 429) {
    return { blocked: true, reason: "RATE_LIMITED", detail: "429 Too Many Requests", jsRendered: false };
  }
  if (status === 451) {
    return { blocked: true, reason: "LEGAL_BLOCK", detail: "451 Unavailable For Legal Reasons", jsRendered: false };
  }

  const isHtml = contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(body);
  if (!isHtml || !body) {
    return { blocked: false, reason: null, detail: null, jsRendered: false };
  }

  const textLength = body.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;

  // A challenge page carries almost no readable content. Judging by *visible
  // text* rather than raw HTML size is what separates a bot-wall from an
  // ordinary contact page that happens to embed a reCAPTCHA in its form —
  // markup weight alone misclassifies both directions.
  const contentless = textLength < 1500;

  for (const sig of SIGNATURES) {
    if (!sig.test(body)) continue;
    const softSignal = sig.reason === "RECAPTCHA" || sig.reason === "HCAPTCHA" || sig.reason === "TURNSTILE" || sig.reason === "LOGIN_WALL";
    if (softSignal && !contentless) continue; // widget on a real page, not a wall
    return { blocked: true, reason: sig.reason, detail: `matched ${sig.reason} signature`, jsRendered: false };
  }

  // Not a block, but worth recording: an empty SPA shell means the useful
  // content is client-rendered and our HTML extractors will find little.

  const jsRendered = JS_APP_SHELL.test(body) && textLength < 500;
  return { blocked: false, reason: null, detail: null, jsRendered };
};
