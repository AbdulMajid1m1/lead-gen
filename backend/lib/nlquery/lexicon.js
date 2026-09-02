import { OSM_CATEGORIES } from "../adapters/overpass.js";

/**
 * The vocabulary that turns "restaurants in Dubai with outdated websites" into
 * a structured query. Deliberately hand-written rather than learned: a user
 * must be able to see exactly how their words were interpreted, and correct it.
 */

/** Phrase → OSM category key. Longest phrase wins, so order is by specificity. */
export const INDUSTRY_TERMS = [
  ["fast food", "fast_food"], ["takeaway", "fast_food"], ["takeaways", "fast_food"],
  ["coffee shop", "cafe"], ["coffee shops", "cafe"], ["cafes", "cafe"], ["cafe", "cafe"], ["café", "cafe"], ["coffee", "cafe"],
  ["restaurants", "restaurant"], ["restaurant", "restaurant"], ["diners", "restaurant"], ["eateries", "restaurant"],
  ["bakeries", "bakery"], ["bakery", "bakery"],
  // "bars" and "pubs" are deliberately absent — see lib/qualify/excludedCategories.js.
  ["hotels", "hotel"], ["hotel", "hotel"], ["guest houses", "hotel"],
  ["dental clinics", "dentist"], ["dental clinic", "dentist"], ["dentists", "dentist"], ["dentist", "dentist"], ["dental", "dentist"],
  ["medical clinics", "doctor"], ["clinics", "doctor"], ["clinic", "doctor"], ["doctors", "doctor"], ["gp practices", "doctor"],
  ["pharmacies", "pharmacy"], ["pharmacy", "pharmacy"], ["chemists", "pharmacy"],
  ["vets", "veterinary"], ["veterinary clinics", "veterinary"], ["veterinarians", "veterinary"],
  ["fitness centres", "gym"], ["fitness centers", "gym"], ["fitness studios", "gym"], ["yoga studios", "gym"],
  ["gyms", "gym"], ["gym", "gym"],
  ["hair salons", "salon"], ["hair salon", "salon"], ["beauty salons", "salon"], ["beauty salon", "salon"],
  ["nail salons", "salon"], ["barber shops", "salon"], ["hair studios", "salon"],
  ["salons", "salon"], ["salon", "salon"], ["hairdressers", "salon"], ["barbers", "salon"],
  ["spas", "spa"], ["spa", "spa"], ["massage", "spa"],
  ["real estate agencies", "real_estate"], ["real estate agents", "real_estate"], ["estate agents", "real_estate"], ["realtors", "real_estate"], ["real estate", "real_estate"],
  ["law firms", "lawyer"], ["lawyers", "lawyer"], ["solicitors", "lawyer"], ["attorneys", "lawyer"], ["legal firms", "lawyer"],
  ["accounting firms", "accountant"], ["accountants", "accountant"], ["bookkeepers", "accountant"], ["tax advisors", "accountant"],
  ["insurance agencies", "insurance"], ["insurance brokers", "insurance"], ["insurance", "insurance"],
  ["travel agencies", "travel_agency"], ["travel agents", "travel_agency"], ["tour operators", "travel_agency"],
  ["car dealerships", "car_dealer"], ["car dealers", "car_dealer"], ["auto dealers", "car_dealer"], ["car showrooms", "car_dealer"],
  ["auto repair shops", "car_repair"], ["garages", "car_repair"], ["mechanics", "car_repair"], ["car repair", "car_repair"],
  ["furniture stores", "furniture"], ["furniture shops", "furniture"],
  ["clothing stores", "clothes"], ["clothing shops", "clothes"], ["fashion boutiques", "clothes"], ["boutiques", "clothes"], ["clothing", "clothes"],
  ["jewellery stores", "jewelry"], ["jewelry stores", "jewelry"], ["jewellers", "jewelry"],
  ["florists", "florist"], ["flower shops", "florist"],
  ["supermarkets", "supermarket"], ["grocery stores", "supermarket"], ["groceries", "supermarket"], ["convenience stores", "supermarket"],
  ["electronics stores", "electronics"], ["computer shops", "electronics"], ["electronics", "electronics"],
  ["hardware stores", "hardware"], ["diy stores", "hardware"],
  ["opticians", "optician"], ["eyewear stores", "optician"],
  ["pet shops", "pet_shop"], ["pet stores", "pet_shop"],
  ["schools", "school"], ["academies", "school"], ["language schools", "school"], ["driving schools", "school"], ["training centres", "school"],
  ["nurseries", "childcare"], ["kindergartens", "childcare"], ["childcare", "childcare"], ["daycares", "childcare"],
  ["construction companies", "construction"], ["builders", "construction"], ["contractors", "construction"],
  ["plumbers", "plumber"], ["plumbing", "plumber"],
  ["electricians", "electrician"],
  ["cleaning companies", "cleaning"], ["laundries", "cleaning"], ["dry cleaners", "cleaning"],
  ["logistics companies", "logistics"], ["moving companies", "logistics"], ["freight", "logistics"],
  ["marketing agencies", "marketing"], ["advertising agencies", "marketing"], ["digital agencies", "marketing"],
  ["it companies", "it_company"], ["software companies", "it_company"], ["tech companies", "it_company"], ["it services", "it_company"],
  ["coworking spaces", "coworking"],
  // "companies", "businesses", "firms" and "offices" are deliberately absent.
  // In this product they are generic nouns ("companies hiring developers"),
  // not an industry — mapping them to office=company narrowed such queries to
  // OSM-tagged office buildings and hid every real match. Qualified forms
  // ("IT companies", "marketing agencies") are matched by the entries above,
  // which are tried longest-phrase-first.
];

/** Phrase → the signals it asks for. */
export const SIGNAL_TERMS = [
  { phrases: ["outdated website", "outdated websites", "old website", "old websites", "dated website", "bad website", "bad websites", "poor website", "terrible website", "ugly website", "legacy website"],
    signals: ["OUTDATED_WEBSITE", "OLD_COPYRIGHT", "LEGACY_JS_LIB", "NO_MOBILE_VIEWPORT", "NO_HTTPS"], label: "outdated website" },
  { phrases: ["no website", "without a website", "without website", "no web presence", "missing website", "don't have a website", "dont have a website", "no site"],
    signals: ["NO_WEBSITE"], label: "no website" },
  { phrases: ["not mobile friendly", "no mobile", "bad on mobile", "not responsive", "poor mobile experience", "mobile unfriendly"],
    signals: ["NO_MOBILE_VIEWPORT"], label: "not mobile-friendly" },
  { phrases: ["no https", "insecure", "not secure", "http only"],
    signals: ["NO_HTTPS"], label: "no HTTPS" },
  { phrases: ["slow website", "slow site", "slow websites", "loads slowly"],
    signals: ["SLOW_SITE"], label: "slow site" },
  { phrases: ["no online ordering", "no online orders", "can't order online", "cannot order online", "no ecommerce", "no e-commerce", "no online shop", "no online store", "not selling online", "no online sales"],
    signals: ["NO_ONLINE_ORDERING"], label: "no online ordering" },
  { phrases: ["no online booking", "no booking system", "no online bookings", "no booking", "no appointments online", "no online appointments", "no reservation system", "no online reservations", "no reservations"],
    signals: ["NO_BOOKING_SYSTEM"], label: "no online booking" },
  // "e-commerce store" is not an OSM category — it is a company that runs a
  // detectable commerce platform, so it resolves to technology signals.
  { phrases: ["e-commerce stores", "ecommerce stores", "e-commerce store", "ecommerce store", "online stores", "online shops", "webshops", "online retailers"],
    signals: ["WOOCOMMERCE_DETECTED", "SHOPIFY_DETECTED", "MAGENTO_LEGACY"], label: "e-commerce store" },
  { phrases: ["no crm", "no customer management", "manual processes", "manual process", "doing things manually"],
    signals: ["MANUAL_PROCESS_HINT"], label: "manual processes" },
  { phrases: ["no analytics", "no tracking"], signals: ["NO_ANALYTICS"], label: "no analytics" },
  { phrases: ["new business", "new businesses", "newly opened", "just opened", "new company", "new companies", "new domain"],
    signals: ["NEW_DOMAIN", "GROWTH_MENTION"], label: "newly established" },
  { phrases: ["expanding", "expansion", "growing", "opening new locations", "multiple locations", "new branch"],
    signals: ["GROWTH_MENTION", "HIRING_MANY_ROLES", "NEW_SUBDOMAIN"], label: "expanding" },
  { phrases: ["hiring many roles", "hiring multiple roles", "hiring at scale", "many open roles",
              "lots of open roles", "hiring aggressively", "hiring spree", "hiring lots of people",
              "growing headcount", "growing team", "growing teams"],
    signals: ["HIRING_MANY_ROLES"], label: "hiring at scale" },
  { phrases: ["hiring", "recruiting", "looking for staff", "with open roles", "open positions", "job openings", "actively hiring"],
    signals: ["HIRING_TECH_ROLE", "HIRING_CRM_ROLE", "HIRING_ECOM_ROLE", "HIRING_MOBILE_ROLE", "HIRING_AI_ROLE", "HIRING_HR_ROLE", "HIRING_MANY_ROLES"], label: "actively hiring" },
];

/** Hiring phrases that also constrain *which* role is being hired. */
export const HIRING_ROLE_TERMS = [
  { phrases: ["crm specialist", "crm specialists", "crm manager", "crm developer", "crm consultant", "salesforce", "hubspot", "crm role", "crm roles", "crm"],
    signal: "HIRING_CRM_ROLE", titleContains: ["crm", "salesforce", "hubspot", "dynamics"], label: "CRM roles" },
  { phrases: ["mobile developer", "mobile developers", "ios developer", "android developer", "react native developer", "app developer", "mobile engineer", "flutter developer"],
    signal: "HIRING_MOBILE_ROLE", titleContains: ["ios", "android", "mobile", "react native", "flutter"], label: "mobile roles" },
  { phrases: ["ai engineer", "ai engineers", "machine learning engineer", "ml engineer", "data scientist", "ai specialist", "automation engineer", "ai roles"],
    signal: "HIRING_AI_ROLE", titleContains: ["ai ", "machine learning", "ml ", "data scientist", "automation"], label: "AI / automation roles" },
  { phrases: ["ecommerce manager", "e-commerce manager", "ecommerce specialist", "shopify developer", "magento developer", "ecommerce roles"],
    signal: "HIRING_ECOM_ROLE", titleContains: ["commerce", "shopify", "magento", "woocommerce"], label: "e-commerce roles" },
  { phrases: ["hr manager", "hr managers", "hr officer", "hr officers", "hr staff", "hr person", "hr people",
              "human resources manager", "human resources officer", "human resources", "hr generalist",
              "people operations", "people ops", "head of people", "first hr", "hr roles", "hr role",
              "talent acquisition", "recruiter", "recruiters", "payroll officer", "payroll specialist", "payroll staff"],
    signal: "HIRING_HR_ROLE",
    // Substring needles against normalised job titles; "hr " keeps "chrome
    // engineer" from matching while "senior hr manager" still does.
    titleContains: ["hr ", "human resources", "people op", "recruit", "talent", "payroll", "chro"],
    label: "HR / people roles" },
  { phrases: ["software developer", "software developers", "software engineer", "software engineers", "web developer", "web developers", "full stack developer", "backend developer", "frontend developer", "developers", "engineers", "programmers", "cto", "head of engineering", "it manager", "product manager"],
    signal: "HIRING_TECH_ROLE", titleContains: ["developer", "engineer", "programmer", "cto", "product manager", "it manager"], label: "software roles" },
];

/** Technology names users actually type. */
export const TECH_TERMS = [
  ["wordpress", "WordPress"], ["woocommerce", "WooCommerce"], ["shopify", "Shopify"],
  ["magento", "Magento"], ["wix", "Wix"], ["squarespace", "Squarespace"], ["webflow", "Webflow"],
  ["godaddy", "GoDaddy Website Builder"], ["drupal", "Drupal"], ["joomla", "Joomla"],
  ["bigcommerce", "BigCommerce"], ["prestashop", "PrestaShop"], ["ghost", "Ghost"],
  ["react", "React"], ["angular", "Angular"], ["vue", "Vue.js"], ["next.js", "Next.js"], ["nextjs", "Next.js"],
  ["jquery", "jQuery"], ["bootstrap", "Bootstrap"], ["hubspot", "HubSpot"], ["salesforce", "Salesforce"],
  ["stripe", "Stripe"], ["paypal", "PayPal"], ["shopify plus", "Shopify"],
];

/** Service the user wants to sell. */
export const SERVICE_TERMS = [
  { phrases: ["website development", "web development", "website redesign", "new website", "website rebuild", "web design"], service: "WEBSITE_DEV", label: "website development" },
  { phrases: ["crm development", "crm system", "crm build", "crm"], service: "CRM_DEV", label: "CRM development" },
  { phrases: ["mobile app", "mobile application", "app development", "ios app", "android app", "mobile apps"], service: "MOBILE_APP", label: "mobile app development" },
  { phrases: ["ai automation", "automation", "ai agent", "ai integration", "chatbot", "workflow automation"], service: "AI_AUTOMATION", label: "AI automation" },
  { phrases: ["ecommerce development", "e-commerce development", "online store", "online shop", "ecommerce site", "webshop"], service: "ECOMMERCE_DEV", label: "e-commerce development" },
  { phrases: ["saas", "saas development", "saas platform", "software as a service"], service: "SAAS_DEV", label: "SaaS development" },
  { phrases: ["custom software", "bespoke software", "custom development", "software development"], service: "CUSTOM_SOFTWARE", label: "custom software development" },
  // Internal business systems people ask for by acronym. These are custom
  // software work, and users type the acronym far more often than the phrase.
  { phrases: ["hrm software", "hrm system", "hrm service", "hr software", "hr system", "hr platform", "hris",
              "hr management system", "employee management system", "payroll system", "payroll software",
              "attendance system", "attendance software", "leave management", "hr tool", "hrm", "hrms"],
    service: "HR_SOFTWARE", label: "HR software" },
  { phrases: ["erp", "erp system", "erp software", "inventory system", "inventory management",
              "pos system", "point of sale", "booking system", "management system", "internal tool",
              "internal software", "dashboard", "admin panel", "portal"],
    service: "CUSTOM_SOFTWARE", label: "internal business system" },
  // A bare "website" is the single most common thing a user types.
  { phrases: ["website", "websites", "web site", "landing page", "company website"],
    service: "WEBSITE_DEV", label: "website development" },
];

/** Relative timeframes. */
export const TIMEFRAME_TERMS = [
  { phrases: ["today"], days: 1, label: "today" },
  { phrases: ["yesterday"], days: 2, label: "since yesterday" },
  { phrases: ["this week", "past week", "last week", "last 7 days", "in the last week", "recently"], days: 7, label: "this week" },
  { phrases: ["this month", "past month", "last month", "last 30 days", "in the last month"], days: 30, label: "this month" },
  { phrases: ["this quarter", "last 90 days", "past 3 months", "last 3 months"], days: 90, label: "this quarter" },
  { phrases: ["this year", "last 12 months", "past year"], days: 365, label: "this year" },
];

export const SIZE_TERMS = [
  { phrases: ["small businesses", "small business", "smb", "smbs", "local businesses", "small companies"], size: "SMALL", label: "small businesses" },
  { phrases: ["medium businesses", "mid-size", "midsize", "mid market", "mid-market"], size: "MEDIUM", label: "mid-size businesses" },
  { phrases: ["enterprises", "enterprise", "large companies", "big companies"], size: "LARGE", label: "large companies" },
  { phrases: ["startups", "startup", "start-ups"], size: "MICRO", label: "startups" },
];

/**
 * Words that introduce a place. The location is whatever follows, up to the
 * next keyword — which is why the parser strips known terms before looking.
 */
export const LOCATION_PREPOSITIONS = ["in", "near", "around", "at", "from", "based in", "located in"];

/** Everything the parser should ignore when isolating a location phrase. */
export const STOPWORDS = new Set([
  "the", "a", "an", "with", "without", "and", "or", "that", "which", "who", "have", "has", "having",
  "show", "me", "find", "get", "give", "list", "all", "any", "some", "my", "our", "for", "to", "of",
  "need", "needs", "needing", "want", "wants", "looking", "are", "is", "be", "their", "they", "no",
  "leads", "lead", "prospects", "prospect", "companies", "businesses", "clients", "customers",
  "best", "top", "good", "great", "fresh", "please", "can", "you",
  // "new" is deliberately NOT a stopword — it would truncate New York, New Delhi
  // and Newcastle. The phrases that use it ("new website", "new business") are
  // matched and removed by the lexicon before location extraction runs.
  // Negation and connective filler. These matter because a location phrase is
  // read as the run of words after "in"/"near", and it must stop at the first
  // one of these rather than swallowing "not on" or "using".
  "not", "non", "using", "uses", "use", "on", "but", "still", "only", "just",
  "run", "runs", "running", "built", "build", "made", "powered", "via", "by",
  // Ordinal/quantity filler that survives phrase matching ("their first HR
  // officer", "many roles at once") and must not be read as a place name.
  "first", "once", "at", "one", "two", "few", "several",
]);

export const industryLabel = (key) => OSM_CATEGORIES[key]?.label || key;
