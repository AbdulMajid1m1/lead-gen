-- CreateEnum
CREATE TYPE "PromotedProductStatus" AS ENUM ('RESEARCHING', 'ICP_REVIEW', 'READY', 'FAILED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "ServiceType" ADD VALUE 'SAAS_PRODUCT';

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "promotedProductId" TEXT;

-- AlterTable
ALTER TABLE "LeadEmailDraft" ADD COLUMN     "promotedProductId" TEXT;

-- CreateTable
CREATE TABLE "PromotedProduct" (
    "id" TEXT NOT NULL,
    "url" VARCHAR(300) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "PromotedProductStatus" NOT NULL DEFAULT 'RESEARCHING',
    "summary" VARCHAR(2000),
    "category" VARCHAR(120),
    "features" JSONB,
    "pricing" JSONB,
    "differentiators" JSONB,
    "proofPoints" JSONB,
    "competitors" JSONB,
    "geographyCues" JSONB,
    "researchedUrls" JSONB,
    "icp" JSONB,
    "icpApprovedAt" TIMESTAMP(3),
    "pitchAngle" VARCHAR(400),
    "proofLink" VARCHAR(300),
    "senderContext" VARCHAR(400),
    "model" VARCHAR(60),
    "promptVersion" VARCHAR(20),
    "aiUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromotedProduct_url_key" ON "PromotedProduct"("url");

-- CreateIndex
CREATE INDEX "PromotedProduct_status_updatedAt_idx" ON "PromotedProduct"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "DiscoveryRun_promotedProductId_createdAt_idx" ON "DiscoveryRun"("promotedProductId", "createdAt");

-- AddForeignKey
ALTER TABLE "DiscoveryRun" ADD CONSTRAINT "DiscoveryRun_promotedProductId_fkey" FOREIGN KEY ("promotedProductId") REFERENCES "PromotedProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEmailDraft" ADD CONSTRAINT "LeadEmailDraft_promotedProductId_fkey" FOREIGN KEY ("promotedProductId") REFERENCES "PromotedProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
