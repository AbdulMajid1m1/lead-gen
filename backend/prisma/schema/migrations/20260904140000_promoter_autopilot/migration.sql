-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN "promotedProductId" TEXT;

-- CreateTable
CREATE TABLE "PromoterAutopilot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "accountId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyLimit" INTEGER,
    "windowStart" INTEGER NOT NULL DEFAULT 9,
    "windowEnd" INTEGER NOT NULL DEFAULT 13,
    "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "sendDays" JSONB NOT NULL DEFAULT '[1, 2, 3, 4, 5]',
    "lastRunAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoterAutopilot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoterAutopilot_productId_key" ON "PromoterAutopilot"("productId");

-- CreateIndex
CREATE INDEX "PromoterAutopilot_enabled_idx" ON "PromoterAutopilot"("enabled");

-- CreateIndex
CREATE INDEX "OutreachCampaign_promotedProductId_idx" ON "OutreachCampaign"("promotedProductId");

-- AddForeignKey
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_promotedProductId_fkey" FOREIGN KEY ("promotedProductId") REFERENCES "PromotedProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoterAutopilot" ADD CONSTRAINT "PromoterAutopilot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "PromotedProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoterAutopilot" ADD CONSTRAINT "PromoterAutopilot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
