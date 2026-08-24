-- Move the signature accent default off the old violet brand colour.
--
-- The console's primary is now the orange the rest of the UI uses, and a
-- signature created without an explicit colour was still coming out violet.
-- Only the column default changes: existing rows keep whatever colour their
-- owner picked, including the ones sitting on the old default, because
-- rewriting a colour someone may have chosen deliberately is not this
-- migration's call.
ALTER TABLE "Signature" ALTER COLUMN "accentColor" SET DEFAULT '#d97757';
