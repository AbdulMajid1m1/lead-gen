/**
 * Who sent it.
 *
 * Once more than one person can reach a lead, "which mailbox did this leave
 * from" stops answering "who contacted this company" — two colleagues sharing
 * hello@ are indistinguishable by mailbox alone. Every outbound row therefore
 * carries the console account behind it, plus a snapshot of that person's name
 * so the history stays readable after the account is deleted and the foreign
 * key has gone to null.
 *
 * A null actor is a real and expected value: it means the scheduler sent it
 * with nobody at the keyboard, and the UI says exactly that.
 */

const MAX_NAME = 160;

/**
 * Reduce a session user (or a stored *ById/*ByName pair) to the shape written
 * onto outreach rows. Returns null for anything without an id, so callers can
 * pass `req.auth?.user` straight in without guarding first.
 *
 * @param {{ id?: string, name?: string|null, email?: string|null }|null|undefined} user
 * @returns {{ id: string, name: string|null }|null}
 */
export const toActor = (user) => {
  if (!user) return null;
  const name = (user.name || user.email || "").trim().slice(0, MAX_NAME);
  // A name with no id is the automation identifying itself — "Autopilot · Gulf"
  // rather than an anonymous blank. The id stays null because no console
  // account did this, which is exactly what the history needs to be able to
  // say. Callers already read `actor?.id ?? null` and `actor?.name ?? null`,
  // so both halves land correctly without a second branch.
  if (!user.id) return name ? { id: null, name } : null;
  return { id: user.id, name: name || null };
};
