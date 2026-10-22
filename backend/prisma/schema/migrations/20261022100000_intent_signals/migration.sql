-- An organisation that has publicly asked for a supplier (tender, request for
-- quotes, contract role), and one that has just raised money to build.
ALTER TYPE "SignalType" ADD VALUE IF NOT EXISTS 'BUYER_REQUEST';
ALTER TYPE "SignalType" ADD VALUE IF NOT EXISTS 'FUNDING_RAISED';
