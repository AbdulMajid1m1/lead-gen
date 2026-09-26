-- Where a candidate actually trades, when the researcher knows it. Nullable, so
-- every existing row keeps its current meaning (fall back to the run's country).
ALTER TABLE "AiCandidate" ADD COLUMN "claimedCountry" VARCHAR(2);
