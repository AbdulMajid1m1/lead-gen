-- A person can take a lead over. MANUAL stops every automated send
-- (campaigns, autopilot, scheduled follow-ups) until someone switches the
-- lead back to AUTO; sending by hand still works. IMPORTED marks leads a
-- person uploaded, which the scoring engine leaves alone.
CREATE TYPE "LeadSendMode" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "LeadOrigin" AS ENUM ('DISCOVERED', 'IMPORTED');

ALTER TABLE "Lead" ADD COLUMN     "notes" VARCHAR(2000),
ADD COLUMN     "origin" "LeadOrigin" NOT NULL DEFAULT 'DISCOVERED',
ADD COLUMN     "sendMode" "LeadSendMode" NOT NULL DEFAULT 'AUTO';

CREATE INDEX "Lead_sendMode_idx" ON "Lead"("sendMode");
