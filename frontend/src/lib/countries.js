/**
 * The country picker's options.
 *
 * Names are resolved with `Intl.DisplayNames` rather than kept in a hand-written
 * map: the browser already ships the full, correctly-spelled, localised list,
 * and a second copy of it here would silently drift from the server's. Only the
 * ISO 3166-1 alpha-2 codes live in this file, and those do not change.
 *
 * The country filter on the clients list is built from the values actually in
 * the database (GET /api/clients/facets) — this list is only ever offered where
 * a user is *entering* a country, so an unused option costs nothing.
 */

const CODES = [
  "AE", "AR", "AT", "AU", "BE", "BG", "BH", "BR", "CA", "CH", "CL", "CN", "CY", "CZ",
  "DE", "DK", "EE", "EG", "ES", "FI", "FR", "GB", "GR", "HK", "HR", "HU", "ID", "IE",
  "IL", "IN", "IQ", "IS", "IT", "JO", "JP", "KE", "KR", "KW", "LB", "LT", "LU", "LV",
  "MA", "MT", "MX", "MY", "NG", "NL", "NO", "NZ", "OM", "PH", "PK", "PL", "PT", "QA",
  "RO", "RS", "RU", "SA", "SE", "SG", "SI", "SK", "TH", "TR", "TW", "UA", "US", "VN", "ZA",
];

// Built once at module load — `Intl.DisplayNames` is not free, and this list is
// rendered into every client form.
const displayNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region" });
  } catch {
    return null;
  }
})();

/** Display name for a code, falling back to the code itself. */
export const countryLabel = (code) => {
  if (!code) return null;
  const upper = String(code).toUpperCase();
  try {
    return displayNames?.of(upper) || upper;
  } catch {
    return upper;
  }
};

/** `[{ code, name }]`, alphabetical by the name the user will actually read. */
export const COUNTRY_OPTIONS = CODES
  .map((code) => ({ code, name: countryLabel(code) }))
  .sort((a, b) => a.name.localeCompare(b.name));
