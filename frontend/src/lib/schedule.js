/**
 * Pure schedule arithmetic for bulk sends: which local days a campaign works,
 * when its first and last messages go out, and the words that explain it.
 *
 * No React and no API in here, so the sheet that plans a campaign and the card
 * that describes a live one say the same thing about the same numbers.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * The three working weeks a user is likely to want. Custom day sets are still
 * accepted by the API; the sheet just does not need seven checkboxes to cover
 * the real cases.
 */
export const SEND_DAY_PRESETS = [
  { key: "weekdays", label: "Mon–Fri", days: [1, 2, 3, 4, 5], hint: "The working week in Europe, the UK and the Americas." },
  { key: "gulf", label: "Sun–Thu", days: [0, 1, 2, 3, 4], hint: "The working week in Saudi Arabia and most of the Gulf." },
  { key: "daily", label: "Every day", days: EVERY_DAY, hint: "Fastest, but weekend cold email reads as bulk and is answered less." },
];

const sorted = (days) => [...days].sort((a, b) => a - b);
const sameDays = (a = [], b = []) => {
  const x = sorted(a); const y = sorted(b);
  return x.length === y.length && x.every((d, i) => d === y[i]);
};

export const presetKeyFor = (days) => SEND_DAY_PRESETS.find((p) => sameDays(p.days, days))?.key ?? "custom";
export const daysForPreset = (key) => SEND_DAY_PRESETS.find((p) => p.key === key)?.days ?? EVERY_DAY;

/** "Mon–Fri", "Sun–Thu", "every day" — or the list, for anything custom. */
export const describeDays = (days) => {
  const list = days?.length ? days : EVERY_DAY;
  const preset = SEND_DAY_PRESETS.find((p) => sameDays(p.days, list));
  if (preset) return preset.key === "daily" ? "every day" : preset.label;
  return sorted(list).map((d) => DAY_LABELS[d]).join(", ");
};

export const hourLabel = (h) => `${String(h).padStart(2, "0")}:00`;

const pad = (n) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DDTHH:MM", the value shape a datetime-local input speaks. */
export const toDateTimeLocal = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The reverse; null for an empty or unparseable value. */
export const fromDateTimeLocal = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The next day on which `days` allows sending, at `hour` o'clock, at least
 * `minDaysAhead` days after `from`. "Tomorrow morning" that knows about
 * weekends.
 */
export const nextSendMorning = ({ from = new Date(), hour = 9, days = EVERY_DAY, minDaysAhead = 1 } = {}) => {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  for (let i = 0; i < 7; i += 1) {
    if (days.includes(d.getDay())) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
};

/** The next occurrence of a weekday strictly after `from`, at `hour`. */
export const nextWeekday = (weekday, { from = new Date(), hour = 9 } = {}) => {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== weekday);
  return d;
};

const startOfDay = (date) => { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; };

/**
 * Walk the calendar from `startAt` and work out when an AUTO campaign's first
 * and last messages go out.
 *
 * The first day only gets the share of the quota its remaining window allows:
 * a 16:00 start on a 09:00–18:00 window is two hours of sending, not a full
 * day's, and the sheet must not promise otherwise.
 *
 * @returns {null|{firstSendAt: Date, lastSendAt: Date, sendingDays: number, calendarDays: number}}
 */
export const estimateAutoSchedule = ({ count, dailyLimit, sendDays, windowStart, windowEnd, startAt = new Date() }) => {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const perDay = Math.max(1, Math.floor(Number(dailyLimit) || 0));
  const days = sendDays?.length ? sendDays : EVERY_DAY;
  if (total === 0 || !(windowEnd > windowStart)) return null;
  const windowHours = windowEnd - windowStart;

  let remaining = total;
  let sendingDays = 0;
  let firstSendAt = null;
  let lastSendAt = null;
  const cursor = new Date(startAt);

  // 400 days is far beyond the 90-day scheduling horizon plus any sane list.
  for (let i = 0; i < 400 && remaining > 0; i += 1) {
    if (days.includes(cursor.getDay())) {
      const open = new Date(cursor); open.setHours(windowStart, 0, 0, 0);
      const close = new Date(cursor); close.setHours(windowEnd, 0, 0, 0);
      const begins = cursor > open ? cursor : open;
      if (begins < close) {
        const share = Math.max(1, Math.round(perDay * ((close - begins) / HOUR_MS) / windowHours));
        const batch = Math.min(share, remaining);
        if (!firstSendAt) firstSendAt = begins;
        remaining -= batch;
        sendingDays += 1;
        // A day that is not filled ends early, in proportion.
        lastSendAt = batch < share ? new Date(begins.getTime() + (close - begins) * (batch / share)) : close;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  if (!firstSendAt) return null;

  return {
    firstSendAt, lastSendAt, sendingDays,
    calendarDays: Math.floor((startOfDay(lastSendAt) - startOfDay(firstSendAt)) / DAY_MS) + 1,
  };
};

/** "Mon 1 Sep, 09:00" — short enough for a summary line, unambiguous about the day. */
export const formatMoment = (date) =>
  new Date(date).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
