-- The sender's physical postal address, required by CAN-SPAM (US) and CASL (CA)
-- in every commercial email. Nullable: the send gate withholds those markets
-- while it is empty rather than the column forcing a value on every signature.
ALTER TABLE "Signature" ADD COLUMN "postalAddress" VARCHAR(300);
