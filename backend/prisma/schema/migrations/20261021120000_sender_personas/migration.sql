-- Who a message is signed by, chosen per campaign and per WhatsApp device and
-- remembered per thread, so a chase signs off as the person who opened it.
-- Plain ids, no foreign keys: a deleted signature falls back to the mailbox's
-- own sign-off at send time rather than blocking the delete.
ALTER TABLE "OutreachCampaign" ADD COLUMN "signatureId" TEXT;
ALTER TABLE "OutreachThread" ADD COLUMN "signatureId" TEXT;
ALTER TABLE "WhatsAppAccount" ADD COLUMN "signatureId" TEXT;
