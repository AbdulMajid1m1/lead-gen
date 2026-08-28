-- The signal catalog has emitted these three for a while, but they were never
-- added to the enum, so every attempt to write one threw
-- "Invalid value for argument `type`. Expected SignalType." and was swallowed by
-- the per-company catch in the SIGNALS step.
--
-- The cost was silent: NAMED_CONTACT_FOUND is a reachability signal, and
-- BUSINESS_CLOSED and WEBSITE_NOT_OWNED are the two disqualifiers that stop us
-- contacting a business that has shut down or a domain the company does not own.
-- None of them has ever been stored.
ALTER TYPE "SignalType" ADD VALUE IF NOT EXISTS 'NAMED_CONTACT_FOUND';
ALTER TYPE "SignalType" ADD VALUE IF NOT EXISTS 'BUSINESS_CLOSED';
ALTER TYPE "SignalType" ADD VALUE IF NOT EXISTS 'WEBSITE_NOT_OWNED';
