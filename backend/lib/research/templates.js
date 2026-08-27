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

/** The initial pitch: hook → pain → value → tiny CTA, under ~80 words. */
export const initialTemplate = ({ company, facts, serviceKey, serviceLabel }) => {
  const copy = PITCH_COPY[serviceKey] || PITCH_COPY.CUSTOM_SOFTWARE;
  const observation = pickObservation(facts);
  const hasWebsite = facts.some((f) => /^Its website is /.test(f.text));
  let kind = classifyObservation(observation.text);
  // A lead with a verified website must never get the "can't find you online"
  // premise the generic service copy leads with.
  if (kind === "DEFAULT" && hasWebsite) kind = "HAS_SITE_DEFAULT";
  const hook = HOOK_COPY[kind] || HOOK_COPY.DEFAULT;

  // A fact that opens with the company's own name must keep its capital.
  const quote = (text) => (text.startsWith(company.name) ? text : lowerFirst(text));

  // Both halves must come from the same thought: a booking hook answered with a
  // "get found in search" promise reads as two templates stitched together.
  const pain = hook.pain || copy.pain;
  const value = hook.value || copy.value;
  const english = [
    "Hello,",
    `I noticed ${quote(observation.text)}`,
    `That matters: ${pain}.`,
    `${value}.`,
    "Want me to send 2-3 specific ideas? One word back is enough.",
    "Best regards",
  ].join("\n\n");

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
        "هل أرسل لك ٢-٣ أفكار محددة؟ تكفي كلمة واحدة.",
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
    factIdsUsed: [observation.id].filter(Boolean),
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
