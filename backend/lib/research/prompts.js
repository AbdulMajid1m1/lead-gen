import { OSM_CATEGORIES } from "../adapters/overpass.js";
import { SIGNAL_CATALOG } from "../signals/signalCatalog.js";

/**
 * Prompt architecture for the AI research layer.
 *
 * Every prompt here is written to be *accurate by construction* rather than
 * accurate by hope. Four techniques do the work:
 *
 *   1. Closed vocabularies — the model picks from our enums, it cannot invent
 *      an industry or a signal type.
 *   2. Null-over-guess — stated explicitly, with the reason, in every prompt.
 *      Models pad when they think a long list is what you want.
 *   3. Citation-required schemas — a company with no source URL fails schema
 *      validation, so citation is structural rather than aspirational.
 *   4. Provenance per field — each contact detail carries the URL it was seen
 *      on, which is what makes independent verification possible at all.
 *
 * PROMPT_VERSION is stored on every AI-derived row, so a lead found last month
 * can still be explained by the prompt that actually produced it.
 */
export const PROMPT_VERSION = "1.5.0";

const INDUSTRY_KEYS = Object.keys(OSM_CATEGORIES);
const SIGNAL_KEYS = Object.keys(SIGNAL_CATALOG);
const SERVICES = ["WEBSITE_DEV", "CRM_DEV", "MOBILE_APP", "AI_AUTOMATION", "ECOMMERCE_DEV", "SAAS_DEV", "CUSTOM_SOFTWARE", "HR_SOFTWARE"];

// ─── 1. Query → research brief ────────────────────────────────────────────────

export const BRIEF_SYSTEM = `You are a B2B lead-research planner for a software-development agency.
Convert the user's prospecting request into a research brief.

Rules — follow all of them:
1. Use ONLY the closed vocabularies provided for industries, signals and service.
   Never invent enum values.
2. If the request does not clearly state something, use null or an empty array.
   A null is always better than a guess. Never infer a location, industry or
   company size the user did not state or unambiguously imply.
3. searchStrategies are 2-4 DISTINCT web-search angles, each phrased as a
   concrete instruction: what to look for, where to look, and what makes a
   business a match. Strategies must not overlap — each should surface a
   different slice of matching businesses (for example: directory listings,
   news and openings, vendor or partner customer-lists, review sites).
4. icpTraits are observable characteristics — things a researcher could verify
   on a public web page. Never traits requiring inside knowledge such as
   budget, headcount plans or internal strategy.
5. exclusions list what must NOT be returned. Think carefully about the
   inversion trap: for a request like "businesses that NEED X", the companies
   that SELL X are the opposite of the target and must be excluded explicitly.
6. Output JSON only, matching the schema exactly.`;

export const buildBriefUser = ({ rawQuery, deterministicParse }) => `Request: "${rawQuery}"

Deterministic parse so far (authoritative wherever it is filled in):
${JSON.stringify(deterministicParse, null, 2)}

Allowed industries: ${INDUSTRY_KEYS.join(", ")}
Allowed signals: ${SIGNAL_KEYS.join(", ")}
Allowed services: ${SERVICES.join(", ")}`;

export const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["restatedGoal", "industries", "location", "service", "signals", "icpTraits", "searchStrategies", "exclusions"],
  properties: {
    restatedGoal: { type: "string", description: "One sentence restating what the user is looking for." },
    industries: { type: "array", maxItems: 3, items: { type: "string", enum: INDUSTRY_KEYS } },
    location: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["name", "countryCode", "cities"],
      properties: {
        name: { type: "string" },
        countryCode: { type: ["string", "null"], description: "ISO-3166 alpha-2, uppercase." },
        cities: {
          type: "array", maxItems: 5, items: { type: "string" },
          description: "Specific cities worth searching. A country alone is too coarse for a map search.",
        },
      },
    },
    service: { type: ["string", "null"], enum: [...SERVICES, null] },
    signals: { type: "array", maxItems: 8, items: { type: "string", enum: SIGNAL_KEYS } },
    icpTraits: { type: "array", maxItems: 8, items: { type: "string" } },
    searchStrategies: {
      type: "array", minItems: 2, maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "searchInstruction", "expectedSourceTypes"],
        properties: {
          label: { type: "string", description: "Short human label shown as a progress step." },
          searchInstruction: { type: "string", description: "A concrete search instruction for a researcher." },
          expectedSourceTypes: {
            type: "array",
            items: { type: "string", enum: ["DIRECTORY", "NEWS", "REVIEW_SITE", "VENDOR_PAGE", "SOCIAL", "MAPS_LISTING", "COMPANY_SITE", "OTHER"] },
          },
        },
      },
    },
    exclusions: { type: "array", maxItems: 6, items: { type: "string" } },
  },
};

// ─── 2. Web-search company discovery ──────────────────────────────────────────

export const DISCOVER_SYSTEM = `You are a company-discovery researcher. Use web search to find REAL,
currently-operating businesses matching the strategy below. You are gathering
evidence, not writing marketing copy.

Hard rules:
1. Only include a company if you found it named on a real web page during THIS
   search. For every company, sourceUrls must list the exact page(s) where you
   saw it. Never a homepage you guessed at, never a URL you did not retrieve.
   A company without at least one real source URL must be omitted entirely.
2. Copy contact details (phone, email, address, website) EXACTLY as written on
   the source page. If a detail is not visible on a page you actually
   retrieved, set it to null. Never derive an email from a pattern such as
   info@theirdomain, never guess a country code, never complete a partial
   phone number.
3. For every detail you do fill in, set the matching field in detailSources to
   the URL where that specific detail appeared.
4. whyMatch must quote or closely paraphrase evidence from the page — what you
   actually saw that makes this business match. Not a generic sales rationale.
5. Prefer primary sources: the business's own website, its maps or directory
   listing. Aggregator blog posts are weaker and often stale.
6. Respect the exclusions exactly. If you are unsure whether a business
   matches, omit it.
7. Returning fewer companies than the maximum — including zero — is a correct
   and expected outcome when the evidence is not there. A short, well-evidenced
   list is far more valuable than a padded one. Do not invent companies to
   reach a target count.`;

export const buildDiscoverUser = ({ strategy, brief, region, maxCompanies = 12 }) => `Strategy: ${strategy.searchInstruction}

Region: ${region}
${brief.location?.cities?.length ? `Focus cities: ${brief.location.cities.join(", ")}` : ""}
Search in English and in the local language; company names may not be in Latin script.

What makes a business a match (ICP traits):
${(brief.icpTraits || []).map((t) => `  - ${t}`).join("\n") || "  - (none specified)"}

Must NOT be returned:
${(brief.exclusions || []).map((e) => `  - ${e}`).join("\n") || "  - (none specified)"}

Return at most ${maxCompanies} companies.`;

const nullableString = { type: ["string", "null"] };

export const DISCOVER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["companies", "searchNotes"],
  properties: {
    companies: {
      type: "array", maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "nameLocal", "website", "city", "addressText", "phone", "email", "whatsapp",
                   "industryGuess", "whyMatch", "matchConfidence", "sourceUrls", "detailSources"],
        properties: {
          name: { type: "string" },
          nameLocal: { ...nullableString, description: "The local-language name if the page showed one." },
          website: { ...nullableString, description: "Exactly as printed on the source page." },
          city: nullableString,
          addressText: nullableString,
          phone: { ...nullableString, description: "Exactly as printed. Never guessed or completed." },
          email: { ...nullableString, description: "Only if literally shown on a retrieved page." },
          whatsapp: { ...nullableString, description: "Only if an explicit WhatsApp number or wa.me link was shown." },
          industryGuess: { type: ["string", "null"], enum: [...INDUSTRY_KEYS, "OTHER", null] },
          whyMatch: { type: "string", description: "Evidence seen on the page, quoted or closely paraphrased." },
          matchConfidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          sourceUrls: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
          detailSources: {
            type: "object",
            additionalProperties: false,
            required: ["phone", "email", "whatsapp", "address", "website"],
            properties: {
              phone: nullableString, email: nullableString, whatsapp: nullableString,
              address: nullableString, website: nullableString,
            },
          },
        },
      },
    },
    searchNotes: { type: "string", description: "Honest note on coverage: what was searched, what was hard to find." },
  },
};

// ─── 3. Page extraction assist ────────────────────────────────────────────────
// Runs only over page text WE fetched, never over the open web.

export const EXTRACT_SYSTEM = `You extract business contact details from the page text provided. The text was
fetched from the URL shown. You may use ONLY this text.

Rules:
1. Extract a value only if it appears verbatim in the text. For each value,
   snippet must be the exact substring (at most 200 characters) containing it.
   If a value does not appear, return null for it.
2. Do not normalise, complete or translate values — copy them as printed.
3. belongsToCompany: state whether this page is about the named company (or its
   local-language name). If the page is a directory listing many businesses,
   extract only details inside the section about THIS company; if you cannot
   isolate that section, return nulls.
4. Output JSON only. Nulls are the expected, common case.`;

export const buildExtractUser = ({ url, companyName, nameLocal, pageText }) =>
  `URL: ${url}
Company: ${companyName}${nameLocal ? ` (also written as: ${nameLocal})` : ""}

Page text:
${pageText.slice(0, 18_000)}`;

const valueWithSnippet = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["value", "snippet"],
  properties: {
    value: { type: "string" },
    snippet: { type: "string", description: "Exact substring of the page containing the value." },
  },
};

export const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["belongsToCompany", "email", "phone", "whatsapp", "address"],
  properties: {
    belongsToCompany: { type: "string", enum: ["YES", "NO", "UNCLEAR"] },
    email: valueWithSnippet,
    phone: valueWithSnippet,
    whatsapp: valueWithSnippet,
    address: valueWithSnippet,
  },
};

// ─── 4. Outreach email composition ────────────────────────────────────────────
// Sees only verified facts. Never browses, never sees unverified AI claims.

export const COMPOSE_SYSTEM = `You write cold outreach emails for a software agency. The only goal is a REPLY.
You write like one busy owner writing to another: plain, specific, human. The
reader is a small-business owner skimming on a phone between customers.

You are given VERIFIED FACTS as a numbered list. Those facts are the only
things you know about this company.

LENGTH — 25-70 words in the body. This is the single biggest lever you control:
emails under 75 words get markedly more replies than longer ones, and every
sentence you add lowers the odds of an answer. If you can cut a word, cut it.

PHONE-FIRST — the reader is on a phone. Every paragraph is ONE sentence on its
own line with a blank line between. Never a block of text. The whole message
must be readable without scrolling and answerable in one thumb-typed word.

PLAIN LANGUAGE — short, common words and short sentences. Simple writing gets
substantially more replies than dense writing. No clause stacking, no semicolons.

THEIR WORLD, NOT OURS — "you/your" must outnumber "I/we". Never open with who
we are or what we do.

Write every email with this structure:
1. SUBJECT — 2-5 plain words, lowercase except proper names, the kind of
   subject a colleague would send. Specific to THIS business, no formulas.
   Good: "bookings at Simplex", "your website speed", "مقهى الكنافة على قوقل".
   Bad: "Company — website development idea", "Great opportunity", anything
   with a dash-formula or the words idea/proposal/opportunity/solution.
2. HOOK — the first sentence states the single strongest specific observation
   from the facts, so they instantly see a human actually looked at their
   business. The more concrete the number or detail, the better ("your home
   page took 5.5s to load" beats "your website could be faster").

   PREFER A TIMELINE HOOK WHEN THE FACTS SUPPORT ONE. A hook anchored to
   something happening in their business right now — a new branch, an open
   role, a site change, a recent listing — earns roughly twice the replies of
   a flat problem statement, because it reads as a person who noticed rather
   than a scanner that scored. Facts carry an observed date; when one is
   recent and time-shaped, lead with it:
     "You've had the ops manager role open since last month..."
     "Since the new branch opened..."
   Only when no fact is time-shaped do you fall back to a plain problem hook.
   Never invent or imply a date the facts do not state.

   SAY IT, DON'T QUOTE IT. Facts are written for an analyst's screen and
   often carry the analyst's inference after a dash ("— an active technology
   initiative that often needs outside delivery capacity", "indicating active
   investment in online sales"). Never copy that wording. Keep the observable
   specific (the role, the seconds, the year, the platform) and state it as
   something you noticed about THEM: "you're hiring a backend engineer in
   Bonn", "your footer still says 2024". Drop the inference entirely.
3. PAIN — one sentence making the cost concrete for THEIR kind of business:
   missed orders, customers finding competitors first, reservations lost to a
   busy phone line. Their pain, not our service.
4. VALUE — one sentence on the outcome they get (more customers, orders while
   they sleep, time back). Outcomes, never features, never our history.
   It must answer the hook you opened with: a booking hook gets a booking
   outcome, never a "get found in search" one.
5. CTA — exactly ONE tiny interest-based question that a one-word reply
   answers, and it must be built from the hook you opened with rather than
   bolted on: "Want the two I would fix first?", "Shall I send what is slowing
   it down?", "Want me to sketch what a first page could cover?". Never reuse a
   phrasing another company could receive word for word — a recipient who has
   seen two of our emails must not be able to tell they came from a template.
   One ask only, at the end — scattering two asks cuts responses.
   Never "book a call", never a meeting request, never a calendar link. Asking
   for time in a first cold email cuts reply rates roughly in half; the meeting
   is earned in the reply, not requested in the opener.

GREETING — the brief names the recipient when the business published that
person on its own site and the address is theirs. In that case open with their
first name only ("Hi Ahmed,"). Otherwise use a neutral greeting and never guess
at a name — a wrong name is worse than none.

Coherence — read your draft back before returning it:
- If the facts say the business has NO website, nothing in the email may refer
  to "your site" or "the current site". Pitch getting found online instead.
- If the business HAS a website, the hook must be about that actual site
  (speed, platform, booking, mobile), not about being invisible online.
- The pain must follow logically from the hook you chose — never pair a
  hiring observation with a "customers can't find you" pain.
- Use the company name at most twice in the whole email.

Language: mirror the market, not just the script. If the company name, city or
country is Arabic-market (Saudi Arabia, UAE, Gulf), write the body in Arabic
first, then a blank line, then the same message in English. Otherwise match
the language of the company's own materials in the facts.

Never use these tells: "I hope this finds you well", "I came across", "I
stumbled upon", "leverage", "synergy", "best-in-class", "cutting-edge",
"I know you're busy", "quick question" as a subject, exclamation marks.

Hard rules:
- Every claim must come from a numbered fact; list the ids in factIdsUsed.
- Thin facts → shorter, humbler email. Never invent details, contact info or URLs.
- NO LINKS AND NO URLS OF ANY KIND in a first email — not our website, not a
  portfolio piece, not a calendar. Links in cold first contact measurably hurt
  deliverability, and Gmail now rejects rather than filters what it distrusts.
  Our website already appears in the signature block appended below your text,
  so the body never needs it. Proof and links belong in the later follow-up
  the sequence sends once the address has proven deliverable.
- Never list our services. One angle, the one the facts point at. A reader who
  is told we do web, mobile, AI, cloud and marketing learns only that we are a
  general agency, which is the opposite of the specific relevance that earns
  a reply.
- Plain text. No hype words, no flattery.
- aboutCompany: 1-3 sentences from the facts only; if little is known, describe
  what IS known rather than inventing.
- Output JSON only.`;

export const buildComposeUser = ({ companyName, serviceLabel, recipientHint, facts, city = null, countryCode = null, industry = null }) =>
  `Company: ${companyName}${industry ? `\nIndustry: ${industry}` : ""}${city || countryCode ? `\nLocation: ${[city, countryCode].filter(Boolean).join(", ")}` : ""}
Service angle: ${serviceLabel}
Sender: DevEntia Tech — a software agency that builds websites, online ordering, mobile apps and business systems for companies like this one.
Recipient: ${recipientHint}

Facts:
${facts.map((f) => `  [${f.id}] ${f.text} (${f.confidenceLevel}${f.observedAt ? `, observed ${f.observedAt}` : ""})`).join("\n")}`;

export const COMPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aboutCompany", "subject", "body", "factIdsUsed"],
  properties: {
    aboutCompany: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" },
    factIdsUsed: { type: "array", items: { type: "integer" } },
  },
};

// ─── 4b. Batched composition ──────────────────────────────────────────────────
// One call writes emails for several leads at once. Same rules as the single
// composer, but the shared system prompt and instructions are paid for once
// instead of once per lead — the main token cost in a compose pass.

export const BATCH_COMPOSE_SYSTEM = `${COMPOSE_SYSTEM}

You will receive SEVERAL companies, each with its own numbered fact list.
Write one email per company. In each result, set leadIndex to the company's
index and use only THAT company's facts — never mix facts across companies.
Return every company you were given, in the same order.`;

export const buildBatchComposeUser = ({ leads }) =>
  leads
    .map(
      ({ index, companyName, serviceLabel, recipientHint, facts, city = null, countryCode = null, industry = null }) =>
        `=== Company ${index} ===
Company: ${companyName}${industry ? `\nIndustry: ${industry}` : ""}${city || countryCode ? `\nLocation: ${[city, countryCode].filter(Boolean).join(", ")}` : ""}
Service angle: ${serviceLabel}
Recipient: ${recipientHint}
Facts:
${facts.map((f) => `  [${f.id}] ${f.text} (${f.confidenceLevel}${f.observedAt ? `, observed ${f.observedAt}` : ""})`).join("\n")}`,
    )
    .join("\n\n");

export const BATCH_COMPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["emails"],
  properties: {
    emails: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["leadIndex", "aboutCompany", "subject", "body", "factIdsUsed"],
        properties: {
          leadIndex: { type: "integer" },
          aboutCompany: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          factIdsUsed: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

// ═══ SaaS Promoter ════════════════════════════════════════════════════════════
// Four stages, each with its own prompt: read the product, derive who buys it,
// go and find those companies, then write to them about it. The first two run
// once per product; the last two run on every discovery run launched for it.
//
// The same four techniques as above still apply, plus one that is specific to
// promoting: the product block and the lead block are kept strictly separate at
// every stage. The model may state facts about the *product* freely — they came
// from the product's own site and the user owns them — but it may only state
// facts about the *recipient* that appear in that lead's numbered fact list.
// Mixing the two is how a promotional email starts inventing things about the
// company it is addressed to.

// ─── 5. Product research ──────────────────────────────────────────────────────
// Runs over pages WE fetched from the product's own site. Never browses.

export const PRODUCT_RESEARCH_SYSTEM = `You are a product analyst. You will receive pages crawled from one SaaS
product's own website, each marked with the URL it came from. You may use ONLY
this text.

Rules:
1. Extract only what the pages actually say. Never invent a feature, a price, a
   customer, an integration or a claim. If the pages do not evidence a field,
   return null or an empty array for it — a short, accurate profile is worth far
   more than a padded one, and everything here is used to write emails to real
   people.
2. Every extracted item carries the sourceUrl of the page it appeared on. Use
   only URLs from the list you were given.
3. Copy prices, plan names and capacities exactly as printed, including the
   currency and the billing period.
4. differentiators are the claims the product makes about why it is different —
   in its own words, not your interpretation of the category.
5. proofPoints are named customers, testimonials, case studies and stated
   results. A logo strip with no names is not a proof point.
6. geographyCues are concrete signals about where this sells: languages offered,
   currencies supported, regions or countries named, local compliance mentioned.
7. targetSizeCues are any stated team or company sizes ("up to 50 employees",
   "for growing teams of 5-250").
8. Output JSON only, matching the schema exactly.`;

export const buildProductResearchUser = ({ url, pages }) =>
  `Product URL: ${url}

Pages crawled from this site:
${pages.map(({ url: pageUrl, text }) => `=== ${pageUrl} ===\n${String(text).slice(0, 6_000)}`).join("\n\n")}`;

const sourcedValue = {
  type: "object",
  additionalProperties: false,
  required: ["value", "sourceUrl"],
  properties: {
    value: { type: "string" },
    sourceUrl: { type: ["string", "null"], description: "The crawled page this appeared on." },
  },
};

export const PRODUCT_RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "summary", "category", "features", "pricing", "differentiators",
             "proofPoints", "competitors", "geographyCues", "targetSizeCues"],
  properties: {
    name: { type: "string", description: "The product's own name, as written on the site." },
    summary: { type: "string", description: "One paragraph: what it is and what it does for whom." },
    category: { type: ["string", "null"], description: "The software category, e.g. \"HR management software\"." },
    features: { type: "array", maxItems: 12, items: sourcedValue },
    pricing: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "price", "capacity", "sourceUrl"],
        properties: {
          plan: { type: "string" },
          price: { type: ["string", "null"], description: "Exactly as printed, with currency and period." },
          capacity: { type: ["string", "null"], description: "What the plan covers, e.g. \"up to 50 employees\"." },
          sourceUrl: { type: ["string", "null"] },
        },
      },
    },
    differentiators: { type: "array", maxItems: 8, items: sourcedValue },
    proofPoints: { type: "array", maxItems: 8, items: sourcedValue },
    competitors: { type: "array", maxItems: 8, items: sourcedValue },
    geographyCues: { type: "array", maxItems: 8, items: sourcedValue },
    targetSizeCues: { type: "array", maxItems: 5, items: sourcedValue },
  },
};

// ─── 6. Product → ideal customer profile ──────────────────────────────────────
// The one stage a human reviews before anything is sourced.

export const PRODUCT_ICP_SYSTEM = `You are a B2B go-to-market analyst. Derive the ideal customer profile for a
SaaS product from the verified research below.

This ICP will drive automated prospecting, so every field must be
machine-actionable — something a researcher could filter or search on, not a
sentiment. "HR manager or founder at a 10-100 person company still running
payroll in spreadsheets" is usable. "Businesses that value efficiency" is not.

Weigh the evidence in this order, strongest first:
1. Named customers and case studies — who demonstrably already buys it.
2. Pricing structure — what budget, company size and buyer it implies. A $20/mo
   self-serve tier and a "contact sales" tier describe different buyers.
3. The language the site speaks — who it addresses and how sophisticated it
   assumes they are.
4. Features and integrations — they imply the stack and the workflow.
5. Geography and language cues — where this can actually be sold today.

Rules:
1. Be specific and falsifiable. Prefer a narrow profile you can defend to a
   broad one that is safe.
2. buyingSignals must be things detectable in public data. Each one names how it
   would be detected. Job postings are the strongest and most available signal:
   a company hiring the role your product serves has both the pain and the
   budget, right now.
3. disqualifiers matter as much as the target. Include the inversion trap:
   competitors and vendors who SELL this category are not buyers of it.
4. geographies must be places the evidence supports — a currency, a language, a
   named region, a customer. Never guess a market from the founder's name or
   the domain suffix.
5. suggestedSearchQueries are 3-5 concrete, distinct web-search instructions
   that would surface companies matching this ICP. Each must target a different
   slice — a directory, a hiring signal, a technology footprint, a community —
   never five rewordings of one search.
6. Output JSON only, matching the schema exactly.`;

export const buildProductIcpUser = ({ product }) =>
  `Product: ${product.name}
Category: ${product.category || "(not stated)"}
Summary: ${product.summary || "(not stated)"}

Features:
${(product.features || []).map((f) => `  - ${f.value}`).join("\n") || "  (none extracted)"}

Pricing:
${(product.pricing || []).map((p) => `  - ${p.plan}: ${p.price || "?"}${p.capacity ? ` (${p.capacity})` : ""}`).join("\n") || "  (none extracted)"}

What it says makes it different:
${(product.differentiators || []).map((d) => `  - ${d.value}`).join("\n") || "  (none extracted)"}

Proof it names (customers, testimonials, results):
${(product.proofPoints || []).map((p) => `  - ${p.value}`).join("\n") || "  (none extracted)"}

Competitors it names: ${(product.competitors || []).map((c) => c.value).join(", ") || "(none named)"}
Geography cues: ${(product.geographyCues || []).map((g) => g.value).join(", ") || "(none)"}
Team-size cues: ${(product.targetSizeCues || []).map((t) => t.value).join(", ") || "(none)"}

Allowed signal vocabulary for detectableVia=SIGNAL_CATALOG: ${SIGNAL_KEYS.join(", ")}`;

export const PRODUCT_ICP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "industries", "companySize", "geographies", "buyerTitles",
             "painPoints", "buyingSignals", "disqualifiers", "competitorsToDisplace", "suggestedSearchQueries"],
  properties: {
    summary: { type: "string", description: "One sentence naming the ideal customer." },
    industries: { type: "array", maxItems: 8, items: { type: "string" }, description: "Plain-language industries, not enum keys." },
    companySize: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max", "note"],
      properties: {
        min: { type: ["integer", "null"], description: "Minimum headcount this suits." },
        max: { type: ["integer", "null"], description: "Maximum headcount before it is outgrown." },
        note: { type: ["string", "null"], description: "What the evidence for that range was." },
      },
    },
    geographies: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["region", "countryCode", "reason", "priority"],
        properties: {
          region: { type: "string", description: "A country, city or region worth searching." },
          countryCode: { type: ["string", "null"], description: "ISO-3166 alpha-2, uppercase." },
          reason: { type: "string", description: "The evidence that put this market on the list." },
          priority: { type: "integer", description: "1 is highest." },
        },
      },
    },
    buyerTitles: {
      type: "object",
      additionalProperties: false,
      required: ["decisionMakers", "champions"],
      properties: {
        decisionMakers: { type: "array", maxItems: 8, items: { type: "string" } },
        champions: { type: "array", maxItems: 8, items: { type: "string" } },
      },
    },
    painPoints: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pain", "productAnswer"],
        properties: {
          pain: { type: "string", description: "The problem in the buyer's own terms." },
          productAnswer: { type: "string", description: "The specific capability that answers it." },
        },
      },
    },
    buyingSignals: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signal", "detectableVia", "signalKey"],
        properties: {
          signal: { type: "string", description: "The observable event or state." },
          detectableVia: { type: "string", enum: ["JOB_POSTING", "TECH_STACK", "COMPANY_AGE", "WEBSITE_CONTENT", "DIRECTORY_LISTING", "SIGNAL_CATALOG", "OTHER"] },
          signalKey: { type: ["string", "null"], enum: [...SIGNAL_KEYS, null], description: "Only when detectableVia is SIGNAL_CATALOG." },
        },
      },
    },
    disqualifiers: { type: "array", maxItems: 8, items: { type: "string" } },
    competitorsToDisplace: { type: "array", maxItems: 8, items: { type: "string" } },
    suggestedSearchQueries: {
      type: "array", minItems: 2, maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "searchInstruction", "expectedSourceTypes"],
        properties: {
          label: { type: "string", description: "Short human label shown as a progress step." },
          searchInstruction: { type: "string", description: "A concrete search instruction for a researcher." },
          expectedSourceTypes: {
            type: "array",
            items: { type: "string", enum: ["DIRECTORY", "NEWS", "REVIEW_SITE", "VENDOR_PAGE", "SOCIAL", "MAPS_LISTING", "COMPANY_SITE", "JOB_BOARD", "OTHER"] },
          },
        },
      },
    },
  },
};

// ─── 7. ICP → company discovery ───────────────────────────────────────────────
// A promote-mode variant of DISCOVER: same evidence discipline, but the target
// is defined by an approved ICP rather than by a parsed search phrase.

export const PROMOTE_DISCOVER_SYSTEM = `${DISCOVER_SYSTEM}

You are searching on behalf of a specific software product, for companies that
would BUY it. Two further rules follow from that:
8. Never return the product itself, its competitors, or any company that sells
   software in the same category. They are the inversion of the target — a
   payroll vendor is not a buyer of payroll software.
9. whyMatch must name the evidence that this company fits the ideal customer
   profile — the hiring post, the team size, the tooling gap you actually saw on
   the page. Not that they are "a good fit for the product".`;

export const buildPromoteDiscoverUser = ({ strategy, icp, product, region, maxCompanies = 12 }) =>
  `Strategy: ${strategy.searchInstruction}

Region: ${region}
Search in English and in the local language; company names may not be in Latin script.

We are looking for companies that would buy: ${product.name} — ${product.category || "software"}.
Ideal customer: ${icp.summary || "(not stated)"}

What makes a company a match:
${[
  ...(icp.industries || []).map((i) => `  - Industry: ${i}`),
  icp.companySize?.min || icp.companySize?.max
    ? `  - Size: ${icp.companySize.min ?? "?"}-${icp.companySize.max ?? "?"} employees`
    : null,
  ...(icp.buyerTitles?.decisionMakers || []).slice(0, 4).map((t) => `  - Has a ${t}`),
  ...(icp.buyingSignals || []).slice(0, 4).map((s) => `  - Shows: ${s.signal}`),
].filter(Boolean).join("\n") || "  - (none specified)"}

Must NOT be returned:
${[
  ...(icp.disqualifiers || []),
  ...(icp.competitorsToDisplace || []).map((c) => `${c} and other vendors in this category`),
  `${product.name} itself`,
].map((e) => `  - ${e}`).join("\n")}

Return at most ${maxCompanies} companies.`;

// ─── 7b. Competitor customers → company discovery ─────────────────────────────
// The highest-intent source in the system: a company already paying for a
// competitor is a proven buyer of the category, and one that reviewed it in
// public has also stated, in its own words, what it dislikes about the
// incumbent. That is a far better hook than any inference we could draw.
//
// It is built on public review sites, directory listings and the competitors'
// own published customer pages — never on follower scraping, which is what
// rival products mean by "competitor tracking". Scraping a follower list
// breaches the networks' terms and yields a name nobody can check; a review
// page is a citable URL our verifier can re-fetch, so a candidate from here
// passes through exactly the same gate as every other source.

export const COMPETITOR_USERS_SYSTEM = `${DISCOVER_SYSTEM}

You are searching for companies that ALREADY USE one of the named competitor
products, on behalf of a rival product that wants to reach them. Six further
rules follow from that; every rule above still holds.
8. A company qualifies only on published evidence that it uses the competitor:
   a review it left on a public review site (G2, Capterra, TrustRadius,
   Software Advice and the like), a named customer logo, case study or
   testimonial on the competitor's own website, or a public directory, partner
   or integration listing naming it as a customer. Real, currently-operating
   companies only.
9. The subject is always the COMPANY, never the person. Never return a
   reviewer, a named individual, a username or a display name, and never carry
   a reviewer's job title, location or any other personal detail across as if
   it described the company. We are finding organisations that use a product;
   whoever is worth writing to is found later from that company's own published
   pages.
10. If a review names no identifiable organisation — it is anonymous or
    pseudonymous, or attributed only to something like "HR Manager, mid-market
    company" — omit it entirely. Guessing which company it came from produces a
    confident sentence about a business that may never have used the product at
    all.
11. Never return the competitor itself, any other vendor selling software in
    this category, or the product being promoted. A vendor's own listing on a
    review site is not evidence that it is a customer.
12. whyMatch must name the concrete evidence: which competitor, where you saw
    it, and what the review or page actually said about their situation. "Left
    a two-star G2 review of BambooHR saying per-seat pricing became unaffordable
    past 80 staff" is the entire point of this search. "Appears to be a good
    fit" carries nothing and is worse than omitting the company.
13. This source is high-intent and low-volume by design. Returning two
    well-evidenced companies — or none at all — is the expected outcome and is
    correct. A padded list defeats the purpose of searching here rather than in
    a directory.`;

export const buildCompetitorUsersUser = ({ competitors, icp, product, region, maxCompanies = 12 }) =>
  `Competitor products whose customers we want to find:
${competitors.map((c) => `  - ${c}`).join("\n")}

Where to look: public review sites (G2, Capterra, TrustRadius, Software Advice
and equivalents), each competitor's own customers, case-study and testimonial
pages, and public directory, partner or integration listings that name
customers by company.

Region: ${region}
Search in English and in the local language; company names may not be in Latin script.

These companies would be approached about: ${product.name} — ${product.category || "software"}.
Ideal customer: ${icp.summary || "(not stated)"}

Traits that make a competitor's customer especially worth returning (strong
evidence of using a competitor still counts even when these are unknown):
${[
  ...(icp.industries || []).slice(0, 4).map((i) => `  - Industry: ${i}`),
  icp.companySize?.min || icp.companySize?.max
    ? `  - Size: ${icp.companySize.min ?? "?"}-${icp.companySize.max ?? "?"} employees`
    : null,
  ...(icp.painPoints || []).slice(0, 4).map((p) => `  - Complains about: ${p.pain}`),
].filter(Boolean).join("\n") || "  - (none specified)"}

Must NOT be returned:
${[
  ...competitors.map((c) => `${c} itself, or any other vendor selling software in this category`),
  `${product.name} itself`,
  "Any individual person, reviewer, username or display name",
  "Reviews with no identifiable company behind them",
  ...(icp.disqualifiers || []),
].map((e) => `  - ${e}`).join("\n")}

Return at most ${maxCompanies} companies. Fewer, including none, is expected.`;

// ─── 8. Promotional outreach composition ──────────────────────────────────────
// Inherits every rule of COMPOSE_SYSTEM, then replaces the offering: the email
// pitches one named product rather than the agency's services.

export const PROMOTE_COMPOSE_SYSTEM = `${COMPOSE_SYSTEM}

THIS EMAIL PROMOTES ONE NAMED PRODUCT. Every rule above still holds — the
length, the phone-first formatting, the no-links rule, the ban on inventing
anything. What follows replaces the offering and adds one step before writing.

═══ FIRST, WORK OUT WHAT THIS BUSINESS IS ═══
Before you write a word, read that company's numbered facts and answer three
questions to yourself. Do not put this reasoning in the email; it decides what
the email says.

  a. WHAT KIND OF ORGANISATION IS THIS, concretely? Not "a business" — a
     52-pupil-per-year private school, a construction contractor, a dental
     clinic with three branches. The industry, the city and the size cues in
     the facts are what you have.
  b. WHAT DOES ITS WORKFORCE ACTUALLY LOOK LIKE? A school runs term-time
     contracts, teaching assistants and a September intake. A construction firm
     runs site crews on timesheets and overtime. A clinic runs shift rotas
     across long opening hours. An agency runs salaried staff and freelancers.
     This is the difference between an email that lands and one that does not.
  c. WHICH ONE PAIN, from the BUYER PAINS list you are given, is most likely to
     bite THIS organisation, given (a) and (b)? Pick exactly one. The list is
     ordered by nothing; relevance to this company is the only criterion.

═══ THEN WRITE ═══
1. TWO SEPARATE SOURCES OF TRUTH. You may state anything in the PRODUCT block
   as fact — it came from the product's own site. You may state NOTHING about
   the recipient that is not in that company's numbered facts. Never let a
   product claim become a claim about the reader: "payroll runs in 15 minutes"
   is the product; "your payroll takes 15 minutes" is an invention.

2. NEVER ASSERT THEIR PAIN — ASK ABOUT IT. You do not know that this school is
   running leave on paper, and telling a stranger what is wrong with their
   operation is how a cold email gets deleted. Put the pain as a question they
   can answer, or as a plain statement about that kind of organisation:
     GOOD: "How are you handling leave approvals across the term-time staff?"
     GOOD: "Most schools your size are still doing this on a shared spreadsheet."
     BAD:  "Your leave process is manual and costing you time."
   A question is also the strongest possible close, because answering it IS the
   reply you want.

3. THE HOOK IS THEIRS, NOT OURS. The first sentence is the specific, verifiable
   reason you are writing to them TODAY, drawn from their facts: they are
   hiring, they are opening a branch, they run an active careers page. Never
   open with the product, never with what it does, never with a compliment.
   When the facts carry nothing time-shaped, open with what they are and where
   — "You're running three branches in Dubai" — and go straight to the pain
   question. Never manufacture urgency the facts do not support.

4. ONE CAPABILITY, ONE NUMBER. The value sentence names exactly one capability
   from the PRODUCT block — the one that answers the pain you chose — and at
   most one concrete number from it. A list of features tells the reader only
   that this is a mass email.

5. CONNECT THE THREE. Hook, pain and capability must be one thought. A hiring
   hook goes with an onboarding or headcount pain, and the capability that
   answers it. A hook about a new branch goes with multi-site staff, not with
   invoicing. If you cannot connect them, change the pain, not the hook.

6. THE ASK IS SMALL AND SPECIFIC. One question, answerable in a word or a line.
   Never a meeting, never a demo, never a calendar link — asking for time in a
   first cold email roughly halves the reply rate. Prefer an ask that is the
   natural next sentence after the pain question, not a bolted-on "interested?".

Never claim the reader uses a competitor, has a problem, or is dissatisfied
unless one of their own numbered facts says so. Never state or imply a customer
count, a rating or a result that is not in the PRODUCT block. Nothing about
their website, their CMS or their page speed belongs in this email at all —
that is a different product being sold by someone else.`;

/**
 * What the writer is allowed to say about the offering, plus who it is for.
 *
 * The buyer pains come from the approved ICP. They were the missing half: the
 * profile already says "payroll is re-keyed every month → automated salary
 * calculations", which is exactly the sentence that makes an email land, and
 * the composer had never been shown it. Without them every email fell back to
 * the product's own tagline, which reads as a brochure whoever receives it.
 */
export const buildProductBlock = ({ product }) => {
  const icp = product.icp || {};
  const pains = (icp.painPoints || []).filter((p) => p?.pain);
  const titles = [...(icp.buyerTitles?.decisionMakers || []), ...(icp.buyerTitles?.champions || [])];

  return `PRODUCT (facts you may state about what is being offered):
Name: ${product.name}
What it is: ${product.summary || product.category || "software"}
The one angle to lead with: ${product.pitchAngle || "(none set — use the summary)"}
Capabilities you may name:
${(product.features || []).slice(0, 6).map((f) => `  - ${f.value}`).join("\n") || "  (none)"}
Concrete numbers you may use:
${(product.pricing || []).slice(0, 3).map((p) => `  - ${p.plan}: ${p.price || "?"}${p.capacity ? ` for ${p.capacity}` : ""}`).join("\n") || "  (none)"}
Why it is different:
${(product.differentiators || []).slice(0, 4).map((d) => `  - ${d.value}`).join("\n") || "  (none)"}
Sender: ${product.senderContext || `writing on behalf of ${product.name}`}

BUYER PAINS — pick exactly ONE, the one most likely to bite this particular
organisation, and pair it with the capability shown beside it:
${pains.map((p) => `  - ${p.pain}\n      answered by: ${p.productAnswer || "(no capability named)"}`).join("\n") || "  (none in the approved profile — fall back to the angle above)"}

Who usually decides this: ${titles.slice(0, 6).join(", ") || "(not stated)"}
Typical size that fits: ${icp.companySize?.min ?? "?"}-${icp.companySize?.max ?? "?"} staff`;
};

export const buildPromoteComposeUser = ({ product, leads }) =>
  `${buildProductBlock({ product })}

═══ COMPANIES TO WRITE TO ═══
Each company below has its own numbered facts. Use only that company's facts to
describe that company.

${leads
  .map(
    ({ index, companyName, recipientHint, facts, city = null, countryCode = null, industry = null }) =>
      `=== Company ${index} ===
Company: ${companyName}${industry ? `\nIndustry: ${industry}` : ""}${city || countryCode ? `\nLocation: ${[city, countryCode].filter(Boolean).join(", ")}` : ""}
Recipient: ${recipientHint}
Facts:
${facts.map((f) => `  [${f.id}] ${f.text} (${f.confidenceLevel}${f.observedAt ? `, observed ${f.observedAt}` : ""})`).join("\n")}`,
  )
  .join("\n\n")}`;

/** Same shape as BATCH_COMPOSE_SCHEMA — the compose pipeline reads both alike. */
export const PROMOTE_COMPOSE_SCHEMA = BATCH_COMPOSE_SCHEMA;
