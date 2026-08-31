-- CreateTable
CREATE TABLE "OutreachAutopilot" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "channels" JSONB NOT NULL DEFAULT '["EMAIL"]',
    "restrictedPolicy" VARCHAR(20) NOT NULL DEFAULT 'ROLE_ONLY',
    "dailyLimit" INTEGER,
    "windowStart" INTEGER NOT NULL DEFAULT 9,
    "windowEnd" INTEGER NOT NULL DEFAULT 13,
    "sendDays" JSONB NOT NULL DEFAULT '[2, 3, 4]',
    "lastRunAt" TIMESTAMP(3),
    "lastResult" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachAutopilot_pkey" PRIMARY KEY ("id")
);
