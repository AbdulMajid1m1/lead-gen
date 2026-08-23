import prisma from "../../prismaClient.js";
import { safeFetchJson } from "../crawler/safeFetch.js";
import { withHostSlot, setCrawlDelay } from "../crawler/hostPolicy.js";
import { NOMINATIM_URL, NOMINATIM_EMAIL } from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("nominatim");

/**
 * Geocoding, with a permanent database cache.
 *
 * Nominatim's usage policy is unusually strict and explicitly *requires* that
 * results be cached rather than re-queried, caps us at 1 request/second, and
 * demands an identifying User-Agent. The GeoPlace table is therefore a
 * compliance mechanism, not just a speed-up: a city is geocoded exactly once,
 * ever.
 */

const HOST = new URL(NOMINATIM_URL).host;
setCrawlDelay(HOST, 1100); // policy: absolute max 1 req/s

/**
 * @returns {Promise<{lat,lon,displayName,boundingBox,countryCode,cached}|null>}
 */
export const geocode = async (query) => {
  const key = String(query).trim().toLowerCase();
  if (!key) return null;

  const cached = await prisma.geoPlace.findUnique({ where: { query: key } });
  if (cached) {
    return {
      lat: cached.lat,
      lon: cached.lon,
      displayName: cached.displayName,
      boundingBox: cached.boundingBox,
      countryCode: cached.countryCode,
      cached: true,
    };
  }

  const url = new URL("/search", NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  if (NOMINATIM_EMAIL) url.searchParams.set("email", NOMINATIM_EMAIL);

  let hit;
  try {
    const res = await withHostSlot(HOST, () => safeFetchJson(url.href, { timeoutMs: 20_000 }));
    hit = Array.isArray(res.json) ? res.json[0] : null;
  } catch (err) {
    logger.warn({ query, msg: err.message }, "geocoding failed");
    return null;
  }
  if (!hit) return null;

  // Nominatim's boundingbox is [south, north, west, east] as strings.
  const bb = (hit.boundingbox || []).map(Number);
  const boundingBox = bb.length === 4
    ? { south: bb[0], north: bb[1], west: bb[2], east: bb[3] }
    : null;

  const record = {
    query: key,
    displayName: hit.display_name || null,
    lat: Number(hit.lat),
    lon: Number(hit.lon),
    boundingBox,
    osmType: hit.osm_type?.slice(0, 10) || null,
    osmId: hit.osm_id ? BigInt(hit.osm_id) : null,
    countryCode: hit.address?.country_code?.toUpperCase()?.slice(0, 2) || null,
  };

  await prisma.geoPlace.upsert({ where: { query: key }, update: record, create: record });
  logger.info({ query, displayName: record.displayName }, "geocoded and cached permanently");

  return { ...record, cached: false };
};

/**
 * Shrink an oversized bounding box around its centre.
 * A country-sized box makes Overpass time out and returns results nobody asked
 * for when the user typed a city name.
 */
export const clampBoundingBox = (bbox, maxSpanDeg = 0.9) => {
  if (!bbox) return null;
  const { south, north, west, east } = bbox;
  const latSpan = north - south;
  const lonSpan = east - west;
  if (latSpan <= maxSpanDeg && lonSpan <= maxSpanDeg) return bbox;
  const cLat = (north + south) / 2;
  const cLon = (east + west) / 2;
  const half = maxSpanDeg / 2;
  return {
    south: Math.max(south, cLat - half),
    north: Math.min(north, cLat + half),
    west: Math.max(west, cLon - half),
    east: Math.min(east, cLon + half),
  };
};
