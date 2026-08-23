/**
 * Freshness decay.
 *
 * This is what stops an eight-month-old discovery from looking like today's
 * opportunity. A hiring signal (14-day half-life) is worth half its weight after
 * two weeks; a structural tech-debt signal (365 days) barely moves, because a
 * site that lacked a viewport tag last year almost certainly still does.
 */
export const decayFactor = (signal, now = Date.now()) => {
  if (!signal.halfLifeDays) return 1;
  const ageDays = Math.max(0, (now - new Date(signal.detectedAt).getTime()) / 86_400_000);
  return 0.5 ** (ageDays / signal.halfLifeDays);
};

export const ageInDays = (date, now = Date.now()) =>
  Math.max(0, (now - new Date(date).getTime()) / 86_400_000);

/** Human relative time used in lead cards and freshness badges. */
export const relativeAge = (date) => {
  const days = ageInDays(date);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 7) return `${Math.round(days)} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${(days / 365).toFixed(1)} years ago`;
};

/** Freshness buckets the UI filters on. */
export const freshnessBucket = (date) => {
  const days = ageInDays(date);
  if (days < 1) return "NEW_TODAY";
  if (days < 7) return "NEW_THIS_WEEK";
  if (days < 30) return "THIS_MONTH";
  if (days < 90) return "THIS_QUARTER";
  return "OLDER";
};
