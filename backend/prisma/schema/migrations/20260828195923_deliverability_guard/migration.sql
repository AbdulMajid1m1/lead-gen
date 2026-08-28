-- AlterEnum
ALTER TYPE "OutreachMessageKind" ADD VALUE 'BOUNCE';

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "warmupStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN     "pausedReason" VARCHAR(300);

-- AlterTable
ALTER TABLE "OutreachMessage" ADD COLUMN     "bounceCode" VARCHAR(20),
ADD COLUMN     "bounceType" VARCHAR(10);

-- CreateIndex
CREATE INDEX "OutreachMessage_kind_createdAt_idx" ON "OutreachMessage"("kind", "createdAt");
