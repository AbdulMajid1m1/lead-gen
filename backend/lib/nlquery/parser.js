import {
  INDUSTRY_TERMS, SIGNAL_TERMS, HIRING_ROLE_TERMS, TECH_TERMS, SERVICE_TERMS,
  TIMEFRAME_TERMS, SIZE_TERMS, LOCATION_PREPOSITIONS, STOPWORDS, industryLabel,
} from "./lexicon.js";

/**
 * Deterministic natural-language query parser.
 *
 * This always runs, with or without an LLM. It produces a `StructuredQuery`
 * plus a list of `chips` — the human-readable interpretation shown back to the
 * user so "how did it understand me?" is never a mystery, and each chip can be
 * removed to correct the query.
 *
 * Strategy: consume the input longest-phrase-first, blanking each match as it
 * is recognised. Whatever survives after every known term is removed is the
 * candidate location, which is why place names never need to be enumerated.
 */

const normalize = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\-.\s]/g, " ")
    // Fold the ways people express absence onto the single form the lexicon
    // stores ("no X"), so "without online booking" and "doesn't have a website"
    // both reach the same entry.
    .replace(/\b(?:without|lacking|missing)\s+(?:a|an|any)?\s*/g, "no ")
    .replace(/\b(?:does\s*n[o']?t|do\s*n[o']?t|don't|doesn't)\s+have\s+(?:a|an|any)?\s*/g, "no ")
    .replace(/\bno\s+(?:a|an|any)\s+/g, "no ")
    .replace(/\s+/g, " ")
    .trim();

/** Replace a phrase with spaces so positions stay stable for later matches. */
const blank = (haystack, phrase) => {
  const re = new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "g");
  return haystack.replace(re, (m) => " ".repeat(m.length));
};

const findPhrase = (haystack, phrase) =>
  new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(haystack);

export const parseQuery = (rawText) => {
  const original = String(rawText || "").trim();
  let text = ` ${normalize(original)} `;

  const chips = [];
  const query = {
    industries: [],
    location: null,
    signals: [],
    technologies: [],
    excludeTechnologies: [],
    service: null,
    jobTitleContains: [],
    postedWithinDays: null,
    sizeBucket: null,
    minScore: null,
    freeText: [],
  };

  const addChip = (kind, label, value) => chips.push({ kind, label, value });

  // ─── Hiring roles (before generic signals — "hiring CRM specialists" is more
  //     specific than "hiring") ─────────────────────────────────────────────
  for (const entry of HIRING_ROLE_TERMS) {
    for (const phrase of [...entry.phrases].sort((a, b) => b.length - a.length)) {
      if (!findPhrase(text, phrase)) continue;
      if (!query.signals.includes(entry.signal)) query.signals.push(entry.signal);
      query.jobTitleContains.push(...entry.titleContains);
      addChip("HIRING", `hiring ${entry.label}`, entry.signal);
      text = blank(text, phrase);
      break;
    }
  }

  // ─── Signals ────────────────────────────────────────────────────────────────
  for (const entry of SIGNAL_TERMS) {
    for (const phrase of [...entry.phrases].sort((a, b) => b.length - a.length)) {
      if (!findPhrase(text, phrase)) continue;
      // A generic "hiring" adds nothing once a specific role was matched.
      const alreadySpecific = entry.label === "actively hiring" && query.jobTitleContains.length > 0;
      if (!alreadySpecific) {
        for (const s of entry.signals) if (!query.signals.includes(s)) query.signals.push(s);
        addChip("SIGNAL", entry.label, entry.signals);
      }
      text = blank(text, phrase);
      break;
    }
  }

  // ─── Technologies (support "not on wordpress" / "without shopify") ──────────
  for (const [phrase, name] of [...TECH_TERMS].sort((a, b) => b[0].length - a[0].length)) {
    if (!findPhrase(text, phrase)) continue;
    const negated = new RegExp(`(?:not|without|no|non)\\s+(?:on\\s+|using\\s+)?${phrase}`).test(text);
    if (negated) {
      query.excludeTechnologies.push(name);
      addChip("TECH_EXCLUDE", `not on ${name}`, name);
    } else {
      query.technologies.push(name);
      addChip("TECH", name, name);
    }
    text = blank(text, phrase);
  }

  // ─── Service intent ─────────────────────────────────────────────────────────
  for (const entry of SERVICE_TERMS) {
    if (query.service) break;
    for (const phrase of [...entry.phrases].sort((a, b) => b.length - a.length)) {
      if (!findPhrase(text, phrase)) continue;
      query.service = entry.service;
      addChip("SERVICE", `needs ${entry.label}`, entry.service);
      text = blank(text, phrase);
      break;
    }
  }

  // ─── Timeframe ──────────────────────────────────────────────────────────────
  for (const entry of TIMEFRAME_TERMS) {
    if (query.postedWithinDays) break;
    for (const phrase of [...entry.phrases].sort((a, b) => b.length - a.length)) {
      if (!findPhrase(text, phrase)) continue;
      query.postedWithinDays = entry.days;
      addChip("TIMEFRAME", entry.label, entry.days);
      text = blank(text, phrase);
      break;
    }
  }
  const explicitDays = /\blast (\d{1,3}) days?\b/.exec(text);
  if (explicitDays) {
    query.postedWithinDays = Number(explicitDays[1]);
    addChip("TIMEFRAME", `last ${explicitDays[1]} days`, query.postedWithinDays);
    text = blank(text, explicitDays[0].trim());
  }

  // ─── Size ───────────────────────────────────────────────────────────────────
  for (const entry of SIZE_TERMS) {
    if (query.sizeBucket) break;
    for (const phrase of [...entry.phrases].sort((a, b) => b.length - a.length)) {
      if (!findPhrase(text, phrase)) continue;
      query.sizeBucket = entry.size;
      addChip("SIZE", entry.label, entry.size);
      text = blank(text, phrase);
      break;
    }
  }

  // ─── Industry ───────────────────────────────────────────────────────────────
  for (const [phrase, key] of [...INDUSTRY_TERMS].sort((a, b) => b[0].length - a[0].length)) {
    if (!findPhrase(text, phrase)) continue;
    if (!query.industries.includes(key)) {
      query.industries.push(key);
      addChip("INDUSTRY", industryLabel(key), key);
    }
    text = blank(text, phrase);
  }

  // ─── Minimum score ──────────────────────────────────────────────────────────
  const scoreMatch = /\bscore (?:above|over|greater than|higher than|>)\s*(\d{1,3})\b/.exec(text);
  if (scoreMatch) {
    query.minScore = Math.min(100, Number(scoreMatch[1]));
    addChip("SCORE", `score above ${query.minScore}`, query.minScore);
    text = blank(text, scoreMatch[0].trim());
  }

  // ─── Location: whatever remains after a preposition ─────────────────────────
  // Everything recognised above has been blanked out, so a run of surviving
  // words following "in"/"near" is almost certainly a place name.
  const remaining = text.replace(/\s+/g, " ").trim();
  const tokens = remaining.split(" ").filter(Boolean);

  // A place name is a *contiguous* run of unrecognised words. Taking tokens
  // until the first stopword (rather than filtering stopwords out) is what
  // stops "in London without online booking" becoming "London Online Booking".
  //
  // Some connectives aren't in STOPWORDS but still end a place name — "in
  // Saudi Arabia related to POS" must yield "Saudi Arabia", never "Saudi
  // Arabia Related".
  const LOCATION_TERMINATORS = new Set([
    "related", "regarding", "concerning", "about", "needing", "wanting",
    "using", "offering", "selling", "that", "which", "who", "whose", "where",
  ]);
  const endsLocation = (t) =>
    STOPWORDS.has(t) || LOCATION_PREPOSITIONS.includes(t) || LOCATION_TERMINATORS.has(t);

  const takeUntilStopword = (list) => {
    const out = [];
    for (const t of list) {
      if (endsLocation(t)) break;
      out.push(t);
    }
    return out;
  };

  let locationTokens = [];
  const prepIndex = tokens.findIndex((t) => LOCATION_PREPOSITIONS.includes(t));
  if (prepIndex !== -1) {
    locationTokens = takeUntilStopword(tokens.slice(prepIndex + 1));
  } else {
    // No preposition: people type "Dubai restaurants" as often as
    // "restaurants in Dubai", so the longest surviving run is the candidate.
    let best = [];
    let current = [];
    for (const t of [...tokens, " "]) {
      if (endsLocation(t) || t === " ") {
        if (current.length > best.length) best = current;
        current = [];
      } else {
        current.push(t);
      }
    }
    locationTokens = best;
  }

  // Places are rarely more than four words; anything longer is leftover prose.
  if (locationTokens.length > 4) locationTokens = [];

  const locationPhrase = locationTokens.join(" ").trim();
  if (locationPhrase && locationPhrase.length >= 2 && /[a-z]/.test(locationPhrase)) {
    query.location = { name: titleCase(locationPhrase), raw: locationPhrase };
    addChip("LOCATION", query.location.name, locationPhrase);
  }

  // Anything still unclaimed is kept for keyword matching against company names.
  const leftovers = tokens.filter((t) => !locationTokens.includes(t) && !endsLocation(t));
  query.freeText = leftovers;

  return {
    query,
    chips,
    parserUsed: "DETERMINISTIC",
    // Confidence reflects how much of the query we actually understood — used
    // to decide whether the LLM parser is worth consulting.
    confidence: scoreConfidence(query, chips, original),
    unparsed: leftovers,
  };
};

/** 0–1: how completely the input was recognised. */
const scoreConfidence = (query, chips, original) => {
  if (!original) return 0;
  let score = 0;
  if (query.industries.length) score += 0.35;
  if (query.location) score += 0.3;
  if (query.signals.length) score += 0.25;
  if (query.service) score += 0.05;
  if (query.technologies.length) score += 0.05;
  if (chips.length === 0) return 0;
  return Math.min(1, score);
};

const titleCase = (s) =>
  s.split(" ").map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** One-sentence restatement of the query, shown above the results. */
export const describeQuery = ({ query, chips }) => {
  const parts = [];
  parts.push(query.industries.length ? query.industries.map(industryLabel).join(" and ") : "Businesses");
  if (query.location) parts.push(`in ${query.location.name}`);
  const signalChips = chips.filter((c) => c.kind === "SIGNAL" || c.kind === "HIRING").map((c) => c.label);
  if (signalChips.length) parts.push(`with ${signalChips.join(", ")}`);
  if (query.technologies.length) parts.push(`using ${query.technologies.join(", ")}`);
  if (query.postedWithinDays) parts.push(`updated in the last ${query.postedWithinDays} days`);
  return parts.join(" ");
};
