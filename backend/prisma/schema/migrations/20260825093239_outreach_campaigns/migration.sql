-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CampaignSendState" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "channels" JSONB NOT NULL,
    "accountId" TEXT,
    "waAccountId" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'RUNNING',
    "paceSeconds" INTEGER NOT NULL DEFAULT 45,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "emailState" "CampaignSendState" NOT NULL DEFAULT 'PENDING',
    "emailDetail" VARCHAR(300),
    "waState" "CampaignSendState" NOT NULL DEFAULT 'PENDING',
    "waDetail" VARCHAR(300),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachCampaign_status_createdAt_idx" ON "OutreachCampaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_emailState_idx" ON "CampaignRecipient"("campaignId", "emailState");

-- CreateIndex
CREATE INDEX "CampaignRecipient_campaignId_waState_idx" ON "CampaignRecipient"("campaignId", "waState");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignRecipient_campaignId_leadId_key" ON "CampaignRecipient"("campaignId", "leadId");

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
