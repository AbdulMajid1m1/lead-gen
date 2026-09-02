/**
 * Businesses this agency does not work with, on principle.
 *
 * The lines of trade below are excluded from the whole pipeline — sourcing,
 * scoring, drafting and sending — regardless of how well a company would
 * otherwise score. The list is deliberately about what a business *sells*,
 * not who runs it: a restaurant that happens to hold a licence is a
 * restaurant, while a "Sports Bar & Grill", a brewery or a betting shop trades
 * in the excluded thing itself and is out.
 *
 * Three layers, strongest first, each pure and unit-tested:
 *
 *   1. OSM / catalogue tags — `amenity=bar` is an unambiguous statement.
 *   2. The business name — "Koko's Beer Hall", "Ladbrokes", "Tia Maria Bar".
 *   3. Its own description — the meta description the crawler stored.
 *
 * Everything matches on word boundaries. The naive version of this ("does the
 * name contain `bar`") flagged every barber, Barnard Marcus and Birmingham in
 * the database, so the word list below is specific and the ambiguous English
 * word "bar" is only trusted when it is not "juice bar", "sushi bar", "nail
 * bar" and the other trades that borrowed the word without the drink.
 */

/** The catalogue of what is excluded, by category. */
export const EXCLUDED_CATEGORY_LABELS = {
  ALCOHOL: "alcohol (bars, pubs, breweries, wineries, distilleries, liquor stores, nightclubs)",
  GAMBLING: "gambling (casinos, betting, bookmakers, lotteries, bingo, slot arcades)",
  ADULT: "adult entertainment",
  TOBACCO: "tobacco, vaping and shisha",
  PORK: "pork products",
  CANNABIS: "cannabis and CBD",
  INTEREST_LENDING: "payday and pawn lending",
};

/** Raw OpenStreetMap tags that settle the question on their own. */
export const EXCLUDED_OSM_TAGS = new Map([
  ["amenity=bar", "ALCOHOL"], ["amenity=pub", "ALCOHOL"], ["amenity=biergarten", "ALCOHOL"],
  ["amenity=nightclub", "ALCOHOL"], ["shop=alcohol", "ALCOHOL"], ["shop=wine", "ALCOHOL"],
  ["craft=brewery", "ALCOHOL"], ["craft=winery", "ALCOHOL"], ["craft=distillery", "ALCOHOL"],
  ["industrial=brewery", "ALCOHOL"], ["industrial=distillery", "ALCOHOL"],
  ["amenity=casino", "GAMBLING"], ["amenity=gambling", "GAMBLING"], ["shop=bookmaker", "GAMBLING"],
  ["shop=lottery", "GAMBLING"], ["leisure=adult_gaming_centre", "GAMBLING"],
  ["amenity=stripclub", "ADULT"], ["amenity=brothel", "ADULT"], ["amenity=swingerclub", "ADULT"],
  ["amenity=love_hotel", "ADULT"], ["shop=erotic", "ADULT"],
  ["shop=tobacco", "TOBACCO"], ["shop=e-cigarette", "TOBACCO"], ["amenity=hookah_lounge", "TOBACCO"],
  ["shop=cannabis", "CANNABIS"],
  ["shop=pawnbroker", "INTEREST_LENDING"], ["shop=money_lender", "INTEREST_LENDING"], ["amenity=money_lender", "INTEREST_LENDING"],
]);

/**
 * "Bar" without the drink: trades that use the word for a counter, not a
 * licence. Checked before the alcohol rule so "Juice Bar" and "Nail Bar" pass.
 */
const HARMLESS_BAR_RE = /\b(?:juice|smoothie|salad|sushi|poke|noodle|ramen|soup|coffee|espresso|milk|tea|chai|boba|bubble\s*tea|dessert|chocolate|cereal|waffle|pancake|crepe|acai|oat|snack|kebab|burger|pizza|bagel|sandwich|taco|hot\s*dog|breakfast|brunch|oxygen|nail|brow|lash|blow\s*dry|blowdry|hair|beauty|barber|shave|grooming|wax|tan|spa|massage|gym|fitness|protein|vitamin|health|salon|candy|sweet|ice\s*cream|gelato|yog(?:h)?urt|frozen|toast|bakery|bread|hummus|falafel|shawarma|mezze|mocktail|cocoa)\s+bars?\b/i;

/**
 * Word-boundary patterns per category. English first, then the languages of
 * the markets sold into (German, Portuguese, Spanish, French, Arabic).
 */
const NAME_RULES = [
  // No "saloon" here: a car dealer's description says "saloons" too.
  { category: "ALCOHOL", re: /\b(?:pubs?|taverns?|speakeasy|taproom|tap\s*house|beer\s*(?:hall|garden|house|shop|store)|brew(?:ery|eries|ing|house|pub)|micro-?brewery|winery|wineries|vineyard|wine\s*(?:bar|shop|store|merchant|cellar|house|room)|liquor|off-?licen[cs]e|bottle\s*shop|package\s*store|distiller(?:y|ies)|spirits?\s*(?:shop|store|merchant|trading|traders|wholesale)|cocktails?|nightclub|night\s*club|nightlife|disco(?:theque)?|biergarten|bierhaus|brauerei|brauhaus|kneipe|schnapps|weinhandlung|weinbar|weinstube|cervejaria|cerveceria|cervecería|adega|vinoteca|enoteca|bodega\s+de\s+vinos|cave\s+à\s+vins|caviste|bar\s+à\s+vins)\b|\bwines?$|^wines?\b|\bwines?\s*(?:&|and|\+)\s*(?:spirits|dine|tapas|cheese|beer)\b/i },
  // "Bar" on its own, once the harmless compounds are scrubbed: "Bar San
  // Juan", "Sports Bar & Grill", "Restaurant & Bar", "Oyster Bar".
  { category: "ALCOHOL", re: /\b(?:sports|cocktail|wine|beer|whisky|whiskey|gin|rum|vodka|tequila|tapas|oyster|rooftop|sky|lounge|hotel|piano|karaoke|shisha|hookah|cigar|dive|pool|snooker|billiards?)\s+bars?\b|\bbars?\s*(?:&|and|\+)\s*(?:grill|kitchen|restaurant|lounge|bistro|eatery|dining|club)\b|\b(?:restaurant|grill|kitchen|lounge|café|cafe|bistro|brasserie|dining|eatery|club|hotel|cuisine|food)\s*(?:&|and|\+|\/|-|–)?\s*bars?\b|^bars?\b|\bbar$/i },
  // Bare drink words, names only. Deliberately without brandy, ale, cider,
  // mead or sake: "Brandy Melville" sells clothes, "Ale" is a first name, and
  // a Japanese restaurant is not a sake merchant.
  { category: "ALCOHOL", re: /\b(?:whisk(?:e)?y|vodka|gin|rum|tequila|bourbon|cognac|champagne|prosecco|lager|stout|absinthe|liqueur|saloons?)\b(?!\s*-?free)/i, needsContext: true },
  { category: "GAMBLING", re: /\b(?:casinos?|gambling|gaming\s+(?:hall|house|centre|center|club|lounge)|bett?ing(?:\s*shop)?|bookmakers?|bookies|sportsbook|lotto|lottery|lotteries|bingo|poker|slots?\s*(?:machine|hall|arcade|club)|fruit\s*machines?|adult\s*gaming|wettbüro|wettburo|spielhalle|spielothek|spielbank|casa\s+de\s+apostas|apuestas|paris\s+sportifs)\b|\b(?:bet365|ladbrokes|betfred|paddy\s*power|william\s*hill|betway|unibet|betmgm|draftkings|fanduel|tipico|bwin)\b/i },
  { category: "ADULT", re: /\b(?:strip\s*clubs?|gentlemen'?s\s*clubs?|lap\s*dance|adult\s*(?:store|shop|entertainment|club|cinema|toys?)|sex\s*(?:shop|store|toys?|club)|erotic|escorts?|brothel|swingers?|xxx|porn(?:ography)?|topless|burlesque|hostess\s*club|love\s*hotel|massage\s*parlou?r|happy\s*ending|dominatrix)\b/i },
  { category: "TOBACCO", re: /\b(?:tobacco(?:nist)?s?|cigars?|cigarettes?|smoke\s*shop|vape(?:s|ry|shop|store)?|vaping|e-?cig(?:arette)?s?|e-?liquids?|shisha|hookah|hukka|narg(?:h)?ile|tabak(?:laden|waren)?|tabacaria|estanco|bureau\s+de\s+tabac)\b/i },
  // Names only: a Spanish restaurant's description mentions chorizo without
  // being a pork business, so the description layer skips this rule.
  { category: "PORK", re: /\b(?:pork|bacon|hog\s*roast|pig\s*roast|charcuterie|schweine(?:fleisch|braten)?|schweinshaxe|prosciutto|salami|salumeria|chorizo|carnitas|pulled\s*pork|swine|(?:honey|baked|glazed|smoked|country|christmas)\s+hams?|hams?\s+(?:shop|house|store|specialists?))\b/i, needsContext: true },
  { category: "CANNABIS", re: /\b(?:cannabis|marijuana|marihuana|(?:cannabis|marijuana|weed)\s+dispensar(?:y|ies)|\bcbd\b|\bthc\b|ganja|head\s*shop)\b/i },
  { category: "INTEREST_LENDING", re: /\b(?:payday(?:\s*loans?)?|pawn(?:brokers?|shops?|s)?|cash\s*advance|title\s*loans?|loan\s*sharks?|check\s*cashing|money\s*lenders?|pfandhaus|pfandleih(?:e|haus)|casa\s+de\s+empeños?|prêteur\s+sur\s+gages)\b/i },
  // Arabic: \b does not delimit Arabic letters, so bound by "not a letter".
  { category: "ALCOHOL", re: /(?<!\p{L})(?:بار|خمور|مشروبات\s*كحولية|ملهى\s*ليلي|نايت\s*كلوب|بيرة|نبيذ)(?!\p{L})/u },
  { category: "GAMBLING", re: /(?<!\p{L})(?:كازينو|مراهنات|يانصيب|قمار)(?!\p{L})/u },
  { category: "TOBACCO", re: /(?<!\p{L})(?:شيشة|أرجيلة|ارجيلة|معسل|تبغ|سجائر|فيب)(?!\p{L})/u },
  { category: "PORK", re: /(?<!\p{L})(?:لحم\s*خنزير|خنزير)(?!\p{L})/u, needsContext: true },
];

/** Extra OSM key/value pairs that condemn an element tagged as something else. */
const EXCLUDED_TAG_KEYS = [
  ["brewery", null, "ALCOHOL"], ["microbrewery", "yes", "ALCOHOL"], ["distillery", null, "ALCOHOL"],
  ["real_ale", "yes", "ALCOHOL"], ["craft_beer", null, "ALCOHOL"],
  ["gambling", null, "GAMBLING"], ["lottery", "yes", "GAMBLING"],
  ["cuisine", /\b(?:pub|bar|beer|wine|cocktail|pork|bacon|ham|schweine)\b/i, "ALCOHOL"],
];

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * Classify a business by what it sells.
 *
 * @param {object} input
 * @param {string}  input.name
 * @param {string?} input.industry      human label ("Restaurant") or catalogue key
 * @param {string?} input.osmCategory   raw tag ("amenity=bar")
 * @param {string?} input.description   the site's own description, when known
 * @param {object?} input.tags          raw OSM tags, when the element is at hand
 * @param {string?} input.cuisine
 * @returns {{category:string, label:string, matched:string, source:string}|null}
 *   null when the business is fine to work with.
 */
export const classifyExcludedBusiness = ({ name, industry = null, osmCategory = null, description = null, tags = null, cuisine = null } = {}) => {
  const verdict = (category, matched, source) => ({
    category, label: EXCLUDED_CATEGORY_LABELS[category], matched: clean(matched).slice(0, 80), source,
  });

  // 1. Tags: unambiguous.
  const tagValue = clean(osmCategory).toLowerCase();
  if (tagValue && EXCLUDED_OSM_TAGS.has(tagValue)) return verdict(EXCLUDED_OSM_TAGS.get(tagValue), tagValue, "osmCategory");
  const industryValue = clean(industry).toLowerCase();
  if (industryValue === "bar" || industryValue === "pub") return verdict("ALCOHOL", industry, "industry");

  const allTags = tags && typeof tags === "object" ? tags : {};
  for (const [k, v] of Object.entries(allTags)) {
    const pair = `${k}=${String(v)}`.toLowerCase();
    if (EXCLUDED_OSM_TAGS.has(pair)) return verdict(EXCLUDED_OSM_TAGS.get(pair), pair, "tags");
  }
  for (const [key, want, category] of EXCLUDED_TAG_KEYS) {
    const value = allTags[key] ?? (key === "cuisine" ? cuisine : undefined);
    if (value === undefined || value === null || value === "no") continue;
    if (want === null || (want instanceof RegExp ? want.test(String(value)) : String(value).toLowerCase() === want)) {
      return verdict(category, `${key}=${value}`, "tags");
    }
  }

  // 2. Name: the strongest free-text evidence, because a business chose it.
  const nameText = clean(name);
  if (nameText) {
    const hit = matchText(nameText, { strict: true });
    if (hit) return verdict(hit.category, hit.matched, "name");
  }

  // 3. Description: only the explicit patterns, and only the first sentences —
  // a long "about" page mentions wine pairings without being a wine bar.
  const descText = clean(description).slice(0, 400);
  if (descText) {
    const hit = matchText(descText, { strict: false });
    if (hit) return verdict(hit.category, hit.matched, "description");
  }

  return null;
};

/**
 * Run the name rules over a piece of text.
 *
 * `strict` (names) allows the single-word alcohol brands rule to fire — a
 * business called "Vodka Revolution" is what it says. In descriptions those
 * words need the drink to be the trade, so the rule is skipped there and only
 * the compound patterns ("wine bar", "brewery") count.
 */
const matchText = (text, { strict }) => {
  const scrubbed = text.replace(HARMLESS_BAR_RE, " ");
  for (const rule of NAME_RULES) {
    if (rule.needsContext && !strict) continue;
    const m = rule.re.exec(scrubbed);
    if (m) return { category: rule.category, matched: m[0] };
  }
  return null;
};

/** Convenience for callers that only hold a Company row. */
export const classifyCompanyExclusion = (company) =>
  classifyExcludedBusiness({
    name: company?.name,
    industry: company?.industry,
    osmCategory: company?.osmCategory,
    description: company?.description,
  });

/** One sentence, for the lead's status note and the UI. */
export const exclusionNote = (hit) =>
  `Excluded line of business — ${hit.label}: "${hit.matched}" (${hit.source}). This agency does not work with this trade.`;

/**
 * The instruction handed to every model prompt that can discover companies.
 * Kept here, next to the rules that enforce it, so the two cannot drift.
 */
export const EXCLUDED_CATEGORIES_PROMPT = `Never return a business whose trade is any of the following, however well it otherwise matches: ${Object.values(EXCLUDED_CATEGORY_LABELS).join("; ")}. A restaurant or hotel is fine; a bar, pub, brewery, liquor shop, casino, betting shop, strip club, vape or shisha lounge, pork butcher, cannabis dispensary or payday lender is not. When the name or listing says the business is one of these, omit it.`;

export const __testables = { NAME_RULES, HARMLESS_BAR_RE, EXCLUDED_TAG_KEYS };
