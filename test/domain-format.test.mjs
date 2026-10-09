import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCalendarDate, formatInstant } from '../shared/domain/format.mjs';

test('a calendar date never shifts, whatever the process zone', () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ['America/Argentina/Buenos_Aires', 'UTC', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      assert.equal(formatCalendarDate('2024-03-01', 'es-AR'), '1/3/2024', tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test('formatCalendarDate rejects anything that is not YYYY-MM-DD', () => {
  assert.throws(() => formatCalendarDate('2024-03-01T00:00:00Z', 'es-AR'), /calendar date/i);
});

test('formatInstant renders in the given zone', () => {
  const iso = '2024-03-02T01:00:00Z';
  assert.match(formatInstant(iso, 'es-AR', 'America/Argentina/Buenos_Aires'), /^1\/3\/2024,? 22:00$/);
  assert.match(formatInstant(iso, 'es-AR', 'UTC'), /^2\/3\/2024,? 01:00$/);
  assert.match(formatInstant(iso, 'es-AR', 'Europe/Madrid'), /^2\/3\/2024,? 02:00$/);
});

test('a calendar date through the instant formatter shifts a day in UTC-3 (the bug to avoid)', () => {
  const shifted = formatInstant('2024-03-01T00:00:00Z', 'es-AR', 'America/Argentina/Buenos_Aires');
  assert.match(shifted, /^29\/2\/2024/);
});

test('formatInstant rejects invalid instants', () => {
  assert.throws(() => formatInstant('nope', 'es-AR', 'UTC'), /instant/i);
});
