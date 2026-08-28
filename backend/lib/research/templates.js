import { SERVICE_PITCH } from "../scoring/recommend.js";

/**
 * Deterministic email templates — the guaranteed-good fallback when no AI
 * provider is available, and the only author of follow-ups when AI is down.
 *
 * Rules the templates share with the AI path:
 *  - every specific claim comes from a gathered fact, never invention;
 *  - plain URLs only, no markdown;
 *  - short, peer-to-peer, one observation → one value line → one soft question.
 */

/** Facts that read badly when quoted in an email opener. */
const OPENER_BLOCKLIST = /technical audit|scores \d+\/100/i;

/**
 * Pick the strongest quotable observation from the fact list.
 *
 * The first fact is always the identity line ("X is a restaurant in Jeddah") —
 * telling a company what it is makes a terrible opener, so it is only the last
 * resort. Signal reasons ("listed with contact details but no website at all")
 * are the real hooks and come first.
 */
export const pickObservation = (facts) => {
  const identity = facts[0];
  const usable = facts.filter(
    (f) => f !== identity && !OPENER_BLOCKLIST.test(f.text) && !/^Its website is|^Its address is/.test(f.text),
  );
  return usable.find((f) => f.confidenceLevel !== "VERIFIED") || usable[0] || identity;
};

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
  { kind: "NO_BOOKING", re: /no online (?:booking|ordering)|reservation costs|booking.*phone/i },
  { kind: "NO_MOBILE", re: /viewport|zoomed-out desktop|not mobile/i },
  { kind: "NO_SCHEMA", re: /schema\.org|rich search|map panels/i },
  { kind: "BUILDER", re: /built on (?:Wix|Squarespace|GoDaddy|Weebly)|template builder/i },
  { kind: "EXPANSION", re: /expansion|new location|branch or opening|new branch/i },
  { kind: "TECH_DEBT", re: /built on|outgrow|custom functionality|integrations|WordPress|WooCommerce/i },
  { kind: "HIRING", re: /currently hiring|careers page|open positions/i },
];

/** A load time only counts as slow when it actually is; 1.6s is not a pitch. */
const SLOW_THRESHOLD_S = 2.5;

const classifyObservation = (text) => {
  const kind = OBSERVATION_KINDS.find((k) => k.re.test(text || ""))?.kind || "DEFAULT";
  if (kind === "SLOW_SITE") {
    const seconds = Number(/([\d.]+) ?s/.exec(text)?.[1] || 0);
    if (seconds > 0 && seconds < SLOW_THRESHOLD_S) return "DEFAULT";
  }
  return kind;
};

/**
 * Hook-specific subject and pain, so the email holds together as one thought.
 * Subjects are short, plain and lowercase — the shape of an email a colleague
 * sends, not a campaign. Anything without an entry falls back to the service
 * copy, which is only ever used when its own premise (no real web presence)
 * is what was observed.
 */
const HOOK_COPY = {
  NO_WEBSITE: {
    // The service copy's subject ("Customers can't find X online") is a pitch,
    // not a subject line — it announces a sales email before it is opened.
    subject: () => "finding you online",
    pain: "people searching for a place like yours are finding competitors instead",
    value: "We build a fast, mobile-first site that turns those searches into calls. Most go live in 2-3 weeks",
    subjectAr: () => "ظهوركم في البحث",
    painAr: "من يبحث عن نشاط مثل نشاطكم يجد منافسيكم بدلاً منكم",
    valueAr: "نبني موقعاً سريعاً يعمل على الجوال ويحوّل عمليات البحث إلى اتصالات، وغالباً خلال ٢-٣ أسابيع",
    openerAr: (name) => `لاحظت أن بيانات ${name} التجارية منشورة لكن لا يوجد له موقع إلكتروني.`,
  },
  SLOW_SITE: {
    subject: () => "your website speed",
    pain: "most visitors give up on a slow page within a few seconds — they go back and tap the next result",
    value: "We rebuild the front end so pages open immediately, which is usually the cheapest enquiry increase available",
    valueAr: "نعيد بناء الواجهة لتفتح الصفحات فوراً، وهي غالباً أرخص طريقة لزيادة الاستفسارات",
    subjectAr: () => "سرعة موقعكم",
    painAr: "أغلب الزوار يغادرون الصفحة البطيئة خلال ثوانٍ ويعودون لنتيجة البحث التالية",
    openerAr: () => "لاحظت أن موقعكم يستغرق وقتاً طويلاً في التحميل.",
  },
  NO_BOOKING: {
    subject: () => "online bookings",
    pain: "every booking that has to happen by phone is one you lose when the line is busy or it's after hours",
    value: "We add online booking that takes appointments around the clock, without changing how your front desk works",
    valueAr: "نضيف حجزاً أونلاين يستقبل المواعيد على مدار الساعة دون تغيير طريقة عمل الاستقبال",
    subjectAr: () => "الحجز أونلاين",
    painAr: "كل حجز يتم عبر الهاتف فقط هو حجز تخسره عندما يكون الخط مشغولاً أو بعد ساعات العمل",
    openerAr: () => "لاحظت أن الحجز أو الطلب لديكم لا يتم أونلاين.",
  },
  NO_MOBILE: {
    subject: () => "your site on phones",
    pain: "most visitors are on a phone, and a desktop-only page sends them straight back to the search results",
    value: "We rebuild the site mobile-first so the majority of your visitors can actually read and use it",
    valueAr: "نعيد بناء الموقع ليعمل على الجوال أولاً حتى يستطيع أغلب زوارك قراءته واستخدامه فعلاً",
    subjectAr: () => "موقعكم على الجوال",
    painAr: "أغلب زوارك يستخدمون الجوال، والصفحة غير المهيأة له تعيدهم مباشرة لنتائج البحث",
    openerAr: () => "لاحظت أن موقعكم لا يعمل بشكل جيد على الجوال.",
  },
  NO_SCHEMA: {
    subject: () => "your Google listing",
    pain: "without structured data Google can't show your hours, photos or reviews — competitors with richer listings get the click",
    value: "We mark the site up so Google can display your hours, ratings and location directly in the results",
    valueAr: "نضيف البيانات المنظمة ليعرض قوقل ساعات عملكم وتقييماتكم وموقعكم مباشرة في النتائج",
    subjectAr: () => "ظهوركم في قوقل",
    painAr: "بدون البيانات المنظمة لا يعرض قوقل ساعات عملكم وتقييماتكم، فتذهب النقرة لمنافس يظهر بشكل أفضل",
    openerAr: () => "لاحظت أن ظهوركم في نتائج قوقل يمكن تحسينه بشكل ملموس.",
  },
  BUILDER: {
    subject: () => "your website platform",
    pain: "template builders are fine to start, but they cap speed, search ranking and custom features as you grow",
    value: "We move sites off template builders onto something you own, keeping everything that already works",
    valueAr: "ننقل الموقع من منصات القوالب إلى نظام تملكونه، مع الحفاظ على كل ما يعمل حالياً",
    subjectAr: () => "منصة موقعكم",
    painAr: "منصات القوالب الجاهزة مناسبة للبداية لكنها تحدّ من السرعة والظهور في البحث والميزات مع النمو",
    openerAr: () => "لاحظت أن موقعكم مبني على منصة قوالب جاهزة.",
  },
  TECH_DEBT: {
    subject: () => "your website setup",
    pain: "as a site grows past its platform, the workarounds start costing real time and real sales",
    subjectAr: () => "البنية التقنية لموقعكم",
    painAr: "عندما يكبر الموقع على منصته تبدأ الحلول المؤقتة بأخذ وقت حقيقي ومبيعات حقيقية",
    openerAr: () => "لاحظت بعض النقاط التقنية في موقعكم يمكن تحسينها.",
  },
  HIRING: {
    subject: () => "your hiring push",
    pain: "growth like that usually strains the systems behind it, and hiring for it takes months",
    value: "We plug in as a delivery team that ships while you hire, then hand over cleanly",
    valueAr: "ننضم كفريق تطوير ينفّذ بينما توظفون، ثم نسلّم العمل بشكل منظم",
    subjectAr: () => "توسع فريقكم",
    painAr: "النمو بهذا الشكل يضغط عادة على الأنظمة خلف الكواليس، والتوظيف له يستغرق شهوراً",
    openerAr: () => "لاحظت أن لديكم وظائف شاغرة معلنة حالياً.",
  },
  EXPANSION: {
    subject: () => "your new location",
    pain: "a new location multiplies everything the current setup already carries — bookings, orders, being found in a new area",
    subjectAr: () => "فرعكم الجديد",
    painAr: "الفرع الجديد يضاعف كل ما يتحمله وضعكم الحالي — الحجوزات والطلبات والظهور في منطقة جديدة",
    openerAr: () => "لاحظت أنكم في مرحلة توسع وافتتاح جديد.",
  },
  // A business we verified HAS a website but whose observation fits no
  // specific kind. The service copy's "can't find you online" premise would
  // be false here, so this generic-but-true pair takes over.
  HAS_SITE_DEFAULT: {
    subject: () => "your online presence",
    pain: "small technical gaps quietly cost enquiries every week, and most are quick to fix",
    subjectAr: () => "حضوركم الرقمي",
    painAr: "الثغرات التقنية الصغيرة تكلف استفسارات كل أسبوع، وأغلبها سريع الإصلاح",
    openerAr: () => "لاحظت بعض النقاط في حضوركم الرقمي يمكن تحسينها بسرعة.",
  },
  DEFAULT: {
    openerAr: () => "لاحظت بعض النقاط في حضوركم الرقمي يمكن تحسينها بسرعة.",
  },
};

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
const pickSupporting = (facts, usedId) => {
  const candidate = facts.find((f) =>
    f.id !== usedId
    && !/^Its address is|^Its website is/.test(f.text)
    && !OPENER_BLOCKLIST.test(f.text)
    && !/ is a | is an /.test(f.text.slice(0, 60)),
  );
  return candidate || null;
};

/** The initial pitch: hook → pain → value → tiny CTA, under ~80 words. */
export const initialTemplate = ({ company, facts, serviceKey, serviceLabel, recipient = null }) => {
  const copy = PITCH_COPY[serviceKey] || PITCH_COPY.CUSTOM_SOFTWARE;
  const observation = pickObservation(facts);
  const hasWebsite = facts.some((f) => /^Its website is /.test(f.text));
  let kind = classifyObservation(observation.text);
  // A lead with a verified website must never get the "can't find you online"
  // premise the generic service copy leads with.
  if (kind === "DEFAULT" && hasWebsite) kind = "HAS_SITE_DEFAULT";
  const hook = HOOK_COPY[kind] || HOOK_COPY.DEFAULT;

  // A fact that opens with the company's own name must keep its capital.
  /**
   * Fit an observation into "I noticed …" so it reads as a sentence.
   *
   * The signal catalogue writes reasons as standalone lines — "Currently hiring
   * a Senior ML Engineer", "The home page took 4.2s to respond" — which is
   * right for the lead card but produces "I noticed currently hiring a Senior
   * ML Engineer" once lower-cased into the email. A reason that opens with a
   * bare participle needs its subject restored, and since the email addresses
   * the company as "you", that subject is "you are".
   */
  const quote = (text) => {
    if (text.startsWith(company.name)) return text;
    const lowered = lowerFirst(text);
    return /^(?:currently |actively )?(?:hiring|recruiting|advertising|expanding|opening|running|using|serving)\b/.test(lowered)
      ? `you're ${lowered}`
      : lowered;
  };

  // Both halves must come from the same thought: a booking hook answered with a
  // "get found in search" promise reads as two templates stitched together.
  const pain = hook.pain || copy.pain;
  const value = hook.value || copy.value;
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
  const candidate = pickSupporting(facts, observation.id);
  const compose = (extra, askLine, pivotFn) => [
    greeting,
    `I noticed ${quote(observation.text)}`,
    extra ? `Also ${lowerFirst(extra.text)}` : null,
    pivotFn(pain),
    `${value}.`,
    askLine,
    "Best regards",
  ].filter(Boolean).join("\n\n");

  const wordCount = (body) => body.trim().split(/\s+/).length;
  // Every paragraph is one line on a phone; a long "Also …" breaks that shape
  // regardless of what the total comes to.
  const extraFitsAlone = candidate
    && `Also ${lowerFirst(candidate.text)}`.split(/\s+/).length <= PARAGRAPH_WORD_LIMIT;

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
        (hook.openerAr || HOOK_COPY.DEFAULT.openerAr)(company.name),
        `${hook.painAr || copy.painAr}.`,
        `${hook.valueAr || copy.valueAr}.`,
        CTA_AR[variantIndex(`${company.name || ""}ar`, CTA_AR.length)],
        "مع التحية",
      ].join("\n\n")
    : null;

  const subject = bilingual
    ? (hook.subjectAr || copy.subjectAr || copy.subject)(company.name)
    : (hook.subject || copy.subject)(company.name);

  return {
    aboutCompany: aboutFromFacts({ company, facts }),
    subject: subject.slice(0, 200),
    body: arabic ? `${arabic}\n\n———\n\n${english}` : english,
    factIdsUsed: [observation.id, supporting?.id].filter(Boolean),
  };
};

/**
 * The value sentence of a promoted-product email, varied the same deterministic
 * way the ask and the pivot are.
 *
 * Every phrasing is a statement about the product or about companies in
 * general, never about the reader. "That is where X helps" follows their own
 * observed fact without claiming they have a problem; "your payroll is a mess"
 * would be an invention, and inventions are what this whole file exists to
 * prevent.
 */
const PRODUCT_VALUE = [
  (name, angle) => `Companies at that stage often end up looking at ${name} — ${angle}.`,
  (name, angle) => `That is usually where ${name} earns its place: ${angle}.`,
  (name, angle) => `${name} is built for that moment — ${angle}.`,
];

/**
 * The ask, product-scoped. Still one question a one-word reply answers, and
 * still varied per company so two recipients never see the same closing line.
 */
const PRODUCT_CTA = [
  "Worth a look? One word back is enough.",
  "Want the two-line version of how it fits? A one-word reply is plenty.",
  "Shall I send a short summary? One word back is enough.",
];

const PRODUCT_CTA_AR = [
  "هل يستحق نظرة؟ تكفي كلمة واحدة.",
  "هل أرسل لك ملخصاً قصيراً؟ يكفي رد بكلمة واحدة.",
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

const productAngle = (product) => {
  const raw = String(product?.pitchAngle || product?.summary || "").trim();
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
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
 * Observation kinds that describe the company rather than its website.
 *
 * A promote email pivots from the hook straight to the product, so the two have
 * to belong to the same thought. "Your site runs WordPress" followed by an HR
 * platform is a non-sequitur the reader notices immediately, while "you are
 * hiring" followed by an HR platform is the whole argument.
 */
const COMPANY_STATE_KINDS = new Set(["HIRING", "EXPANSION"]);

/**
 * The initial pitch for a promoted product.
 *
 * Same shape and the same ceilings as initialTemplate — hook from their own
 * observed facts, one value sentence, one small ask — with the offering
 * swapped. The rule that separates the two halves is absolute: the hook may
 * only say what a fact says, and the product copy may only describe the
 * product. Letting a product claim leak into the hook ("your payroll takes too
 * long") is the failure this arrangement exists to prevent.
 */
export const productInitialTemplate = ({ company, facts, product, recipient = null }) => {
  // A fact about the company's own state is preferred over the strongest
  // observation overall, because it is the only kind of hook the product can
  // follow without changing the subject.
  const observation =
    facts.find((f) => f !== facts[0] && COMPANY_STATE_KINDS.has(classifyObservation(f.text)))
    || pickObservation(facts);
  const hasWebsite = facts.some((f) => /^Its website is /.test(f.text));
  let kind = classifyObservation(observation.text);
  if (kind === "DEFAULT" && hasWebsite) kind = "HAS_SITE_DEFAULT";
  const hook = HOOK_COPY[kind] || HOOK_COPY.DEFAULT;
  const hookIsCompanyState = COMPANY_STATE_KINDS.has(kind);

  const name = productDisplayName(product);
  const angle = productAngle(product) || `what ${name} does`;

  // As initialTemplate's, plus the one form it cannot handle: gatherFacts
  // writes hiring facts as "It is currently hiring: …", and "I noticed it is
  // currently hiring" leaves the reader looking for whoever "it" is.
  const quote = (text) => {
    if (text.startsWith(company.name)) return text;
    const lowered = lowerFirst(text);
    const addressed = lowered.replace(/^it is\b/, "you are").replace(/^it's\b/, "you're");
    if (addressed !== lowered) return addressed;
    return /^(?:currently |actively )?(?:hiring|recruiting|advertising|expanding|opening|running|using|serving)\b/.test(lowered)
      ? `you're ${lowered}`
      : lowered;
  };

  const firstName = recipient?.firstName?.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";

  const seed = `${company.name || ""}${observation.id || ""}${name}`;
  const cta = PRODUCT_CTA[variantIndex(seed, PRODUCT_CTA.length)];
  const value = PRODUCT_VALUE[variantIndex(`${seed}v`, PRODUCT_VALUE.length)];

  const candidate = pickSupporting(facts, observation.id);
  const compose = (extra, askLine, valueFn) => [
    greeting,
    `I noticed ${quote(observation.text)}`,
    extra ? `Also ${lowerFirst(extra.text)}` : null,
    valueFn(name, angle),
    askLine,
    "Best regards",
  ].filter(Boolean).join("\n\n");

  const wordCount = (body) => body.trim().split(/\s+/).length;
  const extraFitsAlone = candidate
    && `Also ${lowerFirst(candidate.text)}`.split(/\s+/).length <= PARAGRAPH_WORD_LIMIT;

  // Same order of surrender as initialTemplate: the second observation goes
  // first, then the varied ask, then the varied value phrasing. The 70-word
  // ceiling is not negotiable — these are read on a phone.
  const shortestCta = [...PRODUCT_CTA].sort((a, b) => a.split(/\s+/).length - b.split(/\s+/).length)[0];
  const attempts = [
    { extra: extraFitsAlone ? candidate : null, ask: cta, val: value },
    { extra: null, ask: cta, val: value },
    { extra: null, ask: shortestCta, val: value },
    { extra: null, ask: shortestCta, val: PRODUCT_VALUE[2] },
  ];
  const chosen =
    attempts.find((a) => wordCount(compose(a.extra, a.ask, a.val)) <= BODY_WORD_LIMIT)
    || attempts[attempts.length - 1];

  const english = compose(chosen.extra, chosen.ask, chosen.val);

  // Arabic first for a Gulf market, but only behind a company-state hook. The
  // website-shaped Arabic openers promise a digital-presence conversation this
  // email is not going to have, so those leads get the English message alone
  // rather than an Arabic sentence that sets up the wrong subject.
  const bilingual = (ARABIC.test(company.name) || ARABIC_MARKETS.has(company.countryCode))
    && hookIsCompanyState && Boolean(hook.openerAr && hook.subjectAr);

  // The product's own copy exists only in English, so the Arabic block keeps it
  // on a line of its own. Splicing an English clause into the middle of an
  // Arabic sentence renders as scrambled word order in most mail clients.
  const arabic = bilingual
    ? [
        "مرحباً،",
        hook.openerAr(company.name),
        `قد يكون ${name} مناسباً هنا:`,
        `${angle.charAt(0).toUpperCase()}${angle.slice(1)}.`,
        PRODUCT_CTA_AR[variantIndex(`${company.name || ""}ar${name}`, PRODUCT_CTA_AR.length)],
        "مع التحية",
      ].join("\n\n")
    : null;

  // The hook's own subject only when the hook is about the company. Opening an
  // HR-software email with "your website speed" is a promise the body breaks,
  // so everything else is titled by what is actually being offered.
  const subject = bilingual ? hook.subjectAr()
    : hookIsCompanyState && hook.subject ? hook.subject()
    // Verbatim, not lower-cased: the category is where an acronym lives, and
    // "hR management software" in an inbox is worse than no subject at all.
    : product?.category || name;

  return {
    aboutCompany: aboutFromFacts({ company, facts }),
    subject: String(subject).slice(0, 200),
    body: arabic ? `${arabic}\n\n———\n\n${english}` : english,
    factIdsUsed: [observation.id, chosen.extra?.id].filter(Boolean),
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
const secondObservation = (facts = []) => {
  const first = pickObservation(facts);
  const usable = facts.filter(
    (f) => f !== first && f !== facts[0]
      && !OPENER_BLOCKLIST.test(f.text)
      && !/^Its website is|^Its address is/.test(f.text),
  );
  return usable[0] || null;
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
    const second = secondObservation(facts);
    const extra = second
      ? `One more thing I spotted: ${second.text.charAt(0).toLowerCase()}${second.text.slice(1).replace(/\.$/, "")}. `
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
    const second = secondObservation(facts);
    return {
      body: [
        "Hello,",
        second
          ? `One more thing I noticed while looking at ${company.name}: ${second.text.charAt(0).toLowerCase()}${second.text.slice(1).replace(/\.$/, "")}.`
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
  const hook = observation?.text
    ? ` — I noticed ${observation.text.charAt(0).toLowerCase()}${observation.text.slice(1).replace(/\.$/, "")}`
    : "";
  return {
    body:
      `Hello! Quick note about ${company.name}${hook}. `
      + `We help businesses with ${serviceLabel}, and I think there's a quick win here. `
      + `Would it be okay to share a short idea?`,
    factIdsUsed: [observation?.id].filter(Boolean),
  };
};
