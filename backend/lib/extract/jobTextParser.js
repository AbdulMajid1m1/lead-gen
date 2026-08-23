import { normalizeJobTitle } from "../../utils/normalize.js";

/**
 * Turns a job posting into the two things the signal engine needs:
 * which technologies it names, and which service opportunity it implies.
 *
 * Everything here is lexicon matching, not inference — "hiring a Salesforce
 * administrator" is a *fact* about the posting, and the leap to "may need CRM
 * work" happens later in the signal engine where it can be labelled as such.
 */

/** skill → canonical name, matched case-insensitively on word boundaries. */
const TECH_SKILLS = [
  // languages & runtimes
  "javascript", "typescript", "python", "java", "kotlin", "swift", "objective-c", "c#", ".net", "php",
  "ruby", "go", "golang", "rust", "scala", "elixir", "dart",
  // web
  "react", "angular", "vue", "next.js", "nuxt", "svelte", "node.js", "nodejs", "express", "django",
  "flask", "laravel", "symfony", "rails", "spring boot", "asp.net",
  // mobile
  "ios", "android", "react native", "flutter", "xamarin", "swiftui", "jetpack compose",
  // data & AI
  "machine learning", "deep learning", "nlp", "llm", "generative ai", "genai", "tensorflow", "pytorch",
  "langchain", "openai", "computer vision", "data engineering", "airflow", "dbt", "spark", "kafka",
  // cloud & infra
  "aws", "azure", "gcp", "google cloud", "kubernetes", "docker", "terraform", "devops", "ci/cd",
  // data stores
  "postgresql", "postgres", "mysql", "mongodb", "redis", "elasticsearch", "snowflake", "bigquery",
  // CRM & business platforms
  "salesforce", "hubspot", "dynamics 365", "microsoft dynamics", "zoho", "pipedrive", "netsuite",
  "sap", "odoo", "servicenow", "sugarcrm", "freshsales", "zendesk",
  // e-commerce
  "shopify", "magento", "woocommerce", "bigcommerce", "prestashop", "shopware", "salesforce commerce",
  // CMS & low-code
  "wordpress", "drupal", "contentful", "sanity", "strapi", "webflow", "power apps", "power automate",
  "zapier", "make.com", "n8n", "retool",
  // analytics
  "tableau", "power bi", "looker", "google analytics", "segment", "mixpanel",
];

/**
 * Role lexicons → the signal each implies. Order matters: the first matching
 * category wins, so the more specific ones come first.
 */
const ROLE_CATEGORIES = [
  {
    signal: "HIRING_CRM_ROLE",
    label: "CRM / customer-platform role",
    service: "CRM_DEV",
    patterns: [
      /\bcrm\b/, /salesforce/, /hubspot/, /dynamics\s*365/, /microsoft dynamics/, /\bzoho\b/,
      /netsuite/, /servicenow/, /\bodoo\b/,
      // "Customer Success Manager" is deliberately absent: it is a sales role,
      // not evidence of a CRM systems project. Only platform-shaped titles count.
      /customer (?:data|relationship) (?:platform|management|systems?)/,
      /sales (?:operations|systems|technology)/, /revenue operations/, /\brevops\b/, /\bsales ops\b/,
    ],
  },
  {
    signal: "HIRING_AI_ROLE",
    label: "AI / automation role",
    service: "AI_AUTOMATION",
    patterns: [
      /\b(?:ai|ml)\s+engineer/, /machine learning/, /deep learning/, /\bnlp\b/, /\bllm\b/,
      /generative ai/, /data scientist/, /automation (?:engineer|specialist|manager)/,
      /\brpa\b/, /process automation/, /prompt engineer/, /ai (?:specialist|lead|architect|developer)/,
    ],
  },
  {
    signal: "HIRING_MOBILE_ROLE",
    label: "Mobile-app role",
    service: "MOBILE_APP",
    patterns: [
      /\bios\s+(?:developer|engineer)/, /\bandroid\s+(?:developer|engineer)/, /mobile (?:developer|engineer|app)/,
      /react native/, /\bflutter\b/, /\bswift\b.*(?:developer|engineer)/, /\bkotlin\b.*(?:developer|engineer)/,
    ],
  },
  {
    signal: "HIRING_ECOM_ROLE",
    label: "E-commerce role",
    service: "ECOMMERCE_DEV",
    patterns: [
      /e-?commerce/, /\bshopify\b/, /\bmagento\b/, /woocommerce/, /bigcommerce/,
      /online (?:store|shop|sales) (?:manager|specialist|lead)/, /marketplace (?:manager|specialist)/,
      /digital merchandis/, /\bd2c\b/,
    ],
  },
  {
    signal: "HIRING_HR_ROLE",
    label: "HR / people role",
    service: "HR_SOFTWARE",
    patterns: [
      // A company hiring its first HR person is the classic trigger for buying
      // HR software — payroll, leave and attendance just became someone's job.
      /\bhr\s+(?:manager|officer|generalist|executive|specialist|coordinator|assistant|director|lead|business partner|admin)/,
      /human resources/, /people (?:operations|ops|partner|manager|lead)/,
      /head of (?:people|hr|human resources|talent)/, /\bchro\b/, /people and culture/,
      /talent acquisition/, /\brecruiters?\b/, /recruitment (?:specialist|manager|officer|consultant|coordinator)/,
      /payroll (?:officer|specialist|manager|administrator|executive)/,
    ],
  },
  {
    signal: "HIRING_TECH_ROLE",
    label: "Software / technology role",
    service: "CUSTOM_SOFTWARE",
    patterns: [
      /(?:software|web|full[\s-]?stack|front[\s-]?end|back[\s-]?end|application)\s+(?:developer|engineer)/,
      /\bdeveloper\b/, /\bprogrammer\b/, /\bengineer(?:ing)?\s+(?:manager|lead)\b/,
      /\bcto\b/, /head of (?:engineering|technology|it|digital|product)/,
      /\bdevops\b/, /site reliability/, /\bqa\s+(?:engineer|analyst)/, /\bdata engineer/,
      /product (?:manager|owner)/, /technical (?:lead|architect)/, /\bit\s+(?:manager|specialist|administrator)/,
      /digital transformation/, /solutions? architect/, /systems? analyst/, /\bwebmaster\b/,
      /\bwordpress\b/, /\bumbraco\b/, /\bsharepoint\b/,
    ],
  },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {{title:string, descriptionSnippet?:string, department?:string}} job
 * @returns {{skills:Array<{skill,kind}>, categories:Array, primary:object|null, seniority:string|null}}
 */
export const parseJobText = (job) => {
  const title = String(job.title || "");
  const normTitle = normalizeJobTitle(title);
  // The title is authoritative; the description often lists a whole stack the
  // company merely "works with", so it only contributes technology skills.
  const description = String(job.descriptionSnippet || "").toLowerCase();
  const haystackTitle = `${normTitle} ${String(job.department || "").toLowerCase()}`;
  const haystackAll = `${haystackTitle} ${description}`;

  const skills = [];
  for (const skill of TECH_SKILLS) {
    const re = new RegExp(`(?:^|[^a-z0-9+#.])${escapeRe(skill)}(?:$|[^a-z0-9+#])`, "i");
    if (re.test(haystackAll)) skills.push({ skill, kind: "TECH" });
  }

  const categories = [];
  for (const category of ROLE_CATEGORIES) {
    // Matching on the title alone keeps "we use Salesforce internally" in a
    // backend job description from being read as a CRM hire.
    const inTitle = category.patterns.some((p) => p.test(haystackTitle));
    const inDescription = category.patterns.some((p) => p.test(description));
    if (inTitle || inDescription) {
      categories.push({
        signal: category.signal,
        label: category.label,
        service: category.service,
        // A title match is direct evidence; a description-only match is weaker.
        strength: inTitle ? 1 : 0.5,
        matchedIn: inTitle ? "TITLE" : "DESCRIPTION",
        evidence: inTitle
          ? `job title "${title}"`
          : `job description for "${title}"`,
      });
    }
  }

  categories.sort((a, b) => b.strength - a.strength);

  const seniority =
    /\b(?:head of|director|vp|chief|cto|cio)\b/.test(normTitle) ? "EXECUTIVE"
    : /\b(?:lead|principal|staff|manager)\b/.test(normTitle) ? "SENIOR"
    : /\b(?:senior|sr)\b/.test(normTitle) ? "SENIOR"
    : /\b(?:junior|jr|intern|graduate|trainee|apprentice)\b/.test(normTitle) ? "JUNIOR"
    : null;

  return {
    skills,
    categories,
    primary: categories[0] || null,
    seniority,
    isTechRelated: categories.length > 0,
  };
};

/** Does this posting indicate technology work at all? Used to filter aggregators. */
export const isTechnologyJob = (job) => parseJobText(job).isTechRelated;
