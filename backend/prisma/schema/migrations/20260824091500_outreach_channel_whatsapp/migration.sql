-- Add WHATSAPP to OutreachChannel.
--
-- The WhatsApp send/reply code has always written `channel: "WHATSAPP"`, but
-- the value was never added to the enum — so every WhatsApp send delivered the
-- message and *then* threw on the tracking insert, leaving no thread behind for
-- the reply matcher to find. Additive, and safe for the running release: no
-- existing row uses the value.
ALTER TYPE "OutreachChannel" ADD VALUE IF NOT EXISTS 'WHATSAPP' AFTER 'EMAIL';
