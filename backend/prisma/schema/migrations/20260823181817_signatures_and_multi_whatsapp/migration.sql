-- CreateEnum
CREATE TYPE "WhatsAppAccountStatus" AS ENUM ('CONNECTED', 'PAIRING', 'DISCONNECTED', 'ERROR');

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "signatureId" TEXT;

-- AlterTable
ALTER TABLE "OutreachThread" ADD COLUMN     "waAccountId" TEXT;

-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "fullName" VARCHAR(120) NOT NULL,
    "title" VARCHAR(120),
    "company" VARCHAR(120),
    "website" VARCHAR(200),
    "email" VARCHAR(255),
    "phone" VARCHAR(40),
    "tagline" VARCHAR(300),
    "accentColor" VARCHAR(9) NOT NULL DEFAULT '#4f39f6',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "id" TEXT NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumber" VARCHAR(30),
    "pushName" VARCHAR(120),
    "status" "WhatsAppAccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "lastError" VARCHAR(500),
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Signature_name_key" ON "Signature"("name");

-- CreateIndex
CREATE INDEX "Signature_isDefault_idx" ON "Signature"("isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_phoneNumber_key" ON "WhatsAppAccount"("phoneNumber");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_isDefault_idx" ON "WhatsAppAccount"("isDefault");

-- CreateIndex
CREATE INDEX "OutreachThread_waAccountId_status_idx" ON "OutreachThread"("waAccountId", "status");

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_signatureId_fkey" FOREIGN KEY ("signatureId") REFERENCES "Signature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachThread" ADD CONSTRAINT "OutreachThread_waAccountId_fkey" FOREIGN KEY ("waAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
