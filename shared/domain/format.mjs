/**
 * Display formatters. There are two on purpose, one per kind of date (architecture §9).
 */

/**
 * Formats a CALENDAR DATE (`YYYY-MM-DD`, e.g. `dueDate`). Rendered with `timeZone: 'UTC'`, so it
 * never moves. Do NOT pass an instant here; do NOT feed a calendar date to `formatInstant`: that
 * parses it as UTC midnight and shows the previous day in UTC-3.
 *
 * @param {string} date calendar date
 * @param {string} [locale]
 * @returns {string}
 */
export function formatCalendarDate(date, locale = 'es-AR') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid calendar date: ${String(date)}`);
  }
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid calendar date: ${date}`);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(ms));
}

/**
 * Formats an INSTANT (ISO with `Z`) in `timeZone` (default: the user's local zone, which is the
 * runtime's when omitted). Pass an explicit zone in tests.
 *
 * WARNING: a calendar date shown through this formatter shifts one day back in UTC-3
 * (`2024-03-01` -> 29/2 21:00). Use `formatCalendarDate` for `YYYY-MM-DD` values.
 *
 * @param {string} iso instant with `Z`
 * @param {string} [locale]
 * @param {string} [timeZone] IANA zone; omitted = local
 * @returns {string}
 */
export function formatInstant(iso, locale = 'es-AR', timeZone = undefined) {
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) throw new Error(`Invalid instant: ${String(iso)}`);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

