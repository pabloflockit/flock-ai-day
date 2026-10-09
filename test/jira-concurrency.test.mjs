import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from '../proxy/jira/concurrency.mjs';

test('preserves input order and reports settled results per item', async () => {
  const out = await mapWithConcurrency([30, 1, 'boom', 5], 2, async (v) => {
    await new Promise((r) => setTimeout(r, typeof v === 'number' ? v : 2));
    if (v === 'boom') throw new Error('x');
    return v * 2;
  });
  assert.deepEqual(
    out.map((r) => r.status),
    ['fulfilled', 'fulfilled', 'rejected', 'fulfilled'],
  );
  assert.deepEqual([out[0].value, out[1].value, out[3].value], [60, 2, 10]);
  assert.equal(out[2].reason.message, 'x');
});

test('never exceeds the limit (default 6) and passes the index', async () => {
  let active = 0;
  let max = 0;
  const seen = [];
  const out = await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), undefined, async (v, i) => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 2));
    active -= 1;
    seen.push(i);
    return v;
  });
  assert.equal(max, 6);
  assert.equal(out.length, 20);
  assert.deepEqual([...seen].sort((a, b) => a - b), out.map((r) => r.value));
});

test('empty input resolves empty; invalid limit throws', async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  await assert.rejects(mapWithConcurrency([1], 0, async () => 1), RangeError);
});
