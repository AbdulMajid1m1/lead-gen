-- CreateEnum
CREATE TYPE "CampaignMode" AS ENUM ('DIRECT', 'AUTO');

-- AlterTable
ALTER TABLE "OutreachCampaign" ADD COLUMN     "dailyLimit" INTEGER,
ADD COLUMN     "mode" "CampaignMode" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "tzOffsetMinutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "windowEnd" INTEGER NOT NULL DEFAULT 18,
ADD COLUMN     "windowStart" INTEGER NOT NULL DEFAULT 9;
