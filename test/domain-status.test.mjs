import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveCategory,
  isOpen,
  isDoing,
  isDone,
  effectiveDoneAt,
  daysInStatus,
  isStale,
} from '../shared/domain/status.mjs';

const BA = 'America/Argentina/Buenos_Aires';
const config = (overrides = {}, staleBusinessDays = 5) => ({
  jira: { statusCategoryOverrides: overrides },
  settings: { staleBusinessDays },
});
const row = (o = {}) => ({
  key: 'A-1',
  statusId: '10',
  statusCategory: 'doing',
  statusSince: '2024-03-04T13:00:00Z', // Mon
  doneAt: null,
  resolvedAt: null,
  createdAt: '2024-03-01T13:00:00Z',
  ...o,
});

test('effectiveCategory: override wins, otherwise the row category', () => {
  assert.equal(effectiveCategory(row(), config()), 'doing');
  assert.equal(effectiveCategory(row(), config({ 10: 'done' })), 'done');
  assert.equal(effectiveCategory(row(), config({ 99: 'done' })), 'doing');
  assert.equal(effectiveCategory(row({ statusCategory: 'done' }), config({ 10: 'todo' })), 'todo');
});

test('isOpen / isDoing / isDone use the effective category', () => {
  const r = row({ statusCategory: 'done' });
  assert.equal(isDone(r, config()), true);
  assert.equal(isOpen(r, config()), false);
  assert.equal(isOpen(r, config({ 10: 'doing' })), true);
  assert.equal(isDoing(r, config({ 10: 'doing' })), true);
  assert.equal(isDoing(row({ statusCategory: 'todo' }), config()), false);
  assert.equal(isOpen(row({ statusCategory: 'todo' }), config()), true);
});

test('effectiveDoneAt: only while the effective category is done', () => {
  const done = row({ statusCategory: 'done', doneAt: '2024-03-05T12:00:00Z' });
  assert.equal(effectiveDoneAt(done, config()), '2024-03-05T12:00:00Z');
  // reopened: projection keeps doneAt, category is back to doing
  const reopened = row({ statusCategory: 'doing', doneAt: '2024-03-05T12:00:00Z' });
  assert.equal(effectiveDoneAt(reopened, config()), null);
  // fallback to resolvedAt
  const resolved = row({ statusCategory: 'done', doneAt: null, resolvedAt: '2024-03-06T12:00:00Z' });
  assert.equal(effectiveDoneAt(resolved, config()), '2024-03-06T12:00:00Z');
  // overrides move it in and out
  assert.equal(effectiveDoneAt(reopened, config({ 10: 'done' })), '2024-03-05T12:00:00Z');
  assert.equal(effectiveDoneAt(done, config({ 10: 'doing' })), null);
  // done with no dates at all
  assert.equal(effectiveDoneAt(row({ statusCategory: 'done' }), config()), null);
});

test('daysInStatus counts business days from statusSince, falling back to createdAt', () => {
  const now = '2024-03-11T13:00:00Z'; // Mon
  assert.equal(daysInStatus(row(), { now, timeZone: BA }), 5); // Mon -> Mon
  assert.equal(daysInStatus(row({ statusSince: null }), { now, timeZone: BA }), 6); // Fri 03-01 -> Mon 03-11
});

test('daysInStatus uses the local day for both ends', () => {
  // since Fri 22:00 BA (Sat 01:00Z); now Mon 09:00 BA
  const r = row({ statusSince: '2024-03-09T01:00:00Z' });
  assert.equal(daysInStatus(r, { now: '2024-03-11T12:00:00Z', timeZone: BA }), 1);
});

test('isStale: strictly greater than the threshold', () => {
  const now = '2024-03-11T13:00:00Z'; // Mon, 5 business days after Mon 03-04
  assert.equal(isStale(row(), config({}, 5), { now, timeZone: BA }), false); // exactly 5
  assert.equal(isStale(row(), config({}, 4), { now, timeZone: BA }), true); // 5 > 4
  assert.equal(isStale(row(), config({}, 6), { now, timeZone: BA }), false);
});

test('isStale: closed work is never stale, overrides apply', () => {
  const now = '2024-03-25T13:00:00Z';
  assert.equal(isStale(row({ statusCategory: 'done' }), config(), { now, timeZone: BA }), false);
  assert.equal(isStale(row(), config({ 10: 'done' }), { now, timeZone: BA }), false);
  assert.equal(isStale(row({ statusCategory: 'done' }), config({ 10: 'todo' }), { now, timeZone: BA }), true);
});
