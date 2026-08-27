-- Adds a third follow-up: the proof step that carries one matched piece of our
-- own work. The sequence previously ran observation → observation → breakup and
-- never showed the reader anything we had built.

-- AlterTable: new mailboxes get the three-chase cadence.
ALTER TABLE "EmailAccount" ALTER COLUMN "followUpDays" SET DEFAULT '[3, 7, 14]';
ALTER TABLE "EmailAccount" ALTER COLUMN "maxFollowUps" SET DEFAULT 3;

-- Bring existing mailboxes onto the new cadence, but ONLY those still sitting
-- on the old defaults. A mailbox whose cadence was deliberately tuned keeps it.
UPDATE "EmailAccount"
   SET "followUpDays" = '[3, 7, 14]'::jsonb,
       "maxFollowUps" = 3
 WHERE "maxFollowUps" = 2
   AND "followUpDays"::jsonb = '[3, 7]'::jsonb;
