-- Follow-ups written together with an authored opener. Null keeps the
-- template sequence; an array replaces it, and its length is the sequence.
ALTER TABLE "LeadEmailDraft" ADD COLUMN "followUps" JSONB;
