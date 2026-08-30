-- AlterEnum
ALTER TYPE "CampaignStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN     "sendDays" JSONB,
ADD COLUMN     "startAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OutreachCampaign_status_startAt_idx" ON "OutreachCampaign"("status", "startAt");
