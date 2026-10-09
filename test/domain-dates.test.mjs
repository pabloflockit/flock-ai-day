import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCalendarDate,
  addDays,
  diffDays,
  dayOfWeek,
  isoWeek,
  isoWeekKey,
  compareCalendarDates,
} from '../shared/domain/dates.mjs';

const BA = 'America/Argentina/Buenos_Aires';

test('toCalendarDate converts an instant to the calendar of the given zone', () => {
  assert.equal(toCalendarDate('2024-03-02T01:00:00Z', BA), '2024-03-01'); // 22:00 local
  assert.equal(toCalendarDate('2024-03-02T01:00:00Z', 'UTC'), '2024-03-02');
  assert.equal(toCalendarDate('2024-03-01T02:59:59Z', BA), '2024-02-29'); // leap day, 23:59:59
  assert.equal(toCalendarDate('2024-03-01T03:00:00Z', BA), '2024-03-01'); // 00:00 local
  assert.equal(toCalendarDate('2024-12-31T23:30:00Z', 'Asia/Tokyo'), '2025-01-01');
});

test('toCalendarDate follows DST offsets', () => {
  // Madrid: UTC+1 before 2024-03-31 01:00Z, UTC+2 after.
  assert.equal(toCalendarDate('2024-03-30T23:30:00Z', 'Europe/Madrid'), '2024-03-31');
  assert.equal(toCalendarDate('2024-03-31T21:59:00Z', 'Europe/Madrid'), '2024-03-31');
  assert.equal(toCalendarDate('2024-03-31T22:00:00Z', 'Europe/Madrid'), '2024-04-01');
});

test('toCalendarDate rejects invalid instants', () => {
  assert.throws(() => toCalendarDate('nope', 'UTC'), /instant/i);
});

test('addDays and diffDays are pure UTC calendar arithmetic', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-28', 2), '2024-03-01');
  assert.equal(addDays('2024-01-01', -1), '2023-12-31');
  assert.equal(addDays('2024-03-30', 2), '2024-04-01'); // across Madrid spring DST
  assert.equal(addDays('2024-10-26', 2), '2024-10-28'); // across Madrid autumn DST
  assert.equal(diffDays('2024-03-30', '2024-04-01'), 2);
  assert.equal(diffDays('2024-04-01', '2024-03-30'), -2);
  assert.equal(diffDays('2024-10-26', '2024-10-28'), 2);
  assert.equal(diffDays('2023-01-01', '2024-01-01'), 365);
});

test('arithmetic does not depend on the process time zone', () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ['America/Argentina/Buenos_Aires', 'Europe/Madrid', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      assert.equal(addDays('2024-03-30', 2), '2024-04-01');
      assert.equal(diffDays('2024-03-30', '2024-04-01'), 2);
      assert.equal(dayOfWeek('2024-03-31'), 7);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test('invalid calendar dates throw', () => {
  for (const bad of ['2024-02-30', '2024-13-01', '2024-1-1', '2024-03-01T00:00:00Z', '', null]) {
    assert.throws(() => addDays(/** @type {any} */ (bad), 1), /calendar date/i, String(bad));
  }
});

test('dayOfWeek is Mon=1..Sun=7', () => {
  assert.equal(dayOfWeek('2024-03-04'), 1);
  assert.equal(dayOfWeek('2024-03-08'), 5);
  assert.equal(dayOfWeek('2024-03-09'), 6);
  assert.equal(dayOfWeek('2024-03-10'), 7);
});

test('isoWeek handles the year boundary (Dec 29 - Jan 4)', () => {
  // 2024-12-30 (Mon) is week 1 of 2025.
  assert.deepEqual(isoWeek('2024-12-29'), { year: 2024, week: 52 });
  assert.deepEqual(isoWeek('2024-12-30'), { year: 2025, week: 1 });
  assert.deepEqual(isoWeek('2025-01-04'), { year: 2025, week: 1 });
  assert.deepEqual(isoWeek('2025-01-05'), { year: 2025, week: 1 });
  assert.deepEqual(isoWeek('2025-01-06'), { year: 2025, week: 2 });
  // 2021-01-01 (Fri) belongs to week 53 of 2020; 2020 has 53 weeks.
  assert.deepEqual(isoWeek('2021-01-01'), { year: 2020, week: 53 });
  assert.deepEqual(isoWeek('2021-01-03'), { year: 2020, week: 53 });
  assert.deepEqual(isoWeek('2021-01-04'), { year: 2021, week: 1 });
  // 2026-12-31 (Thu) is week 53 of 2026; 2027-01-01 (Fri) too.
  assert.deepEqual(isoWeek('2026-12-31'), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek('2027-01-01'), { year: 2026, week: 53 });
  assert.deepEqual(isoWeek('2018-12-31'), { year: 2019, week: 1 });
});

test('isoWeekKey is zero padded', () => {
  assert.equal(isoWeekKey('2025-01-02'), '2025-W01');
  assert.equal(isoWeekKey('2024-12-29'), '2024-W52');
  assert.equal(isoWeekKey('2021-01-01'), '2020-W53');
});

test('compareCalendarDates orders lexicographically', () => {
  assert.equal(compareCalendarDates('2024-03-01', '2024-03-02'), -1);
  assert.equal(compareCalendarDates('2024-03-02', '2024-03-01'), 1);
  assert.equal(compareCalendarDates('2024-03-01', '2024-03-01'), 0);
  assert.deepEqual(['2024-03-10', '2023-12-31', '2024-03-02'].sort(compareCalendarDates), [
    '2023-12-31',
    '2024-03-02',
    '2024-03-10',
  ]);
});
