import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestProxy, withSecret } from './helpers.mjs';

function fakeSync() {
  const calls = [];
  let state = { runId: null, state: 'idle' };
  return {
    calls,
    start(options) {
      calls.push(options);
      state = { runId: 'sync-1', state: 'running' };
      return state;
    },
    status: () => state,
  };
}

test('POST /api/sync starts a run and GET /api/sync/status reports it', async (t) => {
  const sync = fakeSync();
  const proxy = await startTestProxy({ sync });
  t.after(proxy.close);

  const idle = await fetch(`${proxy.base}/api/sync/status`, { headers: withSecret() });
  assert.equal(idle.status, 200);
  assert.deepEqual(await idle.json(), { ok: true, data: { runId: null, state: 'idle' } });

  const started = await fetch(`${proxy.base}/api/sync`, {
    method: 'POST',
    headers: withSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'full' }),
  });
  assert.equal(started.status, 200);
  assert.deepEqual((await started.json()).data, { runId: 'sync-1', state: 'running' });
  assert.deepEqual(sync.calls, [{ mode: 'full' }]);
});

test('POST /api/sync defaults to delta and rejects an unknown mode', async (t) => {
  const sync = fakeSync();
  const proxy = await startTestProxy({ sync });
  t.after(proxy.close);

  const ok = await fetch(`${proxy.base}/api/sync`, { method: 'POST', headers: withSecret() });
  assert.equal(ok.status, 200);
  assert.deepEqual(sync.calls, [{ mode: 'delta' }]);

  const bad = await fetch(`${proxy.base}/api/sync`, {
    method: 'POST',
    headers: withSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'everything' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'VALIDATION_ERROR');
  assert.equal(sync.calls.length, 1);
});

test('sync routes require the session secret', async (t) => {
  const proxy = await startTestProxy({ sync: fakeSync() });
  t.after(proxy.close);
  assert.equal((await fetch(`${proxy.base}/api/sync/status`)).status, 401);
  assert.equal((await fetch(`${proxy.base}/api/sync`, { method: 'POST' })).status, 401);
});

test('sync routes answer 503 when the sync service is not wired', async (t) => {
  const proxy = await startTestProxy();
  t.after(proxy.close);
  const res = await fetch(`${proxy.base}/api/sync/status`, { headers: withSecret() });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'STORAGE_UNAVAILABLE');
});
