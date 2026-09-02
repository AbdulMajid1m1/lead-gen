import prisma from "../../prismaClient.js";
import { searchArea, OSM_CATEGORIES, OVERPASS_ATTRIBUTION } from "../adapters/overpass.js";
import { geocode } from "../adapters/nominatim.js";
import { ensureSource, recordSourceRecord, resolveCompany, recordFact, recordContact } from "../provenance/recorder.js";
import { classifyExcludedBusiness } from "../qualify/excludedCategories.js";
import { log } from "../../utils/logger.js";

const logger = log("overpassIngest");

/**
 * Discover local businesses from OpenStreetMap and land them as companies with
 * full provenance.
 *
 * The single most valuable thing OSM gives this product is a *negative* fact:
 * a business listed with a phone and an address but no `website` tag is a
 * directly actionable website-development lead, and the absence is explicit
 * rather than assumed.
 */
export const ingestArea = async ({ location, categoryKey, radiusMeters = 10_000, limit = 150, discoveryRunId = null }) => {
  const category = OSM_CATEGORIES[categoryKey];
  if (!category) throw new Error(`Unknown category ${categoryKey}`);

  const place = await geocode(location);
  if (!place) return { ok: false, reason: "GEOCODE_FAILED", location, created: 0, updated: 0 };

  const result = await searchArea({ lat: place.lat, lon: place.lon, radiusMeters, categoryKey, limit });
  if (!result.ok) {
    return { ok: false, reason: result.reason, location, created: 0, updated: 0 };
  }

  const source = await ensureSource({
    kind: "OVERPASS",
    name: "OpenStreetMap (Overpass)",
    baseUrl: result.endpoint,
    attribution: OVERPASS_ATTRIBUTION,
  });

  let created = 0;
  let updated = 0;
  const companyIds = [];
  const withoutWebsite = [];

  let skipped = 0;
  let excluded = 0;
  for (const el of result.elements) {
    // A business in a line of trade this agency does not work with is dropped
    // before it becomes a company at all. A restaurant node whose name is
    // "Sports Bar & Grill" or whose tags say microbrewery=yes arrives under
    // amenity=restaurant, so the category search alone cannot keep it out.
    const exclusion = classifyExcludedBusiness({
      name: el.name, osmCategory: el.categoryTag, tags: el.tags, cuisine: el.cuisine,
    });
    if (exclusion) {
      excluded += 1;
      logger.debug({ name: el.name, osm: el.osmKey, category: exclusion.category, matched: exclusion.matched }, "excluded line of business — not ingested");
      continue;
    }

    // One unusable record must never abort the whole area. Before this, a
    // single element whose name normalised to nothing threw and failed the
    // entire OVERPASS step, discarding the other 119 businesses with it.
    try {
    const record = await recordSourceRecord({
      sourceId: source.id,
      externalId: el.osmKey,
      url: `https://www.openstreetmap.org/${el.osmType}/${el.osmId}`,
      payload: el.tags,
    });

    const { company, created: isNew } = await resolveCompany({
      name: el.name,
      domain: el.domain,
      phone: el.phone,
      osmId: el.osmKey,
      city: el.city || place.displayName?.split(",")[0] || null,
      countryCode: el.countryCode || place.countryCode,
      industry: category.label,
      osmCategory: el.categoryTag || categoryKey,
      discoveredVia: "OVERPASS",
    });
    if (isNew) created += 1;
    else updated += 1;
    companyIds.push(company.id);

    await prisma.location.upsert({
      where: { osmType_osmId: { osmType: el.osmType, osmId: BigInt(el.osmId) } },
      update: { lat: el.lat, lon: el.lon, city: el.city, addressLine: el.addressLine, postalCode: el.postalCode, country: el.countryCode || place.countryCode },
      create: {
        companyId: company.id, osmType: el.osmType, osmId: BigInt(el.osmId),
        lat: el.lat, lon: el.lon, city: el.city, addressLine: el.addressLine,
        postalCode: el.postalCode, country: el.countryCode || place.countryCode,
      },
    });

    if (el.phone) {
      await recordContact({ companyId: company.id, kind: "PHONE", value: el.phone, roleHint: "OSM_LISTING", confidenceLevel: "VERIFIED", sourceRecordId: record.id });
    }
    if (el.email) {
      await recordContact({ companyId: company.id, kind: "EMAIL", value: el.email, roleHint: "OSM_LISTING", confidenceLevel: "VERIFIED", sourceRecordId: record.id });
    }
    for (const [network, handle] of [["FACEBOOK", el.facebook], ["INSTAGRAM", el.instagram]]) {
      if (!handle) continue;
      const url = /^https?:\/\//i.test(handle) ? handle : `https://${network.toLowerCase()}.com/${handle}`;
      await recordContact({ companyId: company.id, kind: "SOCIAL", value: url, roleHint: network, confidenceLevel: "DETECTED", sourceRecordId: record.id });
    }

    // The website tag — present or absent — is the key fact from this source.
    if (el.hasWebsiteTag) {
      await recordFact({
        companyId: company.id, key: "osm_website", value: el.website,
        confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
        evidenceSnippet: `OpenStreetMap lists the website as ${el.website}.`,
        sourceRecordId: record.id,
      });
    } else {
      withoutWebsite.push(company.id);
      // A listing whose "website" is a page on an ordering marketplace, a
      // booking service or a social network has no website of its own. That
      // is recorded as the absence it is — with the platform named, so the
      // pitch can say "your only web presence is a Menufy ordering page"
      // rather than "we can't find you online".
      const hosted = el.hostedOn;
      await recordFact({
        companyId: company.id, key: "osm_no_website_tag", value: "true",
        confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
        evidenceSnippet: hosted
          ? `The OpenStreetMap listing for ${el.name} gives only a ${hosted.label} on ${hosted.domain} (${el.website}) — no website of its own.`
          : `The OpenStreetMap listing for ${el.name} records ${el.phone ? "a phone number" : "contact details"} but no website.`,
        sourceRecordId: record.id,
      });
      if (hosted) {
        await recordFact({
          companyId: company.id, key: "hosted_listing", value: el.website.slice(0, 500), valueJson: { platform: hosted.domain, kind: hosted.kind },
          confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
          evidenceSnippet: `OpenStreetMap's website tag points at a ${hosted.label} on ${hosted.domain}.`,
          sourceRecordId: record.id,
        });
        // A social profile is still a way to reach them, so keep it as one.
        if (hosted.kind === "SOCIAL" && /facebook|instagram/i.test(hosted.domain)) {
          const network = /instagram/i.test(hosted.domain) ? "INSTAGRAM" : "FACEBOOK";
          await recordContact({ companyId: company.id, kind: "SOCIAL", value: el.website, roleHint: network, confidenceLevel: "DETECTED", sourceRecordId: record.id });
        }
      }
    }

    if (el.openingHours) {
      await recordFact({
        companyId: company.id, key: "opening_hours", value: el.openingHours,
        confidenceLevel: "VERIFIED", extractorName: "overpassIngest",
        evidenceSnippet: `Opening hours per OpenStreetMap: ${el.openingHours}`,
        sourceRecordId: record.id,
      });
    }
    if (el.cuisine) {
      await recordFact({
        companyId: company.id, key: "cuisine", value: el.cuisine,
        confidenceLevel: "VERIFIED", extractorName: "overpassIngest", sourceRecordId: record.id,
      });
    }
    } catch (err) {
      skipped += 1;
      logger.debug({ name: el.name, osm: el.osmKey, msg: err.message }, "skipped an unusable OSM element");
    }
  }

  logger.info(
    { location, categoryKey, found: result.elements.length, created, updated, skipped, excluded, withoutWebsite: withoutWebsite.length },
    "overpass area ingested",
  );

  return {
    ok: true,
    location,
    place: { lat: place.lat, lon: place.lon, displayName: place.displayName, countryCode: place.countryCode },
    categoryKey,
    found: result.elements.length,
    created,
    updated,
    skipped,
    excluded,
    companyIds,
    withoutWebsite,
    endpoint: result.endpoint,
  };
};
