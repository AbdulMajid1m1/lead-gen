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
