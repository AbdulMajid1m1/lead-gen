-- AlterTable: email and WhatsApp get their own daily budget and pacing clock.
ALTER TABLE "OutreachCampaign" ADD COLUMN "waDailyLimit" INTEGER;
ALTER TABLE "OutreachCampaign" ADD COLUMN "waLastSentAt" TIMESTAMP(3);

-- AlterTable: per-channel processed stamps, so each channel's daily count is its own.
ALTER TABLE "CampaignRecipient" ADD COLUMN "emailProcessedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "waProcessedAt" TIMESTAMP(3);

-- Backfill: existing rows were processed by whichever channel touched them, so
-- the single stamp is the best evidence for both. Without this, today's quota
-- would read as unspent the moment this migration lands.
UPDATE "CampaignRecipient" SET "emailProcessedAt" = "processedAt" WHERE "emailState" <> 'PENDING' AND "processedAt" IS NOT NULL;
UPDATE "CampaignRecipient" SET "waProcessedAt" = "processedAt" WHERE "waState" <> 'PENDING' AND "processedAt" IS NOT NULL;

-- AlterTable: a WhatsApp number needs its own ramp; a ban there is permanent.
ALTER TABLE "WhatsAppAccount" ADD COLUMN "warmupStartedAt" TIMESTAMP(3);

-- AlterTable: the standing automation carries a figure per channel.
ALTER TABLE "OutreachAutopilot" ADD COLUMN "waDailyLimit" INTEGER;
