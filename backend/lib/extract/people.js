import * as cheerio from "cheerio";

/**
 * Finds the people a business publishes about itself, so outreach can address
 * someone by name instead of shouting at `info@`.
 *
 * Scope is the same as the rest of the extract layer and deliberately narrow:
 * only names a business chose to publish on its own website — team pages, staff
 * bios, leadership listings — plus the public social profiles it links to. No
 * pattern-guessed addresses, no scraping of third-party people databases, and
 * no inference about anyone who is not presented as a representative of the
 * business. What a company puts on its own "Our Team" page is published for
 * exactly this purpose.
 */

/**
 * Job titles ranked by how much authority they carry over a website decision.
 * Ordered most-senior first — the first pattern that matches wins, so `founder`
 * must be tested before the looser `director` and `manager` rules.
 */
const SENIORITY_RULES = [
  { seniority: "OWNER",      re: /\b(?:founder|co-?founder|owner|proprietor|managing\s+director|managing\s+partner|principal|propriet[oa]r|sole\s+trader)\b/i },
  { seniority: "EXECUTIVE",  re: /\b(?:c[etfomdirs]{1,2}o\b|chief\s+\w+|president|vice[\s-]president|\bvp\b|executive\s+director|board\s+member|partner|general\s+manager|\bgm\b|head\s+of\s+\w+|director\s+of\s+\w+|\bdirector\b)\b/i },
  { seniority: "MARKETING",  re: /\b(?:marketing|growth|brand|communications?|digital|social\s+media|content|\bpr\b|public\s+relations|demand\s+gen)\b/i },
  { seniority: "OPERATIONS", re: /\b(?:manager|supervisor|coordinator|administrator|team\s+lead|lead\b|officer|executive|specialist|consultant|advisor|operations|reception(?:ist)?|assistant|secretary)\b/i },
];

export const classifySeniority = (title) => {
  if (!title) return "UNKNOWN";
  for (const rule of SENIORITY_RULES) {
    if (rule.re.test(title)) return rule.seniority;
  }
  return "OTHER";
};

/** Ranking used when picking a single outreach target. */
const SENIORITY_RANK = { OWNER: 5, EXECUTIVE: 4, MARKETING: 3, OPERATIONS: 2, OTHER: 1, UNKNOWN: 0 };

/**
 * Words that appear in title case on team pages but are never a person's name.
 * Without this every "Our Team", "Read More" and "Book Now" becomes a contact.
 */
const NOT_A_NAME = /^(?:our|the|meet|about|contact|read|view|learn|book|call|email|team|staff|home|more|all|new|see|get|join|why|how|what|who|welcome|copyright|privacy|terms|menu|search|login|sign|next|prev|previous|back|close|open|show|hide|click|here|now|free|best|top|full|part|time|page|site|web|blog|news|help|faq|support|services?|products?|company|business|clients?|customers?|partners?|careers?|jobs?|apply|submit|send|share|follow|subscribe|newsletter|stay|beyond|choose|take|discover|explore|find|start|begin|enjoy|experience|inside|within|towards|through|introducing|announcing|celebrating|building|creating|leading|performing|visual)\b/i;

/**
 * Words that never appear in a person's name, wherever they sit in the string.
 *
 * NOT_A_NAME above is anchored to the first word, which is right for it — "Best"
 * and "Page" and "Read" are real surnames, so matching those anywhere would
 * throw away real contacts. These are different: nobody is called Admissions or
 * Scholarship, so they can be matched anywhere, and they have to be. Without
 * this, any two capitalised words on a page became a person — a school's site
 * yielded "Performing Arts", "REGISTRATION FEES" and "Affordable Fee" as
 * contacts, and the composer duly opened an email with "Hi Affordable,".
 */
const NEVER_IN_A_NAME =
  /\b(?:school|college|academy|university|campus|institute|programme|program|admission|admissions|enrol|enrolment|enrollment|registration|register|tuition|curriculum|grade|grades|student|students|pupil|pupils|parent|parents|alumni|faculty|department|syllabus|arts|sciences|library|laboratory|classroom|rooms|scholarship|multimedia|fee|fees|pricing|price|prices|payment|payments|discount|package|packages|course|courses|lesson|lessons|licence|license|enquiry|enquiries|inquiry|inquiries|links|tours|resource|resources|innovation|technology|admissions|vacancy|vacancies|testimonial|testimonials|gallery|brochure|prospectus|curriculum|timetable|calendar|policy|policies|email|phone|address|location|hours|opening)\b/i;

/**
 * The filler a role label is padded with — "General Enquiries", "Primary
 * Secretary", "Deputy Head". Only ever consulted alongside TITLE_VOCABULARY, to
 * decide whether a candidate is made *entirely* of job words.
 */
const GENERIC_NAME_WORD =
  /^(?:general|primary|secondary|higher|high|middle|main|central|front|back|office|admin|administration|and|of|the|for|to|at|in|on|team|staff|group|dept|division|unit|desk|line|point|centre|center)$/i;

/** A plausible personal name: 2–4 capitalised words, no digits or symbols. */
const looksLikePersonName = (raw) => {
  if (!raw) return false;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 4 || name.length > 60) return false;
  if (/[0-9@#$%^&*_=+<>{}[\]|\\/]/.test(name)) return false;
  if (NOT_A_NAME.test(name)) return false;
  if (NEVER_IN_A_NAME.test(name)) return false;

  // "Middle YearsProgramme", "HassanL.C.E.HHomoeopath" — a lowercase letter
  // followed immediately by a capital is usually two strings that lost the
  // space between them when the markup was flattened. Usually, not always:
  // AlBusaidi, ElSayed, McDonald and MacArthur are written exactly that way, so
  // the transition is only suspicious when it does not follow a name prefix.
  const FUSED_PREFIX = /^(?:Mc|Mac|Al|El|Ad|De|Del|Di|Du|La|Le|Van|Von|Da|Dos|St|O)[\p{Lu}]/u;
  if (name.split(" ").some((w) => /[a-z][A-Z]/.test(w) && !FUSED_PREFIX.test(w))) return false;

  const words = name.split(" ");
  if (words.length < 2 || words.length > 4) return false;

  // A string made only of job words is a role label, not a person: "School
  // Principal", "Human Resource", "General Enquiries". A real name always
  // carries at least one word that is not part of the job.
  if (TITLE_VOCABULARY.test(name) && words.every((w) => TITLE_VOCABULARY.test(w) || GENERIC_NAME_WORD.test(w))) return false;

  // Every word must read as a name part: initial capital (or a particle such as
  // "van", "bin", "al", "de" that legitimately stays lowercase).
  // "der", "den" and "ter" were missing, so "Maria van der Berg" was discarded
  // as not a name at all.
  const PARTICLE = /^(?:van|von|de|der|den|del|della|da|das|dos|di|du|le|la|ter|ten|bin|bint|ibn|al|el|abu|abd|mac|mc|o'|san|st)$/i;
  return words.every((w) => PARTICLE.test(w) || /^[\p{Lu}][\p{L}'’.-]*$/u.test(w));
};

/**
 * Vocabulary that marks a string as a job title rather than a name.
 * Needed because many real titles are two capitalised words — "Reception
 * Manager", "Practice Director", "Operations Lead" — and are indistinguishable
 * from a personal name by shape alone.
 */
const TITLE_VOCABULARY = /\b(?:founder|owner|proprietor|partner|principal|president|chief|c[etfomdirs]{1,2}o|vp|director|manager|managing|head|lead|supervisor|coordinator|administrator|officer|executive|specialist|consultant|advisor|analyst|engineer|developer|designer|architect|accountant|attorney|lawyer|solicitor|doctor|dr|dentist|surgeon|physician|therapist|nurse|chef|stylist|barber|trainer|agent|broker|realtor|receptionist|reception|assistant|associate|intern|marketing|sales|operations|finance|hr|it|support|service|technician|supervisor|secretary|treasurer|chairman|chairwoman|chairperson|board|senior|junior|deputy|assoc|mgr)\b/i;

/** Titles are noisy free text; keep them short and clean. */
const cleanTitle = (raw) => {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").replace(/^[\s|,·•\-–—]+|[\s|,·•\-–—]+$/g, "").trim();
  if (!t || t.length < 2 || t.length > 120) return null;
  // A job title is a label, not a sentence. "Our innovation hub is where
  // creativity meets…" is body copy that happened to sit under a heading, and
  // accepting it lets the heading itself pass as a person, because a title is
  // one of the things that corroborates a name.
  if (t.split(" ").length > 10) return null;
  if (/\b(?:is|are|was|were|we|our|you|your|they|their|this|that|which|where|when)\b/i.test(t) && !TITLE_VOCABULARY.test(t)) return null;
  // Reject a second personal name appearing where a title should be — but only
  // when it carries no job vocabulary, so "Reception Manager" survives while a
  // stray "Sarah Mitchell" does not.
  if (looksLikePersonName(t) && !TITLE_VOCABULARY.test(t)) return null;
  return t;
};

/**
 * Does an email's local part correspond to this person's name?
 * Matches `john.smith@`, `jsmith@`, `john@` and `smithj@` — the four
 * conventions that cover almost every small-business mailbox.
 *
 * This only ever *links an address the site already published* to a name also
 * already published. It never constructs an address that was not observed.
 */
export const emailMatchesName = (email, fullName) => {
  if (!email || !fullName) return false;
  const local = email.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const parts = fullName.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/\s+/).filter((w) => w.length > 1);
  if (!local || parts.length < 2) return false;

  const [first, last] = [parts[0], parts[parts.length - 1]];
  return [
    `${first}${last}`, `${last}${first}`,
    `${first[0]}${last}`, `${last}${first[0]}`,
    `${first}${last[0]}`, first, last,
  ].includes(local);
};

const LINKEDIN_PERSON_RE = /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i;

/**
 * Extract people from one page.
 *
 * Three independent strategies, strongest first. Each is on its own weak; run
 * together they cover the layouts small-business sites actually use.
 *
 * @param {string} html
 * @param {{pageUrl?:string, emails?:Array<{value:string}>}} ctx
 * @returns {Array<{fullName, title, seniority, linkedinUrl, email, observedOnUrl, method}>}
 */
export const extractPeople = (html, ctx = {}) => {
  const $ = cheerio.load(html || "");
  const pageUrl = ctx.pageUrl || null;
  const found = new Map(); // lowercased name → person

  const add = (fullName, { title = null, linkedinUrl = null, method }) => {
    const name = String(fullName || "").replace(/\s+/g, " ").trim();
    if (!looksLikePersonName(name)) return;
    const key = name.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      // Later strategies fill gaps but never overwrite a stronger reading.
      if (!existing.title && title) {
        existing.title = title;
        existing.seniority = classifySeniority(title);
      }
      if (!existing.linkedinUrl && linkedinUrl) existing.linkedinUrl = linkedinUrl;
      return;
    }
    found.set(key, {
      fullName: name,
      title: title || null,
      seniority: classifySeniority(title),
      linkedinUrl: linkedinUrl || null,
      email: null,
      observedOnUrl: pageUrl,
      method,
    });
  };

  // ── 1. Schema.org Person — the site stating explicitly who someone is ──
  $('script[type="application/ld+json"]').each((_, el) => {
    let parsed;
    try {
      parsed = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed, ...(parsed["@graph"] || [])];
    for (const node of queue) {
      if (!node || typeof node !== "object") continue;
      // Organisations name their leadership under founder/employee/member.
      for (const field of ["founder", "founders", "employee", "employees", "member", "members"]) {
        const val = node[field];
        for (const person of Array.isArray(val) ? val : [val]) {
          if (person && typeof person === "object" && person.name) {
            add(person.name, { title: cleanTitle(person.jobTitle), method: "SCHEMA_ORG" });
          }
        }
      }
      if (String(node["@type"] || "") === "Person" && node.name) {
        add(node.name, { title: cleanTitle(node.jobTitle), method: "SCHEMA_ORG" });
      }
    }
  });

  // ── 2. A LinkedIn profile link, with the name from its own text or nearby ──
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let abs;
    try {
      abs = pageUrl ? new URL(href, pageUrl).href : href;
    } catch {
      return;
    }
    const m = LINKEDIN_PERSON_RE.exec(abs);
    if (!m) return;

    const linkedinUrl = abs.split("?")[0];
    const linkText = $(el).text().replace(/\s+/g, " ").trim();

    // The anchor text is often just "LinkedIn", so fall back to the card the
    // link sits in — the person's name is virtually always its heading.
    const candidates = [
      linkText,
      $(el).attr("aria-label") || "",
      $(el).attr("title") || "",
      $(el).closest("li, article, .card, .team-member, .member, div").find("h1,h2,h3,h4,h5,strong,b").first().text(),
      // A profile slug is a last resort: "john-smith-1a2b3c" → "John Smith".
      decodeURIComponent(m[1]).replace(/-\w{6,}$/, "").replace(/-/g, " ")
        .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()),
    ];

    for (const candidate of candidates) {
      const name = String(candidate || "").replace(/\s+/g, " ").trim();
      if (!looksLikePersonName(name)) continue;
      const card = $(el).closest("li, article, .card, .team-member, .member, div");
      const title = cleanTitle(card.find(".title, .role, .position, .job-title, p, span").first().text());
      add(name, { title, linkedinUrl, method: "LINKEDIN_LINK" });
      return;
    }
  });

  // ── 3. Team-card layout: a heading that is a name, with a title beneath ──
  // The dominant pattern on small-business team pages, and the only one that
  // works when there is no structured data and no LinkedIn link.
  $("h2, h3, h4, h5, .name, .team-name, .member-name").each((_, el) => {
    const name = $(el).text().replace(/\s+/g, " ").trim();
    if (!looksLikePersonName(name)) return;

    // The title is the next meaningful text: a sibling, or the first descriptive
    // element inside the same card.
    const sibling = $(el).next("p, span, div, small, em, .title, .role, .position").first().text();
    const card = $(el).closest("li, article, .card, .team-member, .member, .staff, .person");
    const inCard = card.find(".title, .role, .position, .job-title, .designation").first().text();
    const title = cleanTitle(inCard) || cleanTitle(sibling);
    if (!title) return; // a bare capitalised heading is not evidence of a person

    add(name, { title, method: "TEAM_CARD" });
  });

  // ── Attach published addresses to the people they belong to ──
  const people = [...found.values()];
  for (const person of people) {
    const hit = (ctx.emails || []).find((e) => emailMatchesName(e.value ?? e, person.fullName));
    if (hit) person.email = hit.value ?? hit;
  }
  return people;
};

/**
 * Pick the single best person to address a message to.
 *
 * Ranked by authority, then by whether we can actually reach them — a named
 * owner with no address is still more useful than an anonymous inbox, because
 * the greeting can use their name.
 */
export const pickPrimaryPerson = (people = []) => {
  if (!people.length) return null;
  const score = (p) => {
    let s = (SENIORITY_RANK[p.seniority] ?? 0) * 100;
    if (p.email) s += 40;
    if (p.linkedinUrl) s += 20;
    if (p.title) s += 10;
    if (p.method === "SCHEMA_ORG") s += 15; // the site said so explicitly
    return s;
  };
  return [...people].sort((a, b) => score(b) - score(a))[0];
};

export const __testables = { looksLikePersonName, cleanTitle, SENIORITY_RANK, TITLE_VOCABULARY };
