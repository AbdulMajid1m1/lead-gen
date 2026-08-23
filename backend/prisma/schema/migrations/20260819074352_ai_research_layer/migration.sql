-- CreateEnum
CREATE TYPE "AiClaimField" AS ENUM ('EMAIL', 'PHONE', 'WHATSAPP', 'ADDRESS', 'WEBSITE', 'DESCRIPTION');

-- CreateEnum
CREATE TYPE "AiClaimStatus" AS ENUM ('UNVERIFIED', 'CONFIRMED_OWN_SITE', 'CONFIRMED_THIRD_PARTY', 'CONTRADICTED', 'UNCHECKABLE', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "AiCandidateStatus" AS ENUM ('PENDING', 'MATCHED_EXISTING', 'CREATED_COMPANY', 'REJECTED_UNCITED', 'REJECTED_NO_EXISTENCE', 'REJECTED_EXCLUDED');

-- AlterEnum
ALTER TYPE "SourceKind" ADD VALUE 'AI_WEB_SEARCH';

-- AlterTable
ALTER TABLE "DiscoveryRun" ADD COLUMN     "aiUsage" JSONB;

-- CreateTable
CREATE TABLE "ResearchBrief" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "searchQueryId" TEXT,
    "brief" JSONB NOT NULL,
    "producedBy" "ParserUsed" NOT NULL DEFAULT 'DETERMINISTIC',
    "model" VARCHAR(60),
    "promptVersion" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCandidate" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceRecordId" TEXT NOT NULL,
    "strategyLabel" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "nameLocal" VARCHAR(160),
    "claimedWebsite" VARCHAR(300),
    "claimedCity" VARCHAR(80),
    "industryGuess" VARCHAR(60),
    "whyMatch" VARCHAR(300) NOT NULL,
    "matchConfidence" VARCHAR(10) NOT NULL,
    "uncited" BOOLEAN NOT NULL DEFAULT false,
    "status" "AiCandidateStatus" NOT NULL DEFAULT 'PENDING',
    "companyId" TEXT,
    "matchedOn" VARCHAR(20),
    "rejectedReason" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiClaim" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "field" "AiClaimField" NOT NULL,
    "value" VARCHAR(500) NOT NULL,
    "foundOnUrl" VARCHAR(600),
    "status" "AiClaimStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedContactId" TEXT,
    "crawlResultId" TEXT,
    "checkedAt" TIMESTAMP(3),
    "note" VARCHAR(300),

    CONSTRAINT "AiClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCitation" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "url" VARCHAR(600) NOT NULL,
    "title" VARCHAR(300),
    "inSources" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AiCitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEmailDraft" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "runId" TEXT,
    "subject" VARCHAR(200) NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "aboutCompany" VARCHAR(1000) NOT NULL,
    "groundingFacts" JSONB NOT NULL,
    "factIdsUsed" JSONB NOT NULL,
    "generatedBy" "ParserUsed" NOT NULL DEFAULT 'LLM',
    "confidenceLevel" "ConfidenceLevel" NOT NULL DEFAULT 'AI_GENERATED',
    "model" VARCHAR(60),
    "promptVersion" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEmailDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchResultRow" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "leadId" TEXT,
    "candidateId" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchResultRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchBrief_runId_key" ON "ResearchBrief"("runId");

-- CreateIndex
CREATE INDEX "AiCandidate_runId_status_idx" ON "AiCandidate"("runId", "status");

-- CreateIndex
CREATE INDEX "AiCandidate_companyId_idx" ON "AiCandidate"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "AiCandidate_runId_sourceRecordId_name_key" ON "AiCandidate"("runId", "sourceRecordId", "name");

-- CreateIndex
CREATE INDEX "AiClaim_status_idx" ON "AiClaim"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AiClaim_candidateId_field_key" ON "AiClaim"("candidateId", "field");

-- CreateIndex
CREATE INDEX "AiCitation_candidateId_idx" ON "AiCitation"("candidateId");

-- CreateIndex
CREATE INDEX "LeadEmailDraft_leadId_createdAt_idx" ON "LeadEmailDraft"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadEmailDraft_runId_idx" ON "LeadEmailDraft"("runId");

-- CreateIndex
CREATE INDEX "ResearchResultRow_leadId_idx" ON "ResearchResultRow"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchResultRow_runId_rank_key" ON "ResearchResultRow"("runId", "rank");

-- AddForeignKey
ALTER TABLE "ResearchBrief" ADD CONSTRAINT "ResearchBrief_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCandidate" ADD CONSTRAINT "AiCandidate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiClaim" ADD CONSTRAINT "AiClaim_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AiCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCitation" ADD CONSTRAINT "AiCitation_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "AiCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEmailDraft" ADD CONSTRAINT "LeadEmailDraft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEmailDraft" ADD CONSTRAINT "LeadEmailDraft_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchResultRow" ADD CONSTRAINT "ResearchResultRow_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
