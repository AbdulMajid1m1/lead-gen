-- CreateEnum
CREATE TYPE "DomainIdentityStatus" AS ENUM ('UNCHECKED', 'CONFIRMED', 'WEAK', 'REJECTED');

-- CreateEnum
CREATE TYPE "PersonSeniority" AS ENUM ('OWNER', 'EXECUTIVE', 'MARKETING', 'OPERATIONS', 'OTHER', 'UNKNOWN');

-- AlterEnum
-- Google Places joins the existing discovery sources. Adding the value without
-- using it in the same migration keeps this safe inside Prisma's transaction.
ALTER TYPE "SourceKind" ADD VALUE 'GOOGLE_PLACES';

-- AlterTable
-- Existing domains default to UNCHECKED, which preserves their current meaning:
-- they were accepted before the identity check existed and are re-checked on
-- the next crawl rather than being invalidated retroactively.
ALTER TABLE "CompanyDomain" ADD COLUMN     "identityCheckedAt" TIMESTAMP(3),
ADD COLUMN     "identityReason" VARCHAR(500),
ADD COLUMN     "identityScore" INTEGER,
ADD COLUMN     "identityStatus" "DomainIdentityStatus" NOT NULL DEFAULT 'UNCHECKED';

-- CreateTable
CREATE TABLE "CompanyPerson" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fullName" VARCHAR(200) NOT NULL,
    "title" VARCHAR(200),
    "seniority" "PersonSeniority" NOT NULL DEFAULT 'UNKNOWN',
    "email" VARCHAR(320),
    "linkedinUrl" VARCHAR(500),
    "profileUrl" VARCHAR(500),
    "observedOnUrl" VARCHAR(1000),
    "confidenceLevel" "ConfidenceLevel" NOT NULL,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyPerson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyDomain_identityStatus_idx" ON "CompanyDomain"("identityStatus");

-- CreateIndex
CREATE INDEX "CompanyPerson_companyId_idx" ON "CompanyPerson"("companyId");

-- CreateIndex
CREATE INDEX "CompanyPerson_seniority_idx" ON "CompanyPerson"("seniority");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyPerson_companyId_fullName_key" ON "CompanyPerson"("companyId", "fullName");

-- AddForeignKey
ALTER TABLE "CompanyPerson" ADD CONSTRAINT "CompanyPerson_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyPerson" ADD CONSTRAINT "CompanyPerson_sourceRecordId_fkey" FOREIGN KEY ("sourceRecordId") REFERENCES "SourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
