import { describe, it, expect } from "vitest";
import { classifyExcludedBusiness, classifyCompanyExclusion, exclusionNote, EXCLUDED_CATEGORIES_PROMPT } from "../../lib/qualify/excludedCategories.js";
import { OSM_CATEGORIES } from "../../lib/adapters/overpass.js";
import { INDUSTRY_TERMS } from "../../lib/nlquery/lexicon.js";

/**
 * Lines of trade this agency does not work with are kept out of the whole
 * pipeline. The two mistakes are not symmetrical: a bar that slips through
 * gets a pitch nobody wanted to send, while a barber flagged as a bar is a
 * real lead lost silently. Every "must pass" case below is a real company name
 * from the production database that a naive substring check had flagged.
 */
describe("classifyExcludedBusiness", () => {
  const excluded = (name, opts = {}) => classifyExcludedBusiness({ name, ...opts })?.category ?? null;

  it("catches alcohol-led businesses by name, in the forms real names take", () => {
    for (const name of [
      "Bar San Juan", "Koko's Beer Hall", "Bikinis Sports Bar & Grill", "Tia Maria Bar & Kitchen",
      "Bank Restaurant & Bar", "Bold Food & Bar", "Hyde Park Bar and Grill", "The Maine Oyster Bar and Grill",
      "Vista Rooftop Bar & Restaurant", "El Rincon de Rafa - Rafa's Spanish Bar & Restaurant", "Tapeo & Wine",
      "The Crown Pub", "Camden Town Brewery", "Majestic Wine", "Oddbins Off-Licence", "Gin Palace",
      "Brauhaus Lemke", "Cervejaria Trindade", "SALTA Bar", "Bar Chi Sushi",
    ]) {
      expect(excluded(name), name).toBe("ALCOHOL");
    }
  });

  it("catches gambling, adult, tobacco, pork, cannabis and payday trades", () => {
    expect(excluded("Ladbrokes")).toBe("GAMBLING");
    expect(excluded("Grosvenor Casino Manchester")).toBe("GAMBLING");
    expect(excluded("Mecca Bingo")).toBe("GAMBLING");
    expect(excluded("Wettbüro Kreuzberg")).toBe("GAMBLING");
    expect(excluded("Spearmint Rhino Gentlemen's Club")).toBe("ADULT");
    expect(excluded("Vape Nation")).toBe("TOBACCO");
    expect(excluded("Shisha Lounge Cafe")).toBe("TOBACCO");
    expect(excluded("Texas Honey Ham")).toBe("PORK");
    expect(excluded("Austin Cannabis Dispensary")).toBe("CANNABIS");
    expect(excluded("Cash Converters Pawnbrokers")).toBe("INTEREST_LENDING");
    expect(excluded("كازينو الشرق")).toBe("GAMBLING");
    expect(excluded("مقهى شيشة الليل")).toBe("TOBACCO");
  });

  it("settles it from the OSM tag when there is one", () => {
    expect(excluded("The Anchor", { osmCategory: "amenity=pub" })).toBe("ALCOHOL");
    expect(excluded("Lucky 7", { osmCategory: "shop=bookmaker" })).toBe("GAMBLING");
    expect(excluded("Mediterraneo", { tags: { amenity: "restaurant", microbrewery: "yes" } })).toBe("ALCOHOL");
    expect(excluded("Mediterraneo", { tags: { amenity: "restaurant" }, cuisine: "italian;pizza" })).toBeNull();
  });

  it("reads the site's own description for the explicit cases only", () => {
    expect(excluded("Turtle Bay", { description: "Caribbean restaurant and rum cocktails, happy hour every day" })).toBe("ALCOHOL");
    // A restaurant mentioning a pork dish is a restaurant.
    expect(excluded("Los Pollos", { description: "Spanish tapas with chorizo and paella" })).toBeNull();
    // Single drink words are not trusted in prose — "sake" is a common word.
    expect(excluded("Kyoto Kitchen", { description: "For the sake of freshness we buy fish daily" })).toBeNull();
  });

  it("leaves every business that only sounds like one alone", () => {
    for (const name of [
      "Sagheer Barbers Shop", "Barnard Marcus", "Birmingham Motors", "Barbican Dental Centre", "Carambar",
      "Armenian Taverna", "Karachi Inn", "The New Inn", "Coffee Lounge", "Blissful Massage and Beauty Center",
      "Chennai Darbar", "Bill's Oyster", "Harvester", "Kensington Dentist", "Sushi Bar Tokyo", "Milk Bar",
      "Juice Bar Dubai", "Nail Bar London", "West Ham Chippy", "Bombay Bistro", "Boots Pharmacy Dispensary",
      "Coral Reef Restaurant", "Stripe", "Barnes & Partners Solicitors", "Kanzlei Bartels", "Orlebar Brown",
      "Ale-free Kitchen", "Ginger & Co", "Rumi's Kitchen", "Photography Studio", "Brandy Melville", "Sake House Sushi",
    ]) {
      expect(excluded(name), name).toBeNull();
    }
    // A car dealer's saloons are cars; a Wild West Saloon is a bar.
    expect(excluded("Brindley Hyundai", { description: "New and used Hyundai saloons, SUVs and hatchbacks in West Bromwich" })).toBeNull();
    expect(excluded("Last Chance Saloon")).toBe("ALCOHOL");
  });

  it("works from a Company row and writes a readable note", () => {
    const hit = classifyCompanyExclusion({ name: "Bar San Juan", industry: "Restaurant", osmCategory: "amenity=restaurant", description: null });
    expect(hit.category).toBe("ALCOHOL");
    expect(exclusionNote(hit)).toMatch(/Excluded line of business — alcohol .*"Bar" \(name\)/);
  });

  it("is no longer something the map search or the parser can ask for", () => {
    expect(OSM_CATEGORIES.bar).toBeUndefined();
    expect(INDUSTRY_TERMS.find(([, key]) => key === "bar")).toBeUndefined();
    expect(EXCLUDED_CATEGORIES_PROMPT).toMatch(/casino/);
  });
});
