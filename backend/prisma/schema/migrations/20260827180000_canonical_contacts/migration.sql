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

-- ── 1. Normalise in place ────────────────────────────────────────────────────
-- Phones: keep a single leading "+", drop every other non-digit.
UPDATE "Contact"
   SET "value" = CASE
         WHEN btrim("value") LIKE '+%'
           THEN '+' || regexp_replace("value", '[^0-9]', '', 'g')
         ELSE regexp_replace("value", '[^0-9]', '', 'g')
       END
 WHERE "kind" = 'PHONE'
   -- Only rows that actually change, and only ones that still look like a
   -- number afterwards — never blank out something unparseable.
   AND "value" <> CASE
         WHEN btrim("value") LIKE '+%'
           THEN '+' || regexp_replace("value", '[^0-9]', '', 'g')
         ELSE regexp_replace("value", '[^0-9]', '', 'g')
       END
   AND length(regexp_replace("value", '[^0-9]', '', 'g')) BETWEEN 7 AND 15;

-- Emails: lowercase, trimmed.
UPDATE "Contact"
   SET "value" = lower(btrim("value"))
 WHERE "kind" = 'EMAIL'
   AND "value" <> lower(btrim("value"));

-- ── 2. Pick one survivor per (company, kind, value) ──────────────────────────
-- Keep the most trustworthy row: VERIFIED over DETECTED over INFERRED over
-- AI_GENERATED, then the one that was already verified, then the oldest — the
-- oldest is the one other tables are most likely to already reference.
CREATE TEMP TABLE "_contact_merge" AS
SELECT "id", "companyId", "kind", "value", "isSuppressed",
       first_value("id") OVER (
         PARTITION BY "companyId", "kind", "value"
         ORDER BY
           CASE "confidenceLevel"
             WHEN 'VERIFIED' THEN 0 WHEN 'DETECTED' THEN 1
             WHEN 'INFERRED' THEN 2 ELSE 3
           END,
           ("verifiedAt" IS NULL),
           "createdAt",
           "id"
       ) AS "keepId"
  FROM "Contact";

-- A suppression recorded on any spelling must survive the merge, or a contact
-- someone asked us never to use would come back to life as the survivor.
UPDATE "Contact" c
   SET "isSuppressed" = true
  FROM (
    SELECT "keepId" FROM "_contact_merge" WHERE "isSuppressed" GROUP BY "keepId"
  ) s
 WHERE c."id" = s."keepId" AND c."isSuppressed" = false;

-- Re-point the AI verification trail at the survivor. `verifiedContactId` has
-- no foreign key, so a dangling id here would fail silently rather than loudly.
UPDATE "AiClaim" a
   SET "verifiedContactId" = m."keepId"
  FROM "_contact_merge" m
 WHERE a."verifiedContactId" = m."id"
   AND m."id" <> m."keepId";

-- ── 3. Drop the losers ───────────────────────────────────────────────────────
DELETE FROM "Contact" c
 USING "_contact_merge" m
 WHERE c."id" = m."id" AND m."id" <> m."keepId";

DROP TABLE "_contact_merge";
