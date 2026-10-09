import { addDays, dayOfWeek, diffDays, toCalendarDate } from './dates.mjs';

/**
 * Business days elapsed from `fromISO` to `toISO`.
 *
 * Convention (documented in docs/decisions.md): both instants are first converted to calendar
 * dates in `timeZone`; then the Monday-Friday days in the half-open range `(from, to]` are
 * counted. The start day is excluded and the end day is included, so:
 *  - same local day = 0;
 *  - Fri -> Mon = 1; Sat/Sun -> Mon = 1; Fri -> Sat/Sun = 0; Mon -> next Mon = 5.
 * Reversed arguments return the negated count (`f(a, b) === -f(b, a)`), so a "since" date in
 * the future yields a value <= 0 instead of throwing.
 *
 * Holidays are not modelled yet: `isHoliday(date)` is the hook for that evolution. It receives a
 * calendar date and only matters for Monday-Friday days.
 *
 * @param {string} fromISO instant with `Z`
 * @param {string} toISO instant with `Z`
 * @param {{ timeZone: string, isHoliday?: (date: string) => boolean }} options
 * @returns {number}
 */
export function businessDaysBetween(fromISO, toISO, { timeZone, isHoliday = () => false }) {
  if (typeof timeZone !== 'string' || timeZone === '') throw new Error('timeZone is required');
  const from = toCalendarDate(fromISO, timeZone);
  const to = toCalendarDate(toISO, timeZone);
  const span = diffDays(from, to);
  const sign = span < 0 ? -1 : 1;
  const [start, end] = span < 0 ? [to, from] : [from, to];
  let count = 0;
  for (let date = addDays(start, 1); date <= end; date = addDays(date, 1)) {
    if (dayOfWeek(date) <= 5 && !isHoliday(date)) count += 1;
  }
  return count === 0 ? 0 : sign * count;
}
