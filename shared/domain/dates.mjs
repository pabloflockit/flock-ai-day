/**
 * Calendar-date helpers (architecture §9). Pure: no I/O, no clock, no `node:` imports, so the
 * proxy and Angular both import them.
 *
 * Two kinds of date exist and must not be mixed:
 *  - an INSTANT is an ISO string with `Z` (`2024-03-02T01:00:00Z`);
 *  - a CALENDAR DATE is `YYYY-MM-DD`, with no time and no zone.
 * `toCalendarDate` is the only bridge, and it takes the zone explicitly. All arithmetic on
 * calendar dates happens in UTC, so a DST change can never shift a day. Local `Date`
 * constructors (`new Date(y, m, d)`) are never used.
 */

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * Parses a calendar date to a UTC midnight timestamp; throws on anything that is not a real date.
 * @param {string} date
 * @returns {number}
 */
function toUtcMs(date) {
  const match = typeof date === 'string' ? CALENDAR_DATE.exec(date) : null;
  if (!match) throw new Error(`Invalid calendar date: ${String(date)}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    throw new Error(`Invalid calendar date: ${date}`);
  }
  return ms;
}

/**
 * @param {number} ms UTC midnight timestamp
 * @returns {string}
 */
function fromUtcMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Calendar date (`YYYY-MM-DD`) of an instant on the calendar of `timeZone`.
 * `timeZone` is required: pure functions never read the system zone (call sites pass
 * `Intl.DateTimeFormat().resolvedOptions().timeZone`).
 *
 * @param {string} instantISO ISO string with `Z`
 * @param {string} timeZone IANA zone, e.g. `America/Argentina/Buenos_Aires`
 * @returns {string}
 */
export function toCalendarDate(instantISO, timeZone) {
  const ms = typeof instantISO === 'string' ? Date.parse(instantISO) : NaN;
  if (Number.isNaN(ms)) throw new Error(`Invalid instant: ${String(instantISO)}`);
  if (typeof timeZone !== 'string' || timeZone === '') throw new Error('timeZone is required');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (/** @type {string} */ type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}`;
}

/**
 * @param {string} date calendar date
 * @param {number} n days to add (may be negative)
 * @returns {string}
 */
export function addDays(date, n) {
  return fromUtcMs(toUtcMs(date) + n * MS_PER_DAY);
}

/**
 * Whole days from `a` to `b` (`b - a`).
 * @param {string} a calendar date
 * @param {string} b calendar date
 * @returns {number}
 */
export function diffDays(a, b) {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / MS_PER_DAY);
}

/**
 * ISO day of the week: Monday = 1 ... Sunday = 7.
 * @param {string} date calendar date
 * @returns {number}
 */
export function dayOfWeek(date) {
  const day = new Date(toUtcMs(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

/**
 * ISO 8601 week: the week belongs to the year that contains its Thursday.
 * @param {string} date calendar date
 * @returns {{ year: number, week: number }}
 */
export function isoWeek(date) {
  const thursday = toUtcMs(date) + (4 - dayOfWeek(date)) * MS_PER_DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / MS_PER_DAY / 7) + 1;
  return { year, week };
}

/**
 * @param {string} date calendar date
 * @returns {string} `YYYY-Www`
 */
export function isoWeekKey(date) {
  const { year, week } = isoWeek(date);
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
}

/**
 * Comparator for `sort`: `YYYY-MM-DD` orders lexicographically.
 * @param {string} a calendar date
 * @param {string} b calendar date
 * @returns {-1 | 0 | 1}
 */
export function compareCalendarDates(a, b) {
  toUtcMs(a);
  toUtcMs(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
