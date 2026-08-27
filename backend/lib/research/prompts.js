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
export const PROMPT_VERSION = "1.0.0";

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
3. PAIN — one sentence making the cost concrete for THEIR kind of business:
   missed orders, customers finding competitors first, reservations lost to a
   busy phone line. Their pain, not our service.
4. VALUE — one sentence on the outcome they get (more customers, orders while
   they sleep, time back). Outcomes, never features, never our history.
   It must answer the hook you opened with: a booking hook gets a booking
   outcome, never a "get found in search" one.
5. CTA — exactly ONE tiny interest-based question that a one-word reply
   answers, e.g. "Want me to send 2-3 specific ideas? A one-word reply is
   enough." One ask only, at the end — scattering two asks cuts responses.
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
