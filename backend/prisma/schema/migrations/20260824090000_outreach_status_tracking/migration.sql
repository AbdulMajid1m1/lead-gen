-- Outreach status tracking.
--
-- Additive only, per the deploy policy: the previous release runs unchanged
-- against this schema. Nothing writes 'REPLIED' until the new code ships, and
-- the WhatsAppAccount columns all carry defaults, so existing rows are valid
-- the moment the ALTER lands.

-- AlterEnum
-- 'REPLIED' sits after FOLLOW_UP so the enum reads in lifecycle order. Adding a
-- value is safe inside a transaction on PG 12+ as long as it is not also used
-- there, which it is not.
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'REPLIED' AFTER 'FOLLOW_UP';

-- AlterTable
ALTER TABLE "WhatsAppAccount"
    ADD COLUMN IF NOT EXISTS "autoFollowUp" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "followUpDays" JSONB NOT NULL DEFAULT '[3, 7]',
    ADD COLUMN IF NOT EXISTS "maxFollowUps" INTEGER NOT NULL DEFAULT 2;
