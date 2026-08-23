-- CreateEnum
CREATE TYPE "EmailAccountStatus" AS ENUM ('CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('AWAITING_REPLY', 'REPLIED', 'CLOSED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "OutreachMessageKind" AS ENUM ('INITIAL', 'FOLLOW_UP', 'REPLY');

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(20) NOT NULL DEFAULT 'GMAIL',
    "email" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(120),
    "smtpHost" VARCHAR(255) NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 465,
    "imapHost" VARCHAR(255) NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "authPassword" VARCHAR(500) NOT NULL,
    "status" "EmailAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "lastError" VARCHAR(500),
    "autoFollowUp" BOOLEAN NOT NULL DEFAULT true,
    "followUpDays" JSONB NOT NULL DEFAULT '[3, 7]',
    "maxFollowUps" INTEGER NOT NULL DEFAULT 2,
    "signature" VARCHAR(2000),
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachThread" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "recipientEmail" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "status" "ThreadStatus" NOT NULL DEFAULT 'AWAITING_REPLY',
    "lastOutboundAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "followUpsSent" INTEGER NOT NULL DEFAULT 0,
    "nextFollowUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "kind" "OutreachMessageKind" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "body" VARCHAR(8000) NOT NULL,
    "messageId" VARCHAR(255),
    "draftId" TEXT,
    "generatedBy" "ParserUsed",
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "fromAddress" VARCHAR(255),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_email_key" ON "EmailAccount"("email");

-- CreateIndex
CREATE INDEX "OutreachThread_leadId_idx" ON "OutreachThread"("leadId");

-- CreateIndex
CREATE INDEX "OutreachThread_status_nextFollowUpAt_idx" ON "OutreachThread"("status", "nextFollowUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachMessage_messageId_key" ON "OutreachMessage"("messageId");

-- CreateIndex
CREATE INDEX "OutreachMessage_threadId_createdAt_idx" ON "OutreachMessage"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "OutreachThread" ADD CONSTRAINT "OutreachThread_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachThread" ADD CONSTRAINT "OutreachThread_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "OutreachThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "LeadEmailDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
