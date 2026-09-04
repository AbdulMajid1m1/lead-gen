import { SERVICE_PITCH } from "../scoring/recommend.js";
import { OSM_CATEGORIES } from "../adapters/overpass.js";

/**
 * Deterministic email templates — the guaranteed-good fallback when no AI
 * provider is available, and the only author of follow-ups when AI is down.
 *
 * Rules the templates share with the AI path:
 *  - every specific claim comes from a gathered fact, never invention;
 *  - plain URLs only, no markdown;
 *  - short, peer-to-peer, one observation → one value line → one soft question.
 */

/**
 * Facts that read badly when quoted in an email opener: the audit score line,
 * the zero-weight "a contact was found" bookkeeping signals, and the two
 * disqualifiers — none of which is something to tell a stranger you noticed.
 */
const OPENER_BLOCKLIST =
  /technical audit|scores \d+\/100|was found\.|working contact form|as a contact\.|permanently closed|is not this company's website/i;

/**
 * Every observation a fact list can open with, strongest first.
 *
 * Strength is how concrete and how costly the thing is to the reader: "no
 * website" and "bookings only by phone" are losses they can feel; "runs
 * WordPress" is a fact about a CMS. The previous rule — first non-verified
 * fact wins — let a 95/100 site open with "I noticed the site runs WordPress"
 * while "no analytics installed" sat unused two lines down.
 */
const HOOK_PRIORITY = [
  "NO_WEBSITE", "NO_BOOKING", "NO_ORDERING", "SLOW_SITE", "NO_MOBILE", "NO_HTTPS",
  "OLD_COPYRIGHT", "OUTDATED_CMS", "EXPANSION", "HIRING", "AUTOMATION", "NO_APP",
  "NEW_DOMAIN", "NO_SCHEMA", "BUILDER", "NO_ANALYTICS", "TECH_DEBT", "DEFAULT",
];
const hookRank = (fact) => {
  const i = HOOK_PRIORITY.indexOf(classifyObservation(fact.text));
  return i < 0 ? HOOK_PRIORITY.length : i;
};

/** The quotable facts, strongest observation first; catalogue order breaks ties. */
/** Facts that say the business has a web presence of its own. */
const HAS_SITE_RE = /^Its website is |^Its email is on its own domain/;
export const factsShowWebsite = (facts) => facts.some((f) => HAS_SITE_RE.test(String(f?.text || "")));

const rankedObservations = (facts) => {
  // gatherFacts always puts the identity line first, but a fact list built
  // elsewhere may not — so the first fact is set aside only when it reads as
  // one ("X is a restaurant in Jeddah"), not merely because it is first.
  const first = facts[0];
  const identity = first && / is an? /.test(first.text) && classifyObservation(first.text) === "DEFAULT" ? first : null;
  // A stale "no website" reason must never open an email to a business whose
  // own domain is in the same fact list — Vapiano and Moda Cafe both got one.
  const hasWebsite = factsShowWebsite(facts);
  return facts
    .filter((f) => f !== identity && !OPENER_BLOCKLIST.test(f.text) && !/^Its website is|^Its address is|^Its email is on its own domain/.test(f.text))
    .filter((f) => classifyObservation(f.text) !== "FAST_SITE")
    .filter((f) => !(hasWebsite && classifyObservation(f.text) === "NO_WEBSITE"))
    .map((f, index) => ({ f, index }))
    .sort((a, b) => hookRank(a.f) - hookRank(b.f) || a.index - b.index)
    .map(({ f }) => f);
};

/**
 * Pick the strongest quotable observation from the fact list.
 *
 * The first fact is always the identity line ("X is a restaurant in Jeddah") —
 * telling a company what it is makes a terrible opener, so it is only the last
 * resort. Signal reasons ("listed with contact details but no website at all")
 * are the real hooks and come first.
 */
export const pickObservation = (facts) => rankedObservations(facts)[0] || facts[0];

const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * A company description that never degenerates to "<name>." — it stacks every
 * verified detail it has and says honestly when there is little.
 */
export const aboutFromFacts = ({ company, facts }) => {
  const parts = [];
  const industry = company.industry && company.industry !== "Technology employer"
    ? company.industry.toLowerCase()
    : null;
  const head = `${company.name} is ${industry ? `a ${industry}` : "a company"}${company.city ? ` based in ${company.city}` : ""}${company.countryCode ? ` (${company.countryCode})` : ""}.`;
  parts.push(head);

  const site = facts.find((f) => /^Its website is /.test(f.text));
  if (site) parts.push(site.text);

  const hiring = facts.filter((f) => /^It is currently hiring/.test(f.text)).slice(0, 2);
  if (hiring.length) parts.push(hiring.map((f) => f.text).join(" "));

  const built = facts.find((f) => /^Its site is built on /.test(f.text));
  if (built) parts.push(built.text);

  if (parts.length === 1 && !industry && !company.city) {
    parts.push("Little is verified about it yet beyond the records above.");
  }
  return parts.join(" ").slice(0, 1000);
};

/**
 * Conversion copy per service: a curiosity subject, the pain made concrete for
 * that business, and the outcome (never features). Mirrors the structure the
 * AI is prompted with (COMPOSE_SYSTEM): hook → pain → value → tiny CTA.
 */
const PITCH_COPY = {
  WEBSITE_DEV: {
    subject: (name) => `Customers can't find ${name} online`,
    subjectAr: (name) => `عملاؤك يبحثون عن ${name} ولا يجدونه`,
    pain: "people searching for a place like yours right now are finding competitors first — every one of those searches is a lost customer",
    value: "We build fast, mobile-first websites that turn those searches into calls and orders. Most go live in 2-3 weeks",
    painAr: "من يبحث الآن عن نشاط مثل نشاطك يجد منافسيك أولاً — وكل بحث ضائع يعني عميلاً ضائعاً",
    valueAr: "نبني مواقع سريعة تعمل على الجوال وتحوّل عمليات البحث إلى اتصالات وطلبات، وغالباً يجهز الموقع خلال ٢-٣ أسابيع",
  },
  ECOMMERCE_DEV: {
    subject: (name) => `${name} could be selling while closed`,
    subjectAr: (name) => `${name} يمكنه البيع حتى بعد الإغلاق`,
    pain: "every hour you are closed — or your phone is busy — is an order going to someone who sells online",
    value: "We set up online ordering that takes sales 24/7, without changing how you work in-store",
    painAr: "كل ساعة إغلاق أو انشغال في الهاتف تعني طلباً يذهب لمن يبيع أونلاين",
    valueAr: "نجهز لك طلبات أونلاين تستقبل المبيعات ٢٤ ساعة دون تغيير طريقة عملك بالمحل",
  },
  MOBILE_APP: {
    subject: (name) => `Your regulars would order from a ${name} app`,
    subjectAr: (name) => `زبائنك الدائمون سيطلبون من تطبيق ${name}`,
    pain: "repeat customers have no two-tap way to order or book, so they drift to whoever is easiest",
    value: "We build simple apps that make reordering effortless — repeat orders typically climb within weeks",
    painAr: "زبائنك الدائمون لا يملكون طريقة سهلة للطلب فيتجهون لمن يسهّل عليهم",
    valueAr: "نبني تطبيقات بسيطة تجعل إعادة الطلب بلمستين — وعادة ترتفع الطلبات المتكررة خلال أسابيع",
  },
  AI_AUTOMATION: {
    subject: (name) => `Hours ${name} loses to manual work`,
    pain: "staff hours are going into phone calls, messages and paperwork that software now handles automatically",
    value: "We automate the repetitive part so your team spends its time on customers, not admin",
  },
  CRM_DEV: {
    subject: (name) => `Follow-ups slipping through at ${name}`,
    pain: "when customer details live in inboxes and notebooks, follow-ups get missed and repeat business quietly leaks away",
    value: "We put every customer and follow-up in one place, so nothing slips",
  },
  SAAS_DEV: {
    subject: (name) => `${name}'s internal tools, product-grade`,
    pain: "growth is outrunning the internal tooling, and the workarounds are starting to cost real time",
    value: "We turn the process you already run into reliable software your team and customers can use",
  },
  HR_SOFTWARE: {
    subject: (name) => `Payroll and leave at ${name}, one system`,
    pain: "payroll, leave and attendance across spreadsheets gets worse with every new hire",
    value: "We put HR in one platform before the spreadsheet chaos compounds",
  },
  CUSTOM_SOFTWARE: {
    subject: (name) => `Delivery capacity for ${name}`,
    pain: "the roadmap is bigger than the team currently building it, and hiring takes months",
    value: "We plug in as a delivery team that ships while you hire",
  },
};

const ARABIC = /[؀-ۿ]/;

/**
 * What the chosen observation is actually about. The subject and pain line are
 * picked from this, not from the service alone — pairing a "runs on
 * WooCommerce" hook with a "customers can't find you online" pain reads as
 * automated within one sentence, and a lead with a website must never be told
 * it has none.
 */
const OBSERVATION_KINDS = [
  { kind: "NO_WEBSITE", re: /no website at all|has no website|without a website/i },
  { kind: "SLOW_SITE", re: /took [\d.]+ ?s|slow to respond|page speed|slow site/i },
  { kind: "NO_BOOKING", re: /no online booking|reservation costs|booking.*phone|appointments are by phone/i },
  { kind: "NO_ORDERING", re: /sells to walk-in customers|no way to order or buy online|no online ordering/i },
  { kind: "NO_MOBILE", re: /viewport|zoomed-out desktop|not mobile|table layout|breaks on mobile/i },
  { kind: "NO_HTTPS", re: /plain HTTP|not secure/i },
  { kind: "OLD_COPYRIGHT", re: /copyright still reads|footer still says/i },
  { kind: "OUTDATED_CMS", re: /major versions behind|end-of-life|no longer receives security|out of support|security advisories|legacy Magento/i },
  { kind: "NO_SCHEMA", re: /schema\.org|rich search|map panels/i },
  { kind: "NO_ANALYTICS", re: /no analytics tag/i },
  { kind: "AUTOMATION", re: /phone or email for things competitors handle automatically/i },
  { kind: "NO_APP", re: /no mobile app presence|no native mobile app/i },
  { kind: "NEW_DOMAIN", re: /certificate transparency|subdomain appeared/i },
  { kind: "BUILDER", re: /built on (?:Wix|Squarespace|GoDaddy|Weebly)|template builder/i },
  { kind: "EXPANSION", re: /expansion|new location|branch or opening|new branch/i },
  { kind: "TECH_DEBT", re: /built on|outgrow|custom functionality|integrations|WordPress|WooCommerce/i },
  { kind: "HIRING", re: /currently hiring|careers page|open positions|roles are open/i },
];

/** A load time only counts as slow when it actually is; 1.6s is not a pitch. */
const SLOW_THRESHOLD_S = 2.5;

const classifyObservation = (text) => {
  const kind = OBSERVATION_KINDS.find((k) => k.re.test(text || ""))?.kind || "DEFAULT";
  if (kind === "SLOW_SITE") {
    const seconds = Number(/([\d.]+) ?s/.exec(text)?.[1] || 0);
    // A fast load time is not an observation to open with — it is nothing.
    if (seconds > 0 && seconds < SLOW_THRESHOLD_S) return "FAST_SITE";
  }
  return kind;
};

/**
 * Legal suffixes and trailing descriptors that make a subject line read as a
 * database record. "Al Nabooda Automobiles LLC" is a company; "Al Nabooda" is
 * what a colleague would write in a subject.
 */
const LEGAL_SUFFIX_RE =
  /\s*[,(]?\s*\b(?:gmbh|ag|ltd\.?|limited|llc|l\.l\.c\.?|inc\.?|corp\.?|co\.?|plc|fze|fzco|fz-llc|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|pty|kg|ug|e\.?k\.?|oy|ab|as|sa|lda)\b\.?\)?\s*$/i;

/**
 * The name as it would appear in a subject: legal suffix dropped, at most
 * three words, or nothing when the result would still be too long to glance
 * at — in which case the subject falls back to a "your …" form.
 */
export const shortName = (name) => {
  const raw = String(name || "").trim();
  // "Kay & Co", "Smith and Sons Co" — the "Co" is the brand, not a suffix.
  const brandSuffix = /(?:&|\band)\s+(?:co|sons?)\.?$/i.test(raw);
  const trimmed = (brandSuffix ? raw : raw.replace(LEGAL_SUFFIX_RE, "")).replace(/\s+[-–—|:].*$/, "").trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3 || trimmed.length > 24) return null;
  return trimmed;
};

const firstNumber = (text, re) => {
  const m = re.exec(text || "");
  return m ? m[1] : null;
};

/** "Currently hiring Senior Backend Engineer in Berlin — an active…" → title, location. */
const hiringDetail = (text) => {
  const t = String(text || "").trim();
  let m = /^it is currently hiring:\s*(.+?)\.?$/i.exec(t);
  if (m) return { title: m[1] };
  m = /^currently hiring\s+(.+?)(?:\s+in\s+([^,—–]+?))?\s*(?:[,—–]\s.*)?\.?$/i.exec(t);
  if (m) return { title: m[1].trim(), location: m[2]?.trim() || null };
  m = /^(\d+)\s+roles are open/i.exec(t);
  if (m) return { count: Number(m[1]) };
  return {};
};

/** "WordPress 5.7.17 is several major versions…" / "The site runs jQuery 1.12, which…" → the thing. */
const softwareDetail = (text) => {
  const t = String(text || "").replace(/^the (?:site|store|server) (?:runs|advertises)(?: on)?\s+/i, "").trim();
  const m = /^(.+?)(?:,|\s+is\s+|\s+which\s+|\s+that\s+|\.$)/.exec(t);
  const thing = m ? m[1].trim() : null;
  // "an end-of-life PHP version" is a phrase, not a product name.
  return thing && thing.split(/\s+/).length <= 4 ? thing : null;
};

/**
 * One observation, said the way a person would say it to the business.
 *
 * The catalogue writes reasons for the lead card: third person, present
 * evidence, then the analyst's inference after a dash ("— an active technology
 * initiative that often needs outside delivery capacity"). Quoted after
 * "I noticed", that inference is the most visible tell that a machine wrote
 * the email. This keeps the observation and the specific (the seconds, the
 * year, the role, the builder) and drops the reasoning, in the reader's own
 * "you/your". Returns `null` for a fact it cannot say well — the caller then
 * either falls back to the raw quote (for the hook, where something must be
 * said) or says nothing (for a supporting line, where silence beats prose).
 */
const describeObservation = (fact, company) => {
  const text = String(fact?.text || "");
  const kind = classifyObservation(text);
  const name = company?.name || "the business";
  const d = {};
  let line = null;

  switch (kind) {
    case "NO_WEBSITE":
      line = `${name} is listed online with contact details but no website at all`;
      break;
    case "NO_BOOKING":
      line = "appointments with you can only be booked by phone";
      break;
    case "NO_ORDERING":
      // A restaurant takes orders; a shop sells. The wording of the pain and
      // the value follow this flag too, so the whole email speaks one trade.
      d.food = /restaurant|cafe|café|coffee|bakery|pizza|food|kitchen|grill|diner|takeaway|bistro/i
        .test(`${company?.industry || ""} ${text}`);
      line = d.food
        ? "customers can't order from you online — it's walk-in or phone only"
        : "customers can't buy from you online — it's in person only";
      break;
    case "SLOW_SITE":
      d.seconds = firstNumber(text, /([\d.]+) ?s\b/);
      line = d.seconds ? `your home page takes ${d.seconds}s to load` : "your home page is slow to load";
      break;
    case "NO_MOBILE":
      line = /viewport|zoomed-out/i.test(text)
        ? "your site opens as a zoomed-out desktop page on a phone"
        : "your site is laid out for desktop and breaks on a phone";
      break;
    case "NO_HTTPS":
      line = "browsers mark your site “Not secure” because it's still on plain HTTP";
      break;
    case "OLD_COPYRIGHT":
      d.year = firstNumber(text, /\b((?:19|20)\d{2})\b/);
      line = d.year ? `your site's footer still says ${d.year}` : "your site's footer is years out of date";
      break;
    case "OUTDATED_CMS":
      d.software = softwareDetail(text);
      line = d.software ? `your site runs ${d.software}, which is well out of date` : "your site runs software that's out of date";
      break;
    case "NO_SCHEMA":
      line = "your site gives Google no structured data, so your hours and reviews can't show in results";
      break;
    case "NO_ANALYTICS":
      line = "there's no analytics on your site, so you can't see where visitors come from";
      break;
    case "AUTOMATION":
      line = "your site asks customers to phone or email for things that could happen on the page";
      break;
    case "NO_APP":
      line = "you sell online but have no app for repeat customers";
      break;
    case "NEW_DOMAIN": {
      const sub = /"([^"]+)" subdomain/.exec(text)?.[1];
      line = sub ? `a new “${sub}” part of your site went live recently` : "your domain only went live recently";
      break;
    }
    case "BUILDER":
      d.builder = /built on ([A-Z][\w.]+)/i.exec(text)?.[1] || null;
      line = d.builder ? `your site is built on ${d.builder}` : "your site is on a template builder";
      break;
    case "EXPANSION":
      line = "your site mentions a new location or opening";
      break;
    case "TECH_DEBT": {
      // "6.3.10." — the fact's own full stop must not ride along.
      const ver = /WordPress\s+(\d+(?:\.\d+)*)/i.exec(text)?.[1];
      line = /WooCommerce/i.test(text) ? "your store runs on WooCommerce"
        : /WordPress/i.test(text) ? `your site runs on WordPress${ver ? ` ${ver}` : ""}`
        : null;
      break;
    }
    case "HIRING": {
      const h = hiringDetail(text);
      Object.assign(d, h);
      if (h.title) line = `you're hiring ${aRole(h.title)}${h.location ? ` in ${h.location}` : ""}`;
      else if (h.count) line = `you have ${h.count} roles open right now`;
      else line = "you have positions open on your careers page";
      break;
    }
    default:
      line = null;
  }
  // A hook must fit on a phone screen as one paragraph; a scraped job title
  // can be a sentence on its own.
  if (line && line.split(/\s+/).length > PARAGRAPH_WORD_LIMIT - 2) line = null;
  return { kind, line, detail: d };
};

/**
 * Hook-specific subject and pain, so the email holds together as one thought.
 * Subjects are short, plain and lowercase — the shape of an email a colleague
 * sends, not a campaign. Anything without an entry falls back to the service
 * copy, which is only ever used when its own premise (no real web presence)
 * is what was observed.
 */
/**
 * Subjects take `(short, detail)`: the company's short name when one fits a
 * glanceable subject (else null), and whatever `describeObservation` pulled
 * out of the fact. A subject that names the business is opened noticeably
 * more often than a generic one, and it is what stops six hundred leads
 * sharing four subject lines. Arabic openers take `(name, detail)` for the
 * same reason — the year or the seconds belong in both halves.
 */
const HOOK_COPY = {
  NO_WEBSITE: {
    // The service copy's subject ("Customers can't find X online") is a pitch,
    // not a subject line — it announces a sales email before it is opened.
    subject: (short) => (short ? `finding ${short} online` : "finding you online"),
    pain: "people searching for a place like yours are finding competitors instead",
    value: "We build a fast, mobile-first site that turns those searches into calls. Most go live in 2-3 weeks",
    subjectAr: (short) => (short ? `ظهور ${short} في البحث` : "ظهوركم في البحث"),
    painAr: "من يبحث عن نشاط مثل نشاطكم يجد منافسيكم بدلاً منكم",
    valueAr: "نبني موقعاً سريعاً يعمل على الجوال ويحوّل عمليات البحث إلى اتصالات، وغالباً خلال ٢-٣ أسابيع",
    openerAr: (name) => `لاحظت أن بيانات ${name} التجارية منشورة لكن لا يوجد له موقع إلكتروني.`,
  },
  SLOW_SITE: {
    subject: (short) => (short ? `${short} page speed` : "your website speed"),
    pain: "most visitors give up on a slow page within a few seconds — they go back and tap the next result",
    value: "We rebuild the front end so pages open immediately, which is usually the cheapest enquiry increase available",
    valueAr: "نعيد بناء الواجهة لتفتح الصفحات فوراً، وهي غالباً أرخص طريقة لزيادة الاستفسارات",
    subjectAr: (short) => (short ? `سرعة موقع ${short}` : "سرعة موقعكم"),
    painAr: "أغلب الزوار يغادرون الصفحة البطيئة خلال ثوانٍ ويعودون لنتيجة البحث التالية",
    openerAr: (name, d) => (d?.seconds
      ? `لاحظت أن صفحتكم الرئيسية تستغرق نحو ${d.seconds} ثانية حتى تفتح.`
      : "لاحظت أن موقعكم يستغرق وقتاً طويلاً في التحميل."),
  },
  NO_BOOKING: {
    subject: (short) => (short ? `booking at ${short}` : "online bookings"),
    pain: "every booking that has to happen by phone is one you lose when the line is busy or it's after hours",
    value: "We add online booking that takes appointments around the clock, without changing how your front desk works",
    valueAr: "نضيف حجزاً أونلاين يستقبل المواعيد على مدار الساعة دون تغيير طريقة عمل الاستقبال",
    subjectAr: (short) => (short ? `الحجز في ${short} أونلاين` : "الحجز أونلاين"),
    painAr: "كل حجز يتم عبر الهاتف فقط هو حجز تخسره عندما يكون الخط مشغولاً أو بعد ساعات العمل",
    openerAr: () => "لاحظت أن الحجز لديكم لا يتم إلا عبر الهاتف.",
  },
  NO_ORDERING: {
    subject: (short, d) => (short ? `${d?.food ? "ordering" : "buying"} from ${short}` : d?.food ? "online ordering" : "buying online"),
    pain: (d) => (d?.food
      ? "every customer who wants to order at 10pm, or while your line is busy, goes to whoever takes orders online"
      : "every customer who wants to buy after hours, or while your line is busy, goes to whoever sells online"),
    value: (d) => (d?.food
      ? "We add online ordering that takes orders around the clock, without changing how the kitchen works"
      : "We add online sales that take orders around the clock, without changing how you work in the shop"),
    subjectAr: (short) => (short ? `الطلب من ${short} أونلاين` : "الطلب أونلاين"),
    painAr: "كل عميل يريد الطلب في وقت متأخر أو بينما خطكم مشغول يذهب لمن يبيع أونلاين",
    valueAr: "نضيف طلباً أونلاين يستقبل المبيعات على مدار الساعة دون تغيير طريقة عملكم في المحل",
    openerAr: () => "لاحظت أن عملاءكم لا يستطيعون الطلب أو الشراء منكم أونلاين.",
  },
  NO_MOBILE: {
    subject: (short) => (short ? `${short} on phones` : "your site on phones"),
    pain: "most visitors are on a phone, and a desktop-only page sends them straight back to the search results",
    value: "We rebuild the site mobile-first so the majority of your visitors can actually read and use it",
    valueAr: "نعيد بناء الموقع ليعمل على الجوال أولاً حتى يستطيع أغلب زوارك قراءته واستخدامه فعلاً",
    subjectAr: () => "موقعكم على الجوال",
    painAr: "أغلب زوارك يستخدمون الجوال، والصفحة غير المهيأة له تعيدهم مباشرة لنتائج البحث",
    openerAr: () => "لاحظت أن موقعكم لا يعمل بشكل جيد على الجوال.",
  },
  NO_HTTPS: {
    subject: (short) => (short ? `${short} security warning` : "your site security warning"),
    pain: "a “Not secure” warning is the first thing a new customer sees, and many close the tab right there",
    value: "We move the site to HTTPS and fix what the warning is hiding — usually a day's work",
    subjectAr: () => "تحذير الأمان في موقعكم",
    painAr: "تحذير «غير آمن» هو أول ما يراه العميل الجديد، وكثيرون يغلقون الصفحة عنده",
    valueAr: "ننقل الموقع إلى HTTPS ونعالج ما يخفيه التحذير، وغالباً خلال يوم عمل",
    openerAr: () => "لاحظت أن المتصفح يعرض تحذير «غير آمن» عند فتح موقعكم.",
  },
  OLD_COPYRIGHT: {
    subject: (short, d) => (short && d?.year ? `${short} site since ${d.year}` : "your site's footer"),
    pain: "a footer years out of date tells a visitor nobody is home, and they call the next result instead",
    value: "We refresh the site so it looks open for business and loads fast on a phone",
    subjectAr: () => "تحديث موقعكم",
    painAr: "تذييل الموقع القديم بسنوات يوحي للزائر أن لا أحد يتابع الموقع، فيتصل بالنتيجة التالية",
    valueAr: "نجدّد الموقع ليبدو نشطاً ويفتح بسرعة على الجوال",
    openerAr: (name, d) => (d?.year
      ? `لاحظت أن تذييل موقعكم ما زال يحمل سنة ${d.year}.`
      : "لاحظت أن موقعكم لم يُحدّث منذ سنوات."),
  },
  OUTDATED_CMS: {
    subject: (short) => (short ? `${short} site updates` : "your site updates"),
    pain: "software that far behind is the usual way small sites get hacked or quietly break",
    value: "We bring it up to date and keep it there, without changing how the site looks",
    subjectAr: () => "تحديثات موقعكم",
    painAr: "البرمجيات المتأخرة بهذا القدر هي الطريقة المعتادة لاختراق المواقع الصغيرة أو تعطلها بهدوء",
    valueAr: "نحدّث الموقع ونبقيه محدثاً دون تغيير شكله",
    openerAr: (name, d) => (d?.software
      ? `لاحظت أن موقعكم يعمل على ${d.software}، وهي نسخة قديمة.`
      : "لاحظت أن موقعكم يعمل على برمجيات قديمة."),
  },
  NO_SCHEMA: {
    subject: (short) => (short ? `${short} on Google` : "your Google listing"),
    pain: "without structured data Google can't show your hours, photos or reviews — competitors with richer listings get the click",
    value: "We mark the site up so Google can display your hours, ratings and location directly in the results",
    valueAr: "نضيف البيانات المنظمة ليعرض قوقل ساعات عملكم وتقييماتكم وموقعكم مباشرة في النتائج",
    subjectAr: (short) => (short ? `ظهور ${short} في قوقل` : "ظهوركم في قوقل"),
    painAr: "بدون البيانات المنظمة لا يعرض قوقل ساعات عملكم وتقييماتكم، فتذهب النقرة لمنافس يظهر بشكل أفضل",
    openerAr: () => "لاحظت أن ظهوركم في نتائج قوقل يمكن تحسينه بشكل ملموس.",
  },
  NO_ANALYTICS: {
    subject: (short) => (short ? `${short} site traffic` : "your site traffic"),
    pain: "without numbers you can't tell which of your marketing brings customers and which wastes money",
    value: "We set up measurement in a day, so every decision about the site has a number behind it",
    subjectAr: (short) => (short ? `زيارات موقع ${short}` : "زيارات موقعكم"),
    painAr: "بدون أرقام لا يمكنكم معرفة أي تسويق يجلب العملاء وأيه يهدر المال",
    valueAr: "نجهّز القياس خلال يوم، ليكون لكل قرار عن الموقع رقم يدعمه",
    openerAr: () => "لاحظت أن موقعكم لا يحتوي على أي أداة لقياس الزيارات.",
  },
  AUTOMATION: {
    subject: (short) => (short ? `enquiries at ${short}` : "your enquiries"),
    pain: "every one of those calls and emails is staff time, and the ones after hours go unanswered",
    value: "We put those steps on the site itself, so customers help themselves and your team gets the hours back",
    subjectAr: () => "استفساراتكم",
    painAr: "كل اتصال ورسالة من هذا النوع وقت موظف، وما يصل بعد الدوام يبقى بلا رد",
    valueAr: "ننقل هذه الخطوات إلى الموقع نفسه ليخدم العميل نفسه ويستعيد فريقكم ساعاته",
    openerAr: () => "لاحظت أن موقعكم يطلب من العملاء الاتصال أو المراسلة لأمور يمكن إنجازها على الصفحة.",
  },
  NO_APP: {
    subject: (short) => (short ? `a ${short} app` : "an app for regulars"),
    pain: "repeat customers have no two-tap way to reorder, so they drift to whoever is easiest",
    value: "We build a simple app that makes reordering effortless — repeat orders typically climb within weeks",
    subjectAr: () => "تطبيق لعملائكم الدائمين",
    painAr: "زبائنك الدائمون لا يملكون طريقة سهلة لإعادة الطلب فيتجهون لمن يسهّل عليهم",
    valueAr: "نبني تطبيقاً بسيطاً يجعل إعادة الطلب بلمستين، وعادة ترتفع الطلبات المتكررة خلال أسابيع",
    openerAr: () => "لاحظت أنكم تبيعون أونلاين لكن دون تطبيق لعملائكم الدائمين.",
  },
  NEW_DOMAIN: {
    subject: (short) => (short ? `${short} new site` : "your new site"),
    pain: "a new site is the cheapest moment to get speed, mobile and search right — before the content piles up",
    value: "We set the foundations so the site is fast and found from day one",
    subjectAr: () => "موقعكم الجديد",
    painAr: "الموقع الجديد هو أرخص لحظة لضبط السرعة والجوال والظهور في البحث قبل أن يتراكم المحتوى",
    valueAr: "نرسي الأساس ليكون الموقع سريعاً وظاهراً في البحث من اليوم الأول",
    openerAr: () => "لاحظت أن موقعكم انطلق حديثاً.",
  },
  BUILDER: {
    subject: (short, d) => (short && d?.builder ? `${short} on ${d.builder}` : "your website platform"),
    pain: "template builders are fine to start, but they cap speed, search ranking and custom features as you grow",
    value: "We move sites off template builders onto something you own, keeping everything that already works",
    valueAr: "ننقل الموقع من منصات القوالب إلى نظام تملكونه، مع الحفاظ على كل ما يعمل حالياً",
    subjectAr: () => "منصة موقعكم",
    painAr: "منصات القوالب الجاهزة مناسبة للبداية لكنها تحدّ من السرعة والظهور في البحث والميزات مع النمو",
    openerAr: (name, d) => (d?.builder
      ? `لاحظت أن موقعكم مبني على ${d.builder}.`
      : "لاحظت أن موقعكم مبني على منصة قوالب جاهزة."),
  },
  TECH_DEBT: {
    subject: (short) => (short ? `${short} website setup` : "your website setup"),
    pain: "as a site grows past its platform, the workarounds start costing real time and real sales",
    value: "We tidy what's underneath so the site stays fast and easy to change, without a rebuild",
    subjectAr: () => "البنية التقنية لموقعكم",
    painAr: "عندما يكبر الموقع على منصته تبدأ الحلول المؤقتة بأخذ وقت حقيقي ومبيعات حقيقية",
    valueAr: "نرتّب ما تحت الموقع ليبقى سريعاً وسهل التعديل دون إعادة بناء",
    openerAr: () => "لاحظت بعض النقاط التقنية في موقعكم يمكن تحسينها.",
  },
  HIRING: {
    subject: (short, d) => {
      const title = d?.title?.replace(/\s*\(.*?\)\s*/g, " ").trim();
      return title && title.split(/\s+/).length <= 3 ? `your ${title} hire` : "your hiring push";
    },
    pain: "growth like that usually strains the systems behind it, and hiring for it takes months",
    value: "We plug in as a delivery team that ships while you hire, then hand over cleanly",
    valueAr: "ننضم كفريق تطوير ينفّذ بينما توظفون، ثم نسلّم العمل بشكل منظم",
    subjectAr: () => "توسع فريقكم",
    painAr: "النمو بهذا الشكل يضغط عادة على الأنظمة خلف الكواليس، والتوظيف له يستغرق شهوراً",
    openerAr: (name, d) => (d?.title
      ? `لاحظت أنكم تعلنون حالياً عن وظيفة ${d.title}.`
      : "لاحظت أن لديكم وظائف شاغرة معلنة حالياً."),
  },
  EXPANSION: {
    subject: (short) => (short ? `${short}'s new location` : "your new location"),
    pain: "a new location multiplies everything the current setup already carries — bookings, orders, being found in a new area",
    value: "We get the online side ready before the doors open — found in the new area, bookings and orders working from day one",
    subjectAr: () => "فرعكم الجديد",
    painAr: "الفرع الجديد يضاعف كل ما يتحمله وضعكم الحالي — الحجوزات والطلبات والظهور في منطقة جديدة",
    valueAr: "نجهّز الجانب الرقمي قبل الافتتاح: الظهور في المنطقة الجديدة والحجوزات والطلبات تعمل من اليوم الأول",
    openerAr: () => "لاحظت أنكم في مرحلة توسع وافتتاح جديد.",
  },
  // A business we verified HAS a website but whose observation fits no
  // specific kind. The service copy's "can't find you online" premise would
  // be false here, so this generic-but-true pair takes over.
  HAS_SITE_DEFAULT: {
    subject: (short) => (short ? `${short} website` : "your website"),
    pain: "small technical gaps quietly cost enquiries every week, and most are quick to fix",
    value: "We fix the small things first, so the site brings enquiries in instead of losing them",
    subjectAr: () => "حضوركم الرقمي",
    painAr: "الثغرات التقنية الصغيرة تكلف استفسارات كل أسبوع، وأغلبها سريع الإصلاح",
    valueAr: "نبدأ بإصلاح الأشياء الصغيرة ليجلب الموقع الاستفسارات بدل أن يخسرها",
    openerAr: () => "لاحظت بعض النقاط في حضوركم الرقمي يمكن تحسينها بسرعة.",
  },
  DEFAULT: {
    subjectAr: () => "حضوركم الرقمي",
    openerAr: () => "لاحظت بعض النقاط في حضوركم الرقمي يمكن تحسينها بسرعة.",
  },
};

/** Copy entries may depend on what the observation extracted (`detail`). */
const resolveCopy = (entry, detail) => (typeof entry === "function" ? entry(detail) : entry);

/** Gulf markets where outreach should lead in Arabic even for Latin-named businesses. */
const ARABIC_MARKETS = new Set(["SA", "AE", "KW", "QA", "BH", "OM"]);

/**
 * One piece of our own work per service angle — the proof touch of the sequence.
 *
 * Deliberately one, not a list. A four-link portfolio dump reads as a brochure
 * and buries the single example that actually resembles the reader's problem;
 * matched social proof is what earns the reply. Every description here is a
 * plain statement of what was built, with no invented metrics — an
 * unsubstantiated "300% more leads" costs more trust than it buys.
 *
 * deventiatech.com is deliberately absent: it already appears in the signature
 * block on every message, so repeating it in the body spends a second link for
 * nothing. Links carry real deliverability cost, so each one has to earn itself.
 */
const PORTFOLIO = {
  HR_SOFTWARE: {
    url: "tracefyhr.com",
    what: "our own cloud HR system — employees, attendance, leave and payroll in one place, with live numbers for whoever is managing it",
    whatAr: "نظام موارد بشرية سحابي من تطويرنا — الموظفون والحضور والإجازات والرواتب في مكان واحد مع أرقام لحظية للإدارة",
  },
  CRM_DEV: {
    url: "isaconsulting.com",
    what: "a staffing and IT firm's site, plus the live admin dashboard our team still builds and runs for them",
    whatAr: "موقع شركة توظيف وتقنية معلومات، إضافة إلى لوحة التحكم التشغيلية التي يطوّرها فريقنا ويشغّلها لهم",
  },
  SAAS_DEV: {
    url: "isaworkbridge.com",
    what: "a recruitment and job placement platform, built end to end",
    whatAr: "منصة توظيف وتوطين وظائف، بُنيت من الصفر حتى التشغيل",
  },
  CUSTOM_SOFTWARE: {
    url: "isaworkbridge.com",
    what: "a recruitment and job placement platform we built end to end, then kept developing as they grew",
    whatAr: "منصة توظيف وتوظيف وظائف بنيناها بالكامل وواصلنا تطويرها مع نموّهم",
  },
  WEBSITE_DEV: {
    url: "isaconsulting.com",
    what: "a staffing and IT company's site, built so that being found and loading fast mattered more than anything decorative",
    whatAr: "موقع شركة توظيف وتقنية معلومات — بناء يهمّ فيه الظهور والسرعة أكثر من أي شيء شكلي",
  },
  MOBILE_APP: {
    url: "mynime.com",
    what: "a streaming and discovery platform that has to feel the same on a phone as it does on a desktop",
    whatAr: "منصة بث واستكشاف يجب أن تعمل على الجوال بنفس سلاسة الكمبيوتر",
  },
  ECOMMERCE_DEV: {
    url: "mynime.com",
    what: "a discovery platform where browsing a large catalogue has to stay fast on any screen — the same problem an online shop has",
    whatAr: "منصة استكشاف يبقى فيها تصفّح كتالوج كبير سريعاً على أي شاشة — وهي نفس مشكلة المتجر الإلكتروني",
  },
  AI_AUTOMATION: {
    url: "tracefyhr.com",
    what: "a cloud HR system where the attendance, leave and payroll reporting updates itself instead of being compiled by hand each month",
    whatAr: "نظام موارد بشرية سحابي تتحدّث فيه تقارير الحضور والإجازات والرواتب تلقائياً بدل تجميعها يدوياً كل شهر",
  },
};

const portfolioFor = (serviceKey) => PORTFOLIO[serviceKey] || PORTFOLIO.CUSTOM_SOFTWARE;

/**
 * The ask, varied by what was actually observed.
 *
 * One constant closing line across every email was the single most obvious tell
 * that these are generated: a recipient who saw two of them saw the template.
 * Each ask is still one question a one-word reply answers — that constraint is
 * what makes the sequence work — but it is phrased for the hook it follows, so
 * the last line reads as part of the same thought as the first.
 *
 * Keyed by observation kind, with an index chosen from the company name so the
 * same company always gets the same wording. Deliberately deterministic: a
 * regenerated draft that changes its closing line every time makes a sent
 * thread impossible to reconcile against what is on screen.
 */
/**
 * The readability ceilings, named rather than implicit.
 *
 * 70 words for the whole English body and 25 for any one paragraph: both are
 * enforced by tests, and both exist because these are read on a phone between
 * customers. They bound how much extra specificity an email can carry.
 */
const BODY_WORD_LIMIT = 70;
const PARAGRAPH_WORD_LIMIT = 25;

const CTA_BY_KIND = {
  NO_WEBSITE: ["Want me to sketch what a first page could cover? One word back is enough.", "Shall I send two examples of what this looks like for a business your size?"],
  SLOW_SITE: ["Want the two things slowing it down most? One word back is enough.", "Shall I send what the biggest delay is? A one-word reply is plenty."],
  NO_BOOKING: ["Want me to send how this works for a business like yours? One word is enough.", "Shall I send two ways this usually gets handled?"],
  NO_MOBILE: ["Want me to send what it looks like on a phone right now? One word back is enough.", "Shall I send the two fixes that matter most here?"],
  NO_SCHEMA: ["Want me to send what's missing from your listing? One word back is enough.", "Shall I send the short version of what Google is not seeing?"],
  BUILDER: ["Want me to send where that platform starts to cost you? One word is enough.", "Shall I send two things that get easier off it?"],
  TECH_DEBT: ["Want me to send the two I would fix first? One word back is enough.", "Shall I send a short list, specific to your site?"],
  NO_ORDERING: ["Want me to send how ordering would work for a place like yours? One word is enough.", "Shall I send two ways this usually gets set up?"],
  NO_HTTPS: ["Want me to send what's behind the warning? One word back is enough.", "Shall I send the short version of what needs changing?"],
  OLD_COPYRIGHT: ["Want me to send the three things I'd refresh first? One word is enough.", "Shall I send what a light refresh would cover?"],
  OUTDATED_CMS: ["Want me to send what's exposed right now? One word back is enough.", "Shall I send the short list of what needs updating?"],
  NO_ANALYTICS: ["Want me to send what you'd be able to see with it? One word is enough.", "Shall I send the two numbers worth tracking first?"],
  AUTOMATION: ["Want me to send which of those steps could move onto the site? One word is enough.", "Shall I send the two I'd automate first?"],
  NO_APP: ["Want me to send what a simple app would cover? One word is enough.", "Shall I send two examples from businesses your size?"],
  NEW_DOMAIN: ["Want me to send the three things worth getting right early? One word is enough.", "Shall I send what I'd set up first?"],
  HIRING: ["Want me to send how we usually cover a gap like this? One word is enough.", "Shall I send what the first month normally looks like?"],
  EXPANSION: ["Want me to send what usually needs doing at this stage? One word is enough.", "Shall I send two things worth setting up early?"],
  HAS_SITE_DEFAULT: ["Want me to send the two I would fix first? One word back is enough.", "Shall I send a short list, specific to your site?"],
  DEFAULT: ["Want me to send 2-3 specific ideas? One word back is enough.", "Shall I send a couple of specific ideas? A one-word reply is enough."],
};

const CTA_AR = [
  "هل أرسل لك ٢-٣ أفكار محددة؟ تكفي كلمة واحدة.",
  "هل أرسل لك ملاحظتين محددتين عن هذا؟ يكفي رد بكلمة واحدة.",
];

/**
 * The sentence that carries the observation into why it matters.
 *
 * "That matters: " opened this clause on 100% of emails and was a more visible
 * tell than the closing line, because it sits in the middle of the message
 * where the eye lands first.
 */
const PIVOTS = [
  (pain) => `That matters: ${pain}.`,
  (pain) => `Which means ${pain}.`,
  (pain) => `In practice ${pain}.`,
  (pain) => `The cost of that is simple — ${pain}.`,
];

/**
 * A stable index for this company, so the same lead always produces the same
 * wording. A hash rather than a counter: drafts are generated in batches, in
 * parallel, and across processes.
 */
const variantIndex = (seed, count) => {
  let hash = 0;
  for (let i = 0; i < String(seed || "").length; i += 1) {
    hash = (hash * 31 + String(seed).charCodeAt(i)) >>> 0;
  }
  return hash % count;
};

/**
 * A second observation, when there is one worth adding.
 *
 * The template used exactly one fact per email while `gatherFacts` routinely
 * supplies five to eight. One concrete detail reads as a mail merge; two read
 * as someone having actually looked. Skips anything already used, the identity
 * and address lines, and the audit-score line — which reads as a robot even
 * when it is true.
 */
/**
 * The next-strongest observation this file can say in plain words. Two rules
 * beyond "not the hook": never the same kind twice — "runs WordPress 6.3"
 * followed by "Also, built on WordPress 6.3" is the one line a reader is
 * certain a machine wrote — and never a fact with no human phrasing, because
 * a supporting line is optional and analyst prose is worse than silence.
 */
const pickSupporting = (facts, hookFact, hookKind, company) => {
  for (const f of rankedObservations(facts)) {
    if (f === hookFact) continue;
    const said = describeObservation(f, company);
    if (!said.line || said.kind === hookKind || said.kind === "TECH_DEBT" || said.kind === "DEFAULT") continue;
    return { fact: f, line: said.line };
  }
  return null;
};

/**
 * The opener when nothing but the identity line is known. Telling a business
 * what it is makes a terrible first sentence, so this says what the sender
 * was doing instead — true of every discovery run, and a claim about nobody.
 */
const identityOpener = (company) => {
  const trade = company.industry && company.industry !== "Technology employer"
    ? `${company.industry.toLowerCase()} businesses`
    : "companies in your space";
  return `${company.name} came up while I was looking at ${company.city ? `local businesses in ${company.city}` : trade}.`;
};

/** The initial pitch: hook → pain → value → tiny CTA, under ~80 words. */
export const initialTemplate = ({ company, facts, serviceKey, serviceLabel, recipient = null }) => {
  const copy = PITCH_COPY[serviceKey] || PITCH_COPY.CUSTOM_SOFTWARE;
  const observation = pickObservation(facts);
  const hasWebsite = factsShowWebsite(facts);
  const said = describeObservation(observation, company);
  let { kind } = said;
  // A lead with a verified website must never get the "can't find you online"
  // premise the generic service copy leads with.
  if (kind === "DEFAULT" && hasWebsite) kind = "HAS_SITE_DEFAULT";
  const hook = HOOK_COPY[kind] || HOOK_COPY.DEFAULT;

  /**
   * Last-resort quoting for a fact the humaniser has no phrasing for: keep a
   * leading company name's capital, and give a bare participle ("hiring X")
   * its subject back so the sentence has one.
   */
  const quote = (text) => {
    if (text.startsWith(company.name)) return text;
    const lowered = lowerFirst(text);
    return /^(?:currently |actively )?(?:hiring|recruiting|advertising|expanding|opening|running|using|serving)\b/.test(lowered)
      ? `you're ${lowered}`
      : lowered;
  };
  const opener = said.line
    ? `I noticed ${said.line}.`
    : observation === facts[0] ? identityOpener(company)
    : `I noticed ${quote(observation.text)}`;

  // Both halves must come from the same thought: a booking hook answered with a
  // "get found in search" promise reads as two templates stitched together.
  const pain = resolveCopy(hook.pain, said.detail) || copy.pain;
  const value = resolveCopy(hook.value, said.detail) || copy.value;
  // A first name when the business published one on its own site. `gatherFacts`
  // has always resolved this and the template simply never received it, so
  // every rule-generated email opened "Hello," at a company whose owner is
  // named on its own About page.
  const firstName = recipient?.firstName?.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";

  const seed = `${company.name || ""}${observation.id || ""}`;
  const ctaPool = CTA_BY_KIND[kind] || CTA_BY_KIND.DEFAULT;
  const cta = ctaPool[variantIndex(seed, ctaPool.length)];
  const pivot = PIVOTS[variantIndex(`${seed}p`, PIVOTS.length)];

  // A second observed detail, but only when the email can afford it. Two
  // concrete details read as someone having looked; one reads as a mail merge.
  // The 70-word ceiling wins over the extra detail every time though — a long
  // email on a phone is not read at all, so specificity gained by breaking the
  // ceiling would be specificity nobody sees.
  const candidate = pickSupporting(facts, observation, kind, company);
  const compose = (extra, askLine, pivotFn) => [
    greeting,
    opener,
    extra ? `Also, ${extra.line}.` : null,
    pivotFn(pain),
    `${value}.`,
    askLine,
    "Best regards",
  ].filter(Boolean).join("\n\n");

  const wordCount = (body) => body.trim().split(/\s+/).length;
  // Every paragraph is one line on a phone; a long "Also …" breaks that shape
  // regardless of what the total comes to.
  const extraFitsAlone = candidate
    && `Also, ${candidate.line}.`.split(/\s+/).length <= PARAGRAPH_WORD_LIMIT;

  // Give things up in order of what the reader loses least by losing: the
  // second observation first, then the varied ask, then the varied pivot. The
  // word ceiling is not negotiable — a long email on a phone is not read at
  // all, so specificity bought by breaking it is specificity nobody sees.
  const shortestCta = [...ctaPool].sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length)[0];
  const shortestPivot = PIVOTS[0];
  const attempts = [
    { extra: extraFitsAlone ? candidate : null, ask: cta, piv: pivot },
    { extra: null, ask: cta, piv: pivot },
    { extra: null, ask: shortestCta, piv: pivot },
    { extra: null, ask: shortestCta, piv: shortestPivot },
  ];
  const chosen =
    attempts.find((a) => wordCount(compose(a.extra, a.ask, a.piv)) <= BODY_WORD_LIMIT)
    || attempts[attempts.length - 1];

  const supporting = chosen.extra;
  const english = compose(chosen.extra, chosen.ask, chosen.piv);

  // An Arabic-named business — or any business in a Gulf market, whatever the
  // script of its name — gets the message in Arabic first, English below.
  // The Arabic opener is picked per observation kind so it never claims
  // something ("no online presence") the facts don't support.
  const bilingual = (ARABIC.test(company.name) || ARABIC_MARKETS.has(company.countryCode)) && copy.painAr;
  const arabic = bilingual
    ? [
        "مرحباً،",
        (hook.openerAr || HOOK_COPY.DEFAULT.openerAr)(company.name, said.detail),
        `${hook.painAr || copy.painAr}.`,
        `${hook.valueAr || copy.valueAr}.`,
        CTA_AR[variantIndex(`${company.name || ""}ar`, CTA_AR.length)],
        "مع التحية",
      ].join("\n\n")
    : null;

  // The subject names the business when its name fits a glance. The service
  // copy's subjects are pitches ("Customers can't find X online") and are no
  // longer used for a first email under any kind.
  const short = shortName(company.name);
  const subjectFn = hook.subject || ((s) => (s ? `${s} online` : "your online presence"));
  // An Arabic subject already spends words on its own frame ("ظهور … في
  // البحث"), so a Latin name only fits when it is one or two words.
  const shortAr = short && short.split(/\s+/).length <= 2 ? short : null;
  const subject = bilingual
    ? (hook.subjectAr || HOOK_COPY.DEFAULT.subjectAr)(shortAr, said.detail)
    : subjectFn(short, said.detail);

  return {
    aboutCompany: aboutFromFacts({ company, facts }),
    subject: subject.slice(0, 200),
    body: arabic ? `${arabic}\n\n———\n\n${english}` : english,
    factIdsUsed: [observation.id, supporting?.fact.id].filter(Boolean),
  };
};

/**
 * The capability sentence of a promoted-product email.
 *
 * Every phrasing is a statement about the product, never about the reader.
 * A colon rather than a dash on purpose: the text after it is whatever the
 * approved ICP or the pitch angle says, which is as often a fragment ("run HR
 * in 15 minutes a week") as a clause, and a colon carries a fragment where a
 * dash leaves it dangling mid-sentence.
 */
const CAPABILITY_FRAMES = [
  (name, capability) => `${name} is built for that part: ${capability}.`,
  (name, capability) => `That is the part ${name} handles: ${capability}.`,
  (name, capability) => `${name} does exactly that: ${capability}.`,
];

/**
 * The same sentence with nothing to point back at.
 *
 * Every frame above refers to "that part" — the pain named in the paragraph
 * before it. When there is no such paragraph, because the product has no
 * approved ICP or because the word ceiling took the line, "that" points at the
 * hook instead, and "TracefyHR does exactly that" under "I saw an HR Manager
 * role open" claims the product fills the vacancy.
 */
const CAPABILITY_WITHOUT_PAIN = [
  (name, capability) => `${name} may be worth a look here: ${capability}.`,
  (name, capability) => `One to know about is ${name}: ${capability}.`,
];

/**
 * The one thing an email may say about the product.
 *
 * Only the pitch angle, the name and the summary are allowed through — the
 * feature list and the proof points are not, because a template cannot judge
 * which of them answers the hook it just wrote. URLs are stripped: a link in a
 * cold first touch measurably costs deliverability, and a product's own copy is
 * the most likely place one hides.
 */
/** Products are often registered under their domain; the email says the name. */
const productDisplayName = (product) =>
  String(product?.name || "").trim().replace(/\.(com|net|org|io|co|ai|app|dev|sa)$/i, "");

/**
 * Remove anything link-shaped from a piece of product copy.
 *
 * Applied to the pitch angle and to the ICP's own pain and answer text, because
 * all three are pasted out of a product's marketing pages and all three end up
 * verbatim in a first email. A bare domain counts: "book a demo at tracefyhr.com"
 * carries the same deliverability cost as an href, and the copy tests match a
 * URL by its dot-TLD shape rather than by its scheme.
 */
const stripLinks = (text) =>
  String(text || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|app|dev|sa|ae)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();

const productAngle = (product) => {
  const cleaned = stripLinks(product?.pitchAngle || product?.summary || "");
  // A pitch angle that opens by naming the product would have the email say the
  // name twice in one sentence, which reads as a banner rather than a sentence.
  const name = productDisplayName(product);
  if (!name || !cleaned.toLowerCase().startsWith(name.toLowerCase())) return lowerFirst(cleaned);
  // Removing the name leaves a bare predicate ("puts payroll in one place"),
  // which needs a subject back or the sentence it lands in has none.
  const predicate = cleaned.slice(name.length).replace(/^[\s:—,-]+/, "");
  return `it ${lowerFirst(predicate)}`;
};

/**
 * How a workforce actually runs, per kind of organisation.
 *
 * This is the part of a promoted-product email that has to be right, and it is
 * the part that was missing. The version this replaces opened with whichever
 * fact scored highest — for a school that was "the site is built on Wix" — and
 * then pivoted to HR software: two unrelated thoughts in one message. Even with
 * a coherent hook it still knew nothing about how a school staffs itself, so
 * every recipient got the same sentence with the name changed.
 *
 * Each entry states how that kind of employer is organised, and nothing about
 * the reader. `plural` and `staff` build the line that introduces the pain,
 * `close` is the noun phrase the closing question asks about, `subject` anchors
 * the subject line, and `terms` are the words that mark an ICP pain as landing
 * for this kind of workforce.
 *
 * `keys` are catalogue keys from OSM_CATEGORIES rather than free invention: the
 * only organisations this product can discover are the ones in that lexicon, so
 * an entry for an industry outside it would be copy that never renders. Order
 * matters only for the `re` fallback, so the broad patterns ("shop", "agency")
 * sit below the specific ones they would otherwise swallow.
 */
const WORKFORCE_SHAPES = [
  {
    keys: ["school"],
    re: /school|academy|college|institute|education|tuition/,
    plural: "schools",
    staff: "term-time contracts and cover for absence",
    close: "the teaching and support staff",
    subject: "term-time staff",
    terms: ["leave", "absence", "cover", "contract", "term", "attendance", "onboard", "document", "record", "renewal", "holiday"],
  },
  {
    keys: ["childcare"],
    re: /nursery|nurseries|kindergarten|childcare|creche|crèche/,
    plural: "nurseries",
    staff: "shift cover and staff ratios",
    close: "the room staff",
    subject: "shift cover",
    terms: ["shift", "cover", "rota", "attendance", "ratio", "absence", "onboard", "document", "renewal", "certif"],
  },
  {
    keys: ["dentist", "doctor", "pharmacy", "veterinary", "optician"],
    re: /clinic|dental|dentist|doctor|medical|pharmac|veterinar|optic|healthcare/,
    plural: "clinics",
    staff: "long opening hours and part-time clinicians",
    close: "the rota",
    subject: "the clinic rota",
    terms: ["rota", "shift", "schedul", "attendance", "part-time", "overtime", "licen", "certif", "renewal", "leave"],
  },
  {
    keys: ["construction", "plumber", "electrician"],
    re: /construction|builder|building|plumb|electric|civil|\bmep\b/,
    plural: "contractors",
    staff: "site crews, timesheets and subcontractors",
    close: "the site crews",
    subject: "site crews",
    terms: ["timesheet", "overtime", "attendance", "site", "hour", "wage", "payroll", "contractor", "project", "cost"],
  },
  {
    keys: ["hotel"],
    re: /hotel|resort|guest house|hospitality|accommodation/,
    plural: "hotels",
    staff: "seasonal staff and split shifts",
    close: "the rota",
    subject: "seasonal rotas",
    terms: ["rota", "shift", "seasonal", "turnover", "attendance", "overtime", "schedul", "hourly", "onboard"],
  },
  {
    keys: ["salon", "spa", "gym"],
    re: /salon|hairdress|barber|beauty|\bspa\b|massage|\bgym\b|fitness/,
    plural: "salons and gyms",
    staff: "part-time and commission-paid staff",
    close: "the part-time staff",
    subject: "part-time hours",
    terms: ["commission", "part-time", "rota", "shift", "schedul", "attendance", "turnover", "hourly", "booking"],
  },
  {
    keys: ["cleaning", "logistics"],
    re: /clean|facilit|laundry|logistic|courier|freight|transport|warehouse|moving/,
    plural: "cleaning and logistics firms",
    staff: "shift patterns and high turnover",
    close: "the shift teams",
    subject: "shift teams",
    terms: ["turnover", "shift", "rota", "attendance", "hourly", "onboard", "timesheet", "schedul", "document", "site"],
  },
  {
    keys: ["real_estate", "insurance", "travel_agency", "marketing", "it_company", "lawyer", "accountant", "coworking", "company_office"],
    re: /estate|propert|insuranc|travel|\bmarketing\b|advertis|software|technolog|\blaw\b|legal|account|\btax\b|consult|agenc|coworking|staffing|recruit/,
    plural: "firms like this",
    staff: "salaried staff, commissions and freelancers",
    close: "the team",
    subject: "salaried staff",
    terms: ["payroll", "leave", "spreadsheet", "approval", "expense", "commission", "freelance", "contractor", "onboard", "remote"],
  },
  {
    keys: ["restaurant", "cafe", "fast_food", "bakery", "supermarket", "clothes", "jewelry", "florist", "furniture", "electronics", "hardware", "pet_shop", "car_dealer", "car_repair"],
    re: /restaurant|cafe|café|coffee|food|bakery|\bbar\b|\bpub\b|shop|store|retail|supermarket|grocer|showroom|garage|repair/,
    plural: "shops and restaurants",
    staff: "part-time hours and high turnover",
    close: "the rota",
    subject: "the rota",
    terms: ["rota", "shift", "part-time", "turnover", "hourly", "attendance", "schedul", "onboard", "overtime"],
  },
];

/**
 * Every catalogue key is mapped above, so this covers the leads whose Company
 * row carries no industry at all — the AI discoverer stores null rather than
 * guess, and guessing is exactly what it must not do here either. It says the
 * least it can and still be true of any employer.
 */
const DEFAULT_SHAPE = {
  keys: [],
  plural: "businesses like yours",
  staff: "a mix of salaried and hourly staff",
  close: "the team",
  subject: "staff admin",
  terms: ["payroll", "leave", "attendance", "spreadsheet", "approval", "onboard", "hour"],
};

/**
 * Catalogue label and OSM tag value → catalogue key, so a Company row written by
 * any of the ingest paths resolves to the same shape: Overpass stores the human
 * label ("School / academy") on `industry` and the raw tag ("amenity=school") on
 * `osmCategory`, while the AI discoverer stores the bare key ("school").
 */
const CATEGORY_KEY_BY_TERM = new Map([
  ...Object.keys(OSM_CATEGORIES).map((key) => [key, key]),
  ...Object.entries(OSM_CATEGORIES).map(([key, cat]) => [cat.label.toLowerCase(), key]),
  ...Object.entries(OSM_CATEGORIES).flatMap(([key, cat]) => cat.tags.map(([, value]) => [value, key])),
]);

const SHAPE_BY_KEY = new Map(WORKFORCE_SHAPES.flatMap((s) => s.keys.map((key) => [key, s])));

/** What kind of employer this is, decided before a word of the email is written. */
const workforceShape = (company, facts = []) => {
  const industry = String(company?.industry || "").trim().toLowerCase();
  const osm = String(company?.osmCategory || "").trim().toLowerCase();
  const exact = [industry, osm, osm.split("=").pop()]
    .map((term) => CATEGORY_KEY_BY_TERM.get(term))
    .find((key) => SHAPE_BY_KEY.has(key));
  if (exact) return SHAPE_BY_KEY.get(exact);

  const declared = `${industry} ${osm}`.trim();
  const byPattern = declared && WORKFORCE_SHAPES.find((s) => s.re.test(declared));
  if (byPattern) return byPattern;

  // Last resort, the identity fact: "X is a staffing agency in Dubai" carries an
  // industry for the leads whose Company row never got one. That fact only —
  // running the patterns over the whole list would let an advertised job title
  // decide what kind of employer this is, and a school hiring a driver is not a
  // logistics firm.
  const identity = String(facts[0]?.text || "").toLowerCase();
  return WORKFORCE_SHAPES.find((s) => s.re.test(identity)) || DEFAULT_SHAPE;
};

/**
 * Which of the approved pains to lead with.
 *
 * Only the user's own ICP is scored — never a pain this file invented — and the
 * scoring is deliberately crude: a point per workforce word the pain or its
 * answer contains, with ICP order as the tie-break, because whoever approved
 * that list put the pain they believed in first. The multiplier guarantees that
 * one extra workforce hit outranks any amount of position advantage.
 */
const choosePain = (product, shape) => {
  const pains = (Array.isArray(product?.icp?.painPoints) ? product.icp.painPoints : []).filter((p) => p?.pain);
  if (!pains.length) return null;
  return pains
    .map((p, index) => {
      const text = `${p.pain} ${p.productAnswer || ""}`.toLowerCase();
      const hits = shape.terms.filter((term) => text.includes(term)).length;
      return { p, rank: hits * pains.length + (pains.length - index) };
    })
    .sort((a, b) => b.rank - a.rank)[0].p;
};

/**
 * ICP pain and answer text is one line by convention and nothing enforces it.
 * A pain that runs past the paragraph ceiling is a paragraph nobody reads, and
 * its first clause carries the point — the elaboration after the dash does not.
 */
const firstClause = (text) => stripLinks(text).split(/\s+[—–]\s+|;\s*/)[0].replace(/\.$/, "").trim();

/**
 * `lowerFirst` on an initialism produces "hR data", which is worse than the
 * capital it was removing. ICP pains are written as sentences and get spliced
 * into the middle of one here, so they do need the lower-casing — but not at
 * that price.
 */
const asClause = (text) => (/^[A-Z]{2,}\b/.test(String(text || "")) ? String(text) : lowerFirst(String(text || "")));

/**
 * The noun the closing question can ask about, taken out of the chosen pain.
 *
 * "Payroll lives in spreadsheets" is a claim about the reader if it is stated
 * at them, but "how are you handling payroll?" is a question they can answer,
 * and answering it is the reply. Anything that does not reduce to a short noun
 * phrase returns null and the question falls back to referring to the pain
 * rather than naming it, because a mangled subject is worse than a vague one.
 */
const TOPIC_CUTS = /\s+(?:lives?|sits?|is|are|was|were|gets?|takes?|happens?|runs?|still|across|between|in|on|by|with|that|when|because|through|for)\s+|\s*[—–:,;]\s*/;
const TOPIC_LEAD = /^(?:the|a|an|managing|tracking|handling|chasing|running|doing)\s+/i;
const TOPIC_TRAILING_PARTICIPLE = /\s+(?:spread|scattered|stuck|buried|kept|stored|tracked|managed|handled|done|sitting|living)$/i;
// An absence ("no single view of who is on shift") makes no sense as the object
// of "how are you handling", and neither does a pronoun with nothing to refer to.
const TOPIC_REJECT = /^(?:no|not|nothing|there|it|they|we|too|hard|difficult)\b/i;
const painTopic = (pain) => {
  const parts = String(pain || "").split(TOPIC_CUTS);
  // A pain that never splits has no predicate to cut away, so its opening words
  // are not a noun phrase and were never meant to be read as one: "onboarding
  // documents go missing" survives every length and character check above and
  // still yields "how are you handling onboarding documents go missing".
  if (parts.length < 2) return null;
  const topic = asClause(parts[0].trim()).replace(TOPIC_LEAD, "").replace(TOPIC_TRAILING_PARTICIPLE, "").trim();
  const words = topic.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4 || TOPIC_REJECT.test(topic)) return null;
  return topic;
};

/**
 * "a Senior Backend Engineer", "an HR Manager".
 *
 * Two failures live in this one word. The catalogue supplies the article on
 * some reasons and not others, so adding one unconditionally gives "a a Senior
 * Engineer"; and the article follows sound rather than spelling, so "a HR
 * Manager" in the opening line of a cold email is the tell that a machine wrote
 * it — an initialism is read out letter by letter, and H is pronounced "aitch".
 */
const VOWEL_SOUND_INITIALS = /^[AEFHILMNORSX]/;
const aRole = (raw) => {
  const title = String(raw || "").trim().replace(/^(?:an?|the)\s+/i, "");
  const first = title.split(/\s+/)[0] || "";
  const initialism = /^[A-Z]{2,}$/.test(first.replace(/[^A-Za-z]/g, ""));
  const article = initialism
    ? (VOWEL_SOUND_INITIALS.test(first) ? "an" : "a")
    : (/^[aeiou]/i.test(first) ? "an" : "a");
  return `${article} ${title}`;
};

/**
 * The only facts allowed to open a promoted-product email, rewritten as the
 * reader would say them.
 *
 * Nothing else may open one. A website observation followed by an HR platform
 * is two unrelated thoughts, which is precisely what the user rejected: "I
 * noticed the site is built on Wix" sitting above a pitch for payroll software.
 * When none of these matches, the opener falls back to what the company is and
 * where — never to whichever fact happened to score highest.
 *
 * `arKind` names the HOOK_COPY entry whose Arabic opener says the same thing,
 * because the Arabic half only goes out when one does.
 */
const COMPANY_STATE_HOOKS = [
  {
    // gatherFacts writes job postings as "It is currently hiring: HR Manager."
    re: /^it is currently hiring:\s*(.+?)\.?$/i,
    arKind: "HIRING",
    line: (m, company) => `I saw ${aRole(m[1])} role open at ${company.name}.`,
  },
  {
    // The signal catalogue writes the same event as a bare participle carrying
    // its own explanation after a dash or comma — reasoning the lead card needs
    // and the reader of the email does not.
    re: /^currently hiring\s+(.+?)(?:\s*[,—–]\s.*)?$/i,
    arKind: "HIRING",
    line: (m) => `You're hiring ${aRole(m[1])} at the moment.`,
  },
  {
    re: /^(\d+)\s+roles are open right now/i,
    arKind: "HIRING",
    line: (m) => `You have ${m[1]} roles open right now.`,
  },
  {
    re: /careers page with open positions/i,
    arKind: "HIRING",
    line: () => "Your careers page has positions open at the moment.",
  },
  {
    // Hedged on purpose: the fact says the site mentions an expansion, which is
    // not the same as knowing one is happening.
    re: /mentions expansion|new location, branch or opening/i,
    arKind: "EXPANSION",
    line: () => "Looks like there is a new location or opening in the works.",
  },
];

const hookFromFacts = (company, facts) => {
  for (const fact of facts.slice(1)) {
    for (const hook of COMPANY_STATE_HOOKS) {
      const match = hook.re.exec(String(fact.text || "").trim());
      if (match) return { line: hook.line(match, company), arKind: hook.arKind, factId: fact.id };
    }
  }
  return null;
};

/**
 * The opener when the company shows no time-shaped state at all.
 *
 * Telling a business what it is makes a terrible opener, so this says what the
 * sender was doing instead — which is true of a discovery run, states nothing
 * about the reader, and gets to the point in one line.
 */
const IDENTITY_OPENERS = [
  (shape, company) => `${company.name} came up while I was looking at ${shape.plural}${company.city ? ` in ${company.city}` : ""}.`,
  (shape, company) => `I've been looking at ${shape.plural}${company.city ? ` in ${company.city}` : ""}, ${company.name} among them.`,
];

/**
 * The line that introduces the pain without ever asserting the reader has it.
 *
 * Both frames are statements about a category of employer, which is something
 * this file can know, and both end on the approved pain verbatim. "Your leave
 * process is manual and costing you time" would be an invention about a
 * stranger; "most schools end up in the same place" is an observation about
 * schools that leaves the reader free to disagree.
 */
const PAIN_FRAMES = [
  (shape, pain) => `Between ${shape.staff}, most ${shape.plural} end up in the same place: ${pain}.`,
  (shape, pain) => `With ${shape.staff} to keep straight, most ${shape.plural} land in the same place — ${pain}.`,
];

/** The same statement with the workforce clause given up, for a long pain. */
const SHORT_PAIN_FRAMES = [
  (shape, pain) => `Most ${shape.plural} end up in the same place: ${pain}.`,
  (shape, pain) => `Most ${shape.plural} know this one — ${pain}.`,
];

/**
 * The ask — a question about how their organisation runs, not a request.
 *
 * A question is the strongest close available here because answering it is the
 * reply: there is no meeting to accept and no link to click, just one thing the
 * reader already knows the answer to. It also stays honest, since asking how
 * something is handled asserts nothing about how it is handled.
 */
const CLOSE_FRAMES = [
  (shape, topic) => `How are you handling ${topic} across ${shape.close} at the moment?`,
  (shape, topic) => `Who picks up ${topic} across ${shape.close} right now?`,
  (shape, topic) => `Out of interest, how does ${topic} work across ${shape.close} today?`,
];

/** The same question when the pain does not reduce to a nameable topic. */
const CLOSE_WITHOUT_TOPIC = [
  (shape) => `How is that handled across ${shape.close} at the moment?`,
  (shape) => `Who looks after that across ${shape.close} right now?`,
  (shape) => `Is that roughly how it runs across ${shape.close} today?`,
];

const paragraphFits = (line) => Boolean(line) && line.trim().split(/\s+/).length <= PARAGRAPH_WORD_LIMIT;

/** The best-phrased line the phone-width ceiling allows, or the shortest one. */
const firstThatFits = (lines) =>
  lines.find(paragraphFits) || [...lines].sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length)[0];

/**
 * The initial pitch for a promoted product.
 *
 * It reasons about the business before it composes: what kind of employer this
 * is, how that kind of employer staffs itself, and which of the user's approved
 * pains lands on that shape. Only then does the product get a sentence, and it
 * gets exactly one — the answer the ICP itself paired with the chosen pain.
 *
 * The rule that separates the two halves is absolute and is why this file
 * exists: the hook may only say what a fact says, the pain line may only say
 * what the approved ICP says about that category of employer, and neither may
 * claim anything about this reader. "Your payroll takes too long" is an
 * invention about a stranger even when it is true.
 */
export const productInitialTemplate = ({ company, facts = [], product, recipient = null }) => {
  const shape = workforceShape(company, facts);
  const name = productDisplayName(product);
  const angle = productAngle(product) || `what ${name} does`;

  const chosen = choosePain(product, shape);
  const pain = chosen ? asClause(firstClause(chosen.pain)) : null;
  // The capability answers the pain the approved ICP paired it with, so the two
  // halves of the email answer each other. The pitch angle stands in only when
  // there is no ICP at all — a product researched but never profiled.
  const capability = chosen?.productAnswer ? asClause(firstClause(chosen.productAnswer)) : angle;
  const topic = painTopic(pain);

  // A job title long enough to break the phone-width ceiling costs the whole
  // hook rather than the shape of the email: nothing downstream can wrap a
  // paragraph, and a scraped title is occasionally a sentence.
  const found = hookFromFacts(company, facts);
  const hook = found && paragraphFits(found.line) ? found : null;
  const firstName = recipient?.firstName?.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";

  // Stable per lead and per product: drafts are regenerated in batches and a
  // wording that changes between runs makes a sent thread impossible to
  // reconcile against what is on screen.
  const seed = `${company.name || ""}${hook?.factId || ""}${name}`;
  const opener = hook
    ? hook.line
    : IDENTITY_OPENERS[variantIndex(`${seed}o`, IDENTITY_OPENERS.length)](shape, company);

  const closePool = topic ? CLOSE_FRAMES : CLOSE_WITHOUT_TOPIC;
  const closeLine = firstThatFits(
    [closePool[variantIndex(`${seed}k`, closePool.length)], ...closePool].map((frame) => frame(shape, topic)),
  );
  // Which set the capability sentence comes from depends on whether the pain
  // paragraph survived, because every frame in the first set points back at it.
  const capabilityLine = (painLine) => {
    const pool = painLine ? CAPABILITY_FRAMES : CAPABILITY_WITHOUT_PAIN;
    const ordered = [pool[variantIndex(`${seed}c`, pool.length)], ...pool];
    // An ICP answer pasted out of a feature page can be a paragraph on its own,
    // and then no choice of frame brings it under the ceiling. The pitch angle
    // is the shorter thing the product says about itself.
    return firstThatFits([
      ...ordered.map((frame) => frame(name, capability)),
      ...(capability === angle ? [] : ordered.map((frame) => frame(name, angle))),
    ]);
  };

  const compose = (painLine) =>
    [greeting, opener, painLine, capabilityLine(painLine), closeLine, "Best regards"].filter(Boolean).join("\n\n");

  const wordCount = (body) => body.trim().split(/\s+/).length;
  // Give up the workforce clause before the pain line, and the pain line before
  // anything else: the capability and the question are what the email is for,
  // and the 70-word ceiling is not negotiable — these are read on a phone.
  const painLines = pain
    ? [PAIN_FRAMES[variantIndex(`${seed}p`, PAIN_FRAMES.length)], ...SHORT_PAIN_FRAMES]
        .map((frame) => frame(shape, pain))
        .filter(paragraphFits)
    : [];
  const english =
    [...painLines, null].map(compose).find((body) => wordCount(body) <= BODY_WORD_LIMIT) || compose(null);

  // Arabic first for a Gulf market, but only behind a company-state hook. The
  // website-shaped Arabic openers promise a digital-presence conversation this
  // email is not going to have, so those leads get the English message alone
  // rather than an Arabic sentence that sets up the wrong subject.
  // Deliberately English-only, unlike the agency template above.
  //
  // Everything specific in a promote email — the workforce line, the pain and
  // the capability that answers it — is assembled from the product profile and
  // the approved ICP, and both of those are the operator's own English prose.
  // The Arabic half could therefore only ever be a generic opener wrapped
  // around an untranslated English sentence, which is a worse email than the
  // English one on its own: it reads as a mail-merge to anyone who speaks
  // either language. The agency template keeps its bilingual form because its
  // copy is written in both languages up front. This one earns it back the day
  // a product carries Arabic pitch copy, and not before.

  // The subject names the reader's own situation rather than the product
  // category. "HR management software" tells an inbox it is looking at an
  // advert; "payroll across site crews" tells it someone has thought about this
  // particular business. The staff the closing question asks about is what the
  // topic sits across, so the two agree; when that runs past a glanceable five
  // words it drops to the workforce anchor on its own.
  const withTopic = topic ? `${topic} across ${shape.close}` : null;
  const englishSubject = withTopic && withTopic.split(/\s+/).length <= 5 ? withTopic : shape.subject;
  const subject = englishSubject;

  return {
    aboutCompany: aboutFromFacts({ company, facts }),
    subject: String(subject).slice(0, 200),
    body: english,
    // The identity fact is what the industry-and-city opener is built from, so
    // it is cited exactly when that opener is the one used. The grounding guard
    // reads this list, and a claim traced to a fact nobody used is not traced.
    factIdsUsed: [hook ? hook.factId : facts[0]?.id].filter((id) => id !== null && id !== undefined),
  };
};

/**
 * Follow-ups when a thread has had no reply. Deliberately shorter each time;
 * the second is also the last.
 */
/**
 * The chat form of a follow-up: one short paragraph, no salutation, no sign-off
 * block. An email-shaped message in a WhatsApp bubble reads as a broadcast and
 * gets blocked, so this is deliberately not the same copy as the email chase.
 */
/**
 * A second observation the initial email did not lead with — the "new value"
 * a follow-up needs. "Just checking in" chases measurably depress replies;
 * a fresh concrete detail gives the reader a reason to answer this time.
 */
const secondObservation = (facts = [], company = {}) => {
  const first = pickObservation(facts);
  const firstKind = first ? classifyObservation(first.text) : "DEFAULT";
  for (const f of rankedObservations(facts)) {
    if (f === first) continue;
    const said = describeObservation(f, company);
    // Same rules as the opener's supporting line: a new kind of thing, said in
    // plain words, or nothing — a chase that quotes analyst prose is worse
    // than a chase with no new detail.
    if (said.line && said.kind !== firstKind && said.kind !== "DEFAULT") return { fact: f, line: said.line };
  }
  return null;
};

export const whatsappFollowUpTemplate = ({ company, serviceLabel, serviceKey, followUpNumber, facts = [] }) => {
  if (followUpNumber === 2) {
    const work = portfolioFor(serviceKey);
    return {
      body:
        `Closest thing we've built to what ${company.name} needs: ${work.url} — ${work.what}. `
        + `Happy to explain how the same approach would apply here, if that's useful.`,
    };
  }
  if (followUpNumber <= 1) {
    const second = secondObservation(facts, company);
    const extra = second
      ? `One more thing I spotted: ${second.line}. `
      : `I've noted a couple of quick wins specific to ${company.name}. `;
    return {
      body:
        extra
        + `Happy to share them here — takes one reply. If it's not relevant, no problem at all.`,
    };
  }
  return {
    body:
      `Last note from me — I won't keep messaging. `
      + `If ${serviceLabel} for ${company.name} ever becomes useful, just reply here and it'll reach me.`,
  };
};

export const followUpTemplate = ({ company, serviceLabel, serviceKey, followUpNumber, facts = [] }) => {
  const bilingual = ARABIC.test(company.name) || ARABIC_MARKETS.has(company.countryCode);

  // ── Chase 1: a second observation ──
  // A new concrete detail, never "just checking in" — that phrase measurably
  // depresses replies because it gives the reader no reason to answer.
  if (followUpNumber <= 1) {
    const second = secondObservation(facts, company);
    return {
      body: [
        "Hello,",
        second
          ? `One more thing I noticed while looking at ${company.name}: ${second.line}.`
          : `Since my last note I've written down the two or three things I would change first at ${company.name} — specific ones, not a generic checklist.`,
        `Happy to send the short list over — a one-word reply is enough. And if the timing is wrong, "not now" is a completely fine answer.`,
        "Best regards",
      ].join("\n\n"),
    };
  }

  // ── Chase 2: proof ──
  // The first message in the sequence that may carry a link. Cold first-touch
  // links measurably hurt deliverability, so the proof waits until the address
  // has taken two messages without bouncing or complaining — by which point a
  // link costs little and is the one thing that answers "who are you?".
  //
  // One matched example, not the full portfolio: the reader should recognise
  // their own problem in it. Still no meeting request — the ask stays a
  // one-word reply until they have shown interest.
  if (followUpNumber === 2) {
    const work = portfolioFor(serviceKey);

    const english = [
      "Hello,",
      `Rather than describe what we do, here is the closest thing we have built to what ${company.name} needs:`,
      `${work.url} — ${work.what}.`,
      `If that shape is useful, I'll map the same approach to ${company.name} in a few lines. A one-word reply is enough.`,
      "Best regards",
    ].join("\n\n");

    if (!bilingual) return { body: english };

    const arabic = [
      "مرحباً،",
      `بدل الحديث عن خدماتنا، هذا أقرب مشروع بنيناه لما يحتاجه ${company.name}:`,
      `${work.url} — ${work.whatAr}.`,
      `إن كانت الفكرة مناسبة، سأرسل كيف نطبّق نفس الأسلوب على ${company.name} في أسطر قليلة. يكفي رد بكلمة واحدة.`,
      "مع التحية",
    ].join("\n\n");

    return { body: `${arabic}\n\n———\n\n${english}` };
  }

  // ── Chase 3: the breakup ──
  // Loss aversion, and a promise we keep: nothing is sent after this.
  return {
    body: [
      "Hello,",
      `Last note from me — I don't want to clutter your inbox.`,
      `If it's ever useful to talk about ${serviceLabel} for ${company.name}, just reply to this thread and it will reach me. All the best either way.`,
      "Best regards",
    ].join("\n\n"),
  };
};

/**
 * The chat form of a first touch. Same discipline as the follow-up version:
 * one short paragraph, one concrete observation, a permission-shaped close.
 * Long pitches and link lists in a first WhatsApp message read as broadcast
 * spam and get the sender reported.
 */
export const whatsappInitialTemplate = ({ company, facts = [], serviceLabel }) => {
  const observation = pickObservation(facts);
  const said = observation ? describeObservation(observation, company) : { line: null };
  const hook = said.line
    ? ` — I noticed ${said.line}`
    : observation?.text
      ? ` — I noticed ${lowerFirst(observation.text).replace(/\.$/, "")}`
      : "";
  return {
    body:
      `Hello! Quick note about ${company.name}${hook}. `
      + `We help businesses with ${serviceLabel}, and I think there's a quick win here. `
      + `Would it be okay to share a short idea?`,
    factIdsUsed: [observation?.id].filter(Boolean),
  };
};
