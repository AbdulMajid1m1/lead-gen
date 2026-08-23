import rateLimit from "express-rate-limit";

const envelope = (message) => ({ success: false, message });

export const generalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: envelope("Too many requests. Please try again shortly."),
});

// Search is cheap on its own but seeds discovery runs, so it is capped tighter.
export const searchLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: envelope("Too many searches. Please wait a moment."),
});

// A discovery run makes live requests to third-party services on our behalf.
// This limit is as much about being a good citizen to those sources as it is
// about protecting this server.
export const discoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: envelope("Discovery run limit reached for this hour. Existing results are still searchable."),
});

export const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: envelope("Too many changes. Please slow down."),
});
