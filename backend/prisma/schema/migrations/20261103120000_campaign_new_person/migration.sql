-- A campaign a person launched to reach a named decision-maker at companies
-- whose shared inbox already had an unanswered first email. Off by default, so
-- every existing campaign keeps the one-first-contact-per-30-days rule.
ALTER TABLE "OutreachCampaign" ADD COLUMN "newPersonAtCompany" BOOLEAN NOT NULL DEFAULT false;
