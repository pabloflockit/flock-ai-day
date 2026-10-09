import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../proxy/cache/db.mjs';
import {
  readDataset,
  writeDataset,
  needsFullRefresh,
  PAYLOAD_VERSION,
} from '../proxy/cache/datasets.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';

const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lp-cache-'));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const FIXED = '2026-01-02T03:04:05.678Z';
const key = randomBytes(32);
const open = (file = ':memory:', now = () => FIXED) => openDatabase({ path: file, now });

test('schema: versioned migration, no source CHECK, no datetime(now)', () => {
  const handle = open();
  const meta = Object.fromEntries(
    handle.db
      .prepare('SELECT key, value FROM schema_meta')
      .all()
      .map((r) => [r.key, r.value]),
  );
  assert.equal(meta.schema_version, String(SCHEMA_VERSION));
  assert.equal(meta.created_at, FIXED);
  const sql = handle.db
    .prepare("SELECT group_concat(sql, ' ') AS s FROM sqlite_master WHERE type = 'table'")
    .get().s;
  assert.ok(!/CHECK\s*\(\s*source/i.test(sql));
  assert.ok(!/datetime\s*\(/i.test(sql));
  const tables = handle.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, ['app_config', 'datasets', 'schema_meta']);
});

test('reopening an existing file does not re-run the migration', () => {
  const file = path.join(tempDir(), 'a.db');
  open(file).close();
  const again = open(file, () => 'later');
  assert.equal(
    again.db.prepare("SELECT value FROM schema_meta WHERE key = 'created_at'").get().value,
    FIXED,
  );
  again.close();
});

test('refuses a database from a newer schema', () => {
  const file = path.join(tempDir(), 'n.db');
  const handle = open(file);
  handle.db.prepare("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'").run();
  handle.close();
  assert.throws(() => open(file), /newer/);
});

test('any source is accepted and timestamps end with Z', () => {
  const handle = open(':memory:', () => new Date().toISOString());
  const ctx = { handle, getDataKey: () => key };
  writeDataset(ctx, { scopeId: 's', source: 'anything-goes', paramsKey: 'k', rows: [] });
  const row = handle.db.prepare('SELECT fetched_at, full_fetched_at FROM datasets').get();
  assert.match(row.fetched_at, /Z$/);
  assert.match(row.full_fetched_at, /Z$/);
});

test('dataset write/read roundtrip, one row per key, upsert replaces', () => {
  const handle = open();
  const ctx = { handle, getDataKey: () => key };
  const id = { scopeId: 'p1', source: 'projectIssues', paramsKey: 'abc' };
  assert.equal(readDataset(ctx, id), null);
  writeDataset(ctx, { ...id, rows: [{ key: 'A-1' }], shardsMeta: [{ key: 'E-1', status: 'ok' }] });
  const entry = readDataset(ctx, id);
  assert.deepEqual(entry.rows, [{ key: 'A-1' }]);
  assert.deepEqual(entry.shardsMeta, [{ key: 'E-1', status: 'ok' }]);
  assert.equal(entry.isCurrent, true);
  assert.equal(entry.payloadVersion, PAYLOAD_VERSION);
  assert.equal(entry.fetchedAt, FIXED);
  assert.equal(entry.fullFetchedAt, FIXED);
  writeDataset(ctx, {
    ...id,
    rows: [],
    isCurrent: false,
    fetchedAt: '2026-01-03T00:00:00.000Z',
    fullFetchedAt: FIXED,
  });
  const second = readDataset(ctx, id);
  assert.equal(second.isCurrent, false);
  assert.equal(second.fullFetchedAt, FIXED);
  assert.equal(handle.db.prepare('SELECT count(*) AS c FROM datasets').get().c, 1);
  assert.equal(readDataset(ctx, { ...id, scopeId: 'p2' }), null);
});

test('rejects timestamps that are not ISO with Z', () => {
  const ctx = { handle: open(), getDataKey: () => key };
  assert.throws(() =>
    writeDataset(ctx, {
      scopeId: 's',
      source: 'x',
      paramsKey: 'k',
      rows: [],
      fetchedAt: '2026-01-01 00:00:00',
    }),
  );
});

test('ciphertext moved between dataset rows is rejected (AAD)', () => {
  const handle = open();
  const ctx = { handle, getDataKey: () => key };
  writeDataset(ctx, { scopeId: 'a', source: 's', paramsKey: 'k', rows: [{ x: 1 }] });
  writeDataset(ctx, { scopeId: 'b', source: 's', paramsKey: 'k', rows: [{ x: 2 }] });
  const a = handle.db
    .prepare("SELECT payload_enc, iv, tag FROM datasets WHERE scope_id = 'a'")
    .get();
  handle.db
    .prepare("UPDATE datasets SET payload_enc = ?, iv = ?, tag = ? WHERE scope_id = 'b'")
    .run(a.payload_enc, a.iv, a.tag);
  assert.throws(() => readDataset(ctx, { scopeId: 'b', source: 's', paramsKey: 'k' }), {
    code: 'DATA_KEY_INVALID',
  });
});

test('needsFullRefresh', () => {
  const now = new Date('2026-01-02T00:00:00.000Z');
  const entry = { payloadVersion: PAYLOAD_VERSION, fullFetchedAt: '2026-01-01T12:00:00.000Z' };
  const opts = { now, fullRefreshMaxAgeHours: 24, payloadVersion: PAYLOAD_VERSION };
  assert.equal(needsFullRefresh(null, opts), true);
  assert.equal(needsFullRefresh(entry, opts), false);
  assert.equal(needsFullRefresh({ ...entry, payloadVersion: PAYLOAD_VERSION - 1 }, opts), true);
  assert.equal(
    needsFullRefresh({ ...entry, fullFetchedAt: '2025-12-31T00:00:00.000Z' }, opts),
    true,
  );
  assert.equal(
    needsFullRefresh({ ...entry, fullFetchedAt: '2026-01-01T00:00:00.000Z' }, opts),
    false,
    'exactly at the limit is still fresh',
  );
  assert.equal(needsFullRefresh({ ...entry, fullFetchedAt: 'garbage' }, opts), true);
});

test('raw database bytes contain no plaintext of config or payload', () => {
  const file = path.join(tempDir(), 'raw.db');
  const handle = open(file);
  const ctx = { handle, getDataKey: () => key };
  writeDataset(ctx, {
    scopeId: 'p1',
    source: 'projectIssues',
    paramsKey: 'k',
    rows: [{ summary: 'ROW-SECRET-MARKER' }],
  });
  createConfigStore(ctx).save({ teams: [{ id: 't1', name: 'CONFIG-SECRET-MARKER' }] });
  handle.close();
  const bytes = readFileSync(file);
  assert.ok(bytes.length > 0);
  assert.ok(!bytes.includes('ROW-SECRET-MARKER'));
  assert.ok(!bytes.includes('CONFIG-SECRET-MARKER'));
});

test('wrong data key: DATA_KEY_INVALID and the rows are left untouched', () => {
  const handle = open();
  const good = { handle, getDataKey: () => key };
  const id = { scopeId: 'p1', source: 'projectIssues', paramsKey: 'k' };
  writeDataset(good, { ...id, rows: [{ a: 1 }] });
  createConfigStore(good).save({ teams: [{ id: 't1', name: 'T' }] });
  const snapshot = () => ({
    d: handle.db.prepare('SELECT * FROM datasets').all(),
    c: handle.db.prepare('SELECT * FROM app_config').all(),
  });
  const before = snapshot();
  const bad = { handle, getDataKey: () => randomBytes(32) };
  assert.throws(() => readDataset(bad, id), { code: 'DATA_KEY_INVALID' });
  assert.throws(() => createConfigStore(bad).load(), { code: 'DATA_KEY_INVALID' });
  assert.throws(() => createConfigStore(bad).save({}), { code: 'DATA_KEY_INVALID' });
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(readDataset(good, id).rows, [{ a: 1 }]);
});

test('renameAndRecreate keeps the old file as .bak-<timestamp> and opens a fresh DB', () => {
  const dir = tempDir();
  const file = path.join(dir, 'p.db');
  const handle = open(file);
  const ctx = { handle, getDataKey: () => key };
  writeDataset(ctx, { scopeId: 'p1', source: 's', paramsKey: 'k', rows: [{ keep: 'me' }] });
  const { backupPath } = handle.renameAndRecreate();
  assert.ok(existsSync(backupPath));
  assert.match(path.basename(backupPath), /^p\.db\.bak-2026-01-02T03-04-05-678Z/);
  assert.equal(handle.db.prepare('SELECT count(*) AS c FROM datasets').get().c, 0);
  const old = openDatabase({ path: backupPath, now: () => FIXED });
  assert.equal(old.db.prepare('SELECT count(*) AS c FROM datasets').get().c, 1);
  old.close();
  // A second recovery in the same millisecond must not overwrite the first backup.
  const second = handle.renameAndRecreate();
  assert.notEqual(second.backupPath, backupPath);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 2);
  handle.close();
});

test('payload version 2: rows cached before statusChanges/components force a full load', () => {
  assert.equal(PAYLOAD_VERSION, 2);
  const opts = { now: new Date('2026-01-01T13:00:00.000Z'), fullRefreshMaxAgeHours: 24 };
  assert.equal(needsFullRefresh({ payloadVersion: 1, fullFetchedAt: '2026-01-01T12:00:00.000Z' }, opts), true);
});
