import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDaysBetween } from '../shared/domain/business-days.mjs';

const BA = 'America/Argentina/Buenos_Aires';
const bd = (from, to, timeZone = 'UTC', extra = {}) =>
  businessDaysBetween(from, to, { timeZone, ...extra });

test('same local day is 0, whatever the time of day', () => {
  assert.equal(bd('2024-03-04T00:00:00Z', '2024-03-04T23:59:59Z'), 0);
  assert.equal(bd('2024-03-04T12:00:00Z', '2024-03-04T12:00:00Z'), 0);
});

test('start day is excluded, end day included', () => {
  assert.equal(bd('2024-03-04T10:00:00Z', '2024-03-05T09:00:00Z'), 1); // Mon -> Tue
  assert.equal(bd('2024-03-04T10:00:00Z', '2024-03-08T10:00:00Z'), 4); // Mon -> Fri
  assert.equal(bd('2024-03-04T10:00:00Z', '2024-03-11T10:00:00Z'), 5); // Mon -> next Mon
});

test('Friday to Monday is 1', () => {
  assert.equal(bd('2024-03-08T15:00:00Z', '2024-03-11T09:00:00Z'), 1);
});

test('weekend start: Sat/Sun to Monday is 1, to Saturday/Sunday is 0', () => {
  assert.equal(bd('2024-03-09T12:00:00Z', '2024-03-11T12:00:00Z'), 1); // Sat -> Mon
  assert.equal(bd('2024-03-10T12:00:00Z', '2024-03-11T12:00:00Z'), 1); // Sun -> Mon
  assert.equal(bd('2024-03-08T12:00:00Z', '2024-03-09T12:00:00Z'), 0); // Fri -> Sat
  assert.equal(bd('2024-03-08T12:00:00Z', '2024-03-10T12:00:00Z'), 0); // Fri -> Sun
  assert.equal(bd('2024-03-09T12:00:00Z', '2024-03-10T12:00:00Z'), 0); // Sat -> Sun
});

test('instants are converted to the local day first (22:00 in UTC-3 is still that day)', () => {
  // Fri 2024-03-08 22:00 in Buenos Aires = Sat 01:00Z. Monday 10:00 local = 13:00Z.
  assert.equal(bd('2024-03-09T01:00:00Z', '2024-03-11T13:00:00Z', BA), 1); // Fri -> Mon
  // Mon 22:00 local = Tue 01:00Z; to Tue 10:00 local: 1 in BA, 0 in UTC.
  assert.equal(bd('2024-03-05T01:00:00Z', '2024-03-05T13:00:00Z', BA), 1);
  assert.equal(bd('2024-03-05T01:00:00Z', '2024-03-05T13:00:00Z', 'UTC'), 0);
  // Same local day, different UTC day.
  assert.equal(bd('2024-03-05T01:00:00Z', '2024-03-05T02:59:00Z', BA), 0);
  assert.equal(bd('2024-03-08T12:00:00Z', '2024-03-09T01:00:00Z', BA), 0);
});

test('works across a DST change (Madrid, 2024-03-31)', () => {
  assert.equal(bd('2024-03-29T10:00:00Z', '2024-04-01T10:00:00Z', 'Europe/Madrid'), 1); // Fri -> Mon
  assert.equal(bd('2024-03-28T10:00:00Z', '2024-04-02T10:00:00Z', 'Europe/Madrid'), 3); // Thu -> Tue
  // Sat 03-30 23:30 local (22:30Z) -> Mon 04-01 07:00 local (05:00Z)
  assert.equal(bd('2024-03-30T22:30:00Z', '2024-04-01T05:00:00Z', 'Europe/Madrid'), 1);
});

test('reversed arguments give the negated count', () => {
  assert.equal(bd('2024-03-11T09:00:00Z', '2024-03-08T15:00:00Z'), -1);
  assert.equal(bd('2024-03-11T09:00:00Z', '2024-03-04T09:00:00Z'), -5);
  assert.equal(bd('2024-03-04T09:00:00Z', '2024-03-04T08:00:00Z'), 0);
});

test('isHoliday hook removes business days (default: none)', () => {
  const holiday = (d) => d === '2024-03-05';
  assert.equal(bd('2024-03-04T10:00:00Z', '2024-03-06T10:00:00Z'), 2);
  assert.equal(bd('2024-03-04T10:00:00Z', '2024-03-06T10:00:00Z', 'UTC', { isHoliday: holiday }), 1);
  // a holiday on a weekend is not counted twice
  const weekend = (d) => d === '2024-03-09';
  assert.equal(bd('2024-03-08T10:00:00Z', '2024-03-11T10:00:00Z', 'UTC', { isHoliday: weekend }), 1);
});

test('a missing timeZone is an error, not a silent local default', () => {
  assert.throws(
    () => businessDaysBetween('2024-03-04T10:00:00Z', '2024-03-05T10:00:00Z', /** @type {any} */ ({})),
    /timeZone/,
  );
});
