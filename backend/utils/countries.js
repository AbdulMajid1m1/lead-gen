/**
 * ISO 3166-1 alpha-2 → display name.
 *
 * Deliberately not a full 249-entry table: the only codes that ever reach the
 * UI are the ones our sources actually stamp on a company (OpenStreetMap
 * addresses, Nominatim lookups and aggregator locations), and the country
 * filter is built from the distinct values present in the database rather than
 * from this map. Anything unlisted falls back to its own code, so an
 * unexpected country renders as "BR" rather than disappearing.
 */
export const COUNTRY_NAMES = {
  AE: "United Arab Emirates", AR: "Argentina", AT: "Austria", AU: "Australia",
  BE: "Belgium", BG: "Bulgaria", BH: "Bahrain", BR: "Brazil",
  CA: "Canada", CH: "Switzerland", CL: "Chile", CN: "China", CY: "Cyprus", CZ: "Czechia",
  DE: "Germany", DK: "Denmark", EE: "Estonia", EG: "Egypt", ES: "Spain",
  FI: "Finland", FR: "France", GB: "United Kingdom", GR: "Greece",
  HK: "Hong Kong", HR: "Croatia", HU: "Hungary", ID: "Indonesia", IE: "Ireland",
  IL: "Israel", IN: "India", IQ: "Iraq", IS: "Iceland", IT: "Italy",
  JO: "Jordan", JP: "Japan", KE: "Kenya", KR: "South Korea", KW: "Kuwait",
  LB: "Lebanon", LT: "Lithuania", LU: "Luxembourg", LV: "Latvia",
  MA: "Morocco", MT: "Malta", MX: "Mexico", MY: "Malaysia", NG: "Nigeria",
  NL: "Netherlands", NO: "Norway", NZ: "New Zealand", OM: "Oman",
  PH: "Philippines", PK: "Pakistan", PL: "Poland", PT: "Portugal", QA: "Qatar",
  RO: "Romania", RS: "Serbia", RU: "Russia", SA: "Saudi Arabia", SE: "Sweden",
  SG: "Singapore", SI: "Slovenia", SK: "Slovakia", TH: "Thailand", TR: "Türkiye",
  TW: "Taiwan", UA: "Ukraine", US: "United States", VN: "Vietnam", ZA: "South Africa",
};

/** Display name for a country code, falling back to the code itself. */
export const countryName = (code) => (code ? COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase() : null);

/**
 * ISO 3166-1 alpha-2 → E.164 country calling code.
 *
 * Kept beside COUNTRY_NAMES because both answer "what do we know about this
 * country code", and a second copy elsewhere would drift. Used to put the
 * international prefix back on a number a business published nationally
 * ("030 78001738" on a German site), which is what lets the same line from
 * three different sources collapse to one stored contact.
 */
export const CALLING_CODES = {
  AE: "971", AR: "54", AT: "43", AU: "61", BE: "32", BG: "359", BH: "973", BR: "55",
  CA: "1", CH: "41", CL: "56", CN: "86", CY: "357", CZ: "420", DE: "49", DK: "45",
  EE: "372", EG: "20", ES: "34", FI: "358", FR: "33", GB: "44", GR: "30", HK: "852",
  HR: "385", HU: "36", ID: "62", IE: "353", IL: "972", IN: "91", IQ: "964", IS: "354",
  IT: "39", JO: "962", JP: "81", KE: "254", KR: "82", KW: "965", LB: "961", LT: "370",
  LU: "352", LV: "371", MA: "212", MT: "356", MX: "52", MY: "60", NG: "234", NL: "31",
  NO: "47", NZ: "64", OM: "968", PH: "63", PK: "92", PL: "48", PT: "351", QA: "974",
  RO: "40", RS: "381", RU: "7", SA: "966", SE: "46", SG: "65", SI: "386", SK: "421",
  TH: "66", TR: "90", TW: "886", UA: "380", US: "1", VN: "84", ZA: "27",
};

/** Longest calling code that a bare international number starts with. */
const SORTED_CODES = [...new Set(Object.values(CALLING_CODES))].sort((a, b) => b.length - a.length);

export const callingCodeFor = (countryCode) =>
  CALLING_CODES[String(countryCode || "").toUpperCase()] || null;

export const detectCallingCode = (digits) => SORTED_CODES.find((c) => digits.startsWith(c)) || null;
