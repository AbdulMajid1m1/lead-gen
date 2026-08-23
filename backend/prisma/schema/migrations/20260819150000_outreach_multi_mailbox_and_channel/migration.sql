-- Backfills the multi-mailbox and WhatsApp-channel work that was applied to
-- development with `db push` and never captured as a migration. Production
-- deploys run `migrate deploy`, so without this file they would never get
-- these columns at all.

-- AlterTable
ALTER TABLE "public"."EmailAccount" ADD COLUMN     "imapPassword" VARCHAR(500),
ADD COLUMN     "imapUser" VARCHAR(255),
ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyTo" VARCHAR(255),
ADD COLUMN     "smtpUser" VARCHAR(255),
ALTER COLUMN "imapHost" DROP NOT NULL,
ALTER COLUMN "imapPort" DROP NOT NULL,
ALTER COLUMN "imapPort" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."OutreachThread" ADD COLUMN     "channel" "public"."OutreachChannel" NOT NULL DEFAULT 'EMAIL',
ALTER COLUMN "accountId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "EmailAccount_isDefault_idx" ON "public"."EmailAccount"("isDefault" ASC);

