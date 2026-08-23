import crypto from "node:crypto";

export const sha256 = (input) => crypto.createHash("sha256").update(input).digest("hex");

/**
 * Stable hash of an object regardless of key order, so re-fetching the same
 * payload from a source that shuffles its JSON keys still dedupes.
 */
export const hashPayload = (payload) => sha256(canonicalJson(payload));

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
};
