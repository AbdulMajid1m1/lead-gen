-- Collapse the duplicate contact rows created by storing whatever spelling each
-- source happened to use.
--
-- `Contact` is unique on the raw string, so one telephone reached us as five
-- separate "contacts": "+49 30 78001738" (Google Places and OpenStreetMap),
-- "+493078001738" (our crawler), "+49 (0)30 780 017 38" (JSON-LD) and
-- "030 78001738" (Places' national fallback). Emails split the same way on
-- casing. Every duplicate was separately MX-checked, separately counted in the
-- reachability totals, and separately offered to the sender.
--
-- recordContact now canonicalises before writing, so this only has to clean up
-- what is already stored. The SQL below deliberately does the *mechanical* half
-- — punctuation and casing — and leaves trunk-zero variants alone: resolving
-- "030 …" to "+4930 …" needs the calling-code table, which lives in JS. Those
-- are handled by scripts/canonicalise-contacts.mjs, and are read-time deduped
-- by phoneRank.js in the meantime.
--
-- ORDER MATTERS, and getting it wrong is how the first attempt at this failed
-- against production: normalising first makes the rewritten value collide with
-- the row it was about to be merged into, and the unique index rejects the
-- UPDATE before anything is deleted. So the duplicates are resolved and removed
-- while the values are still distinct, and only the survivors are rewritten.

-- ── 1. Group every contact by the value it is *about to* have ────────────────
-- The canonical form is computed here and never stored, so nothing collides.
CREATE TEMP TABLE "_contact_merge" AS
SELECT
  "id",
  "companyId",
  "kind",
  "isSuppressed",
  CASE
    WHEN "kind" = 'EMAIL' THEN lower(btrim("value"))
    WHEN "kind" = 'PHONE'
         AND length(regexp_replace("value", '[^0-9]', '', 'g')) BETWEEN 7 AND 15
      THEN CASE
             WHEN btrim("value") LIKE '+%'
               THEN '+' || regexp_replace("value", '[^0-9]', '', 'g')
             ELSE regexp_replace("value", '[^0-9]', '', 'g')
           END
    -- Anything unparseable keeps its exact current value, so it groups only
    -- with itself and is never rewritten or merged away.
    ELSE "value"
  END AS "canonical"
FROM "Contact";

-- Keep the most trustworthy row of each group: VERIFIED over DETECTED over
-- INFERRED over AI_GENERATED, then one already verified, then the oldest —
-- the oldest is what other tables are most likely to reference.
CREATE TEMP TABLE "_contact_keep" AS
SELECT
  m."id",
  m."companyId",
  m."kind",
  m."canonical",
  m."isSuppressed",
  first_value(m."id") OVER (
    PARTITION BY m."companyId", m."kind", m."canonical"
    ORDER BY
      CASE c."confidenceLevel"
        WHEN 'VERIFIED' THEN 0 WHEN 'DETECTED' THEN 1
        WHEN 'INFERRED' THEN 2 ELSE 3
      END,
      (c."verifiedAt" IS NULL),
      c."createdAt",
      m."id"
  ) AS "keepId"
FROM "_contact_merge" m
JOIN "Contact" c ON c."id" = m."id";

-- ── 2. Carry anything the losers were carrying onto the survivor ─────────────
-- A suppression recorded against any spelling must survive the merge, or a
-- contact someone asked us never to use comes back to life as the survivor.
UPDATE "Contact" c
   SET "isSuppressed" = true
  FROM (SELECT "keepId" FROM "_contact_keep" WHERE "isSuppressed" GROUP BY "keepId") s
 WHERE c."id" = s."keepId" AND c."isSuppressed" = false;

-- Re-point the AI verification trail. `verifiedContactId` carries no foreign
-- key, so a dangling id here would fail silently rather than loudly.
UPDATE "AiClaim" a
   SET "verifiedContactId" = k."keepId"
  FROM "_contact_keep" k
 WHERE a."verifiedContactId" = k."id"
   AND k."id" <> k."keepId";

-- ── 3. Remove the losers, while the values are still distinct ────────────────
DELETE FROM "Contact" c
 USING "_contact_keep" k
 WHERE c."id" = k."id" AND k."id" <> k."keepId";

-- ── 4. Only now rewrite the survivors ────────────────────────────────────────
-- Exactly one row per (companyId, kind, canonical) remains, so the unique index
-- cannot be violated by this update.
UPDATE "Contact" c
   SET "value" = k."canonical"
  FROM "_contact_keep" k
 WHERE c."id" = k."id"
   AND k."id" = k."keepId"
   AND c."value" <> k."canonical";

DROP TABLE "_contact_keep";
DROP TABLE "_contact_merge";
