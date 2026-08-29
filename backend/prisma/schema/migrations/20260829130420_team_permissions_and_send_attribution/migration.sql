-- AlterEnum
ALTER TYPE "AdminRole" ADD VALUE 'MEMBER';

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "createdByName" VARCHAR(160);

-- AlterTable
ALTER TABLE "OutreachMessage" ADD COLUMN     "sentById" TEXT,
ADD COLUMN     "sentByName" VARCHAR(160);

-- AlterTable
ALTER TABLE "OutreachThread" ADD COLUMN     "startedById" TEXT,
ADD COLUMN     "startedByName" VARCHAR(160);

-- CreateIndex
CREATE INDEX "AdminUser_role_isActive_idx" ON "AdminUser"("role", "isActive");

-- CreateIndex
CREATE INDEX "OutreachCampaign_createdById_idx" ON "OutreachCampaign"("createdById");

-- CreateIndex
CREATE INDEX "OutreachMessage_sentById_sentAt_idx" ON "OutreachMessage"("sentById", "sentAt");

-- CreateIndex
CREATE INDEX "OutreachThread_startedById_idx" ON "OutreachThread"("startedById");

-- AddForeignKey
ALTER TABLE "AdminUser" ADD CONSTRAINT "AdminUser_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachThread" ADD CONSTRAINT "OutreachThread_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
