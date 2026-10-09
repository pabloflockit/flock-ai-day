import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestProxy, withSecret } from './helpers.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';

async function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'lp-reset-'));
  const dbPath = path.join(dir, 'leadership-panel.db');
  let key = randomBytes(32);
  const handle = openDatabase({ path: dbPath });
  const configStore = createConfigStore({ handle, getDataKey: () => key });
  configStore.save({ teams: [{ id: 't1', name: 'Alpha', members: [] }] });
  const proxy = await startTestProxy({ stores: { config: configStore }, storage: { handle } });
  const call = async (method, p, body) => {
    const res = await fetch(`${proxy.base}${p}`, {
      method,
      headers: withSecret({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    dir,
    dbPath,
    handle,
    call,
    breakKey: () => (key = randomBytes(32)),
    cleanup: async () => {
      await proxy.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('reset renames the old DB, keeps it, and config routes work again', async () => {
  const s = await setup();
  try {
    s.breakKey();
    assert.equal((await s.call('GET', '/api/config')).body.error.code, 'DATA_KEY_INVALID');
    const res = await s.call('POST', '/api/storage/reset', { confirm: 'RESET' });
    assert.equal(res.status, 200);
    const { backupFile } = res.body.data;
    assert.match(backupFile, /^leadership-panel\.db\.bak-/);
    assert.equal(path.basename(backupFile), backupFile, 'basename only');
    assert.ok(existsSync(path.join(s.dir, backupFile)), 'old file is kept');
    assert.ok(existsSync(s.dbPath), 'a fresh DB exists');
    assert.equal(readdirSync(s.dir).filter((f) => f.includes('.bak-')).length, 1);
    const got = await s.call('GET', '/api/config');
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.data.teams, []);
    assert.equal((await s.call('PUT', '/api/config', { teams: [] })).status, 200);
  } finally {
    await s.cleanup();
  }
});

test('reset requires the exact confirmation and touches nothing otherwise', async () => {
  const s = await setup();
  try {
    for (const body of [undefined, {}, { confirm: 'reset' }, { confirm: true }]) {
      const res = await s.call('POST', '/api/storage/reset', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(readdirSync(s.dir).filter((f) => f.includes('.bak-')).length, 0);
    assert.equal((await s.call('GET', '/api/config')).body.data.teams.length, 1);
  } finally {
    await s.cleanup();
  }
});

test('reset without storage answers 503 and requires the session secret', async () => {
  const bare = await startTestProxy();
  try {
    const url = `${bare.base}/api/storage/reset`;
    const init = { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) };
    assert.equal((await fetch(url, init)).status, 401);
    const res = await fetch(url, { ...init, headers: withSecret() });
    assert.equal(res.status, 503);
  } finally {
    await bare.close();
  }
});
