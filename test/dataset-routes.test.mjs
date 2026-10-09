import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createProjectIssuesService } from '../proxy/jira/refresh.mjs';
import { startTestProxy, withSecret } from './helpers.mjs';
import { issue, fakeClient, makeConfig } from './jira-fixtures.mjs';

const T0 = '2026-03-01T10:00:00.000Z';

function build({ key = randomBytes(32), handle = openDatabase({ path: ':memory:', now: () => T0 }) } = {}) {
  const db = { handle, getDataKey: () => key };
  const configStore = createConfigStore(db);
  const client = fakeClient((jql) => (jql.startsWith('parent = "E-1"') ? [issue('A-1', { parent: 'E-1' })] : []));
  const datasets = createProjectIssuesService({
    db,
    client,
    getConfig: () => configStore.load(),
    now: () => T0,
  });
  return { db, configStore, datasets, client };
}

async function withProxy(stores, fn) {
  const proxy = await startTestProxy({ stores });
  const call = async (method, path) => {
    const res = await fetch(`${proxy.base}${path}`, { method, headers: withSecret() });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    await proxy.close();
  }
}

test('GET before any fetch -> empty rows, fetchedAt null; POST refresh then GET -> envelope', async () => {
  const { configStore, datasets } = build();
  configStore.save(makeConfig({ epics: ['E-1'] }));
  await withProxy({ config: configStore, datasets }, async (call) => {
    const before = await call('GET', '/api/datasets/projectIssues?scopeId=p1');
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, {
      ok: true,
      data: { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] },
    });

    const refreshed = await call('POST', '/api/datasets/projectIssues/refresh?scopeId=p1&mode=full');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.rows[0].key, 'A-1');

    const after = await call('GET', '/api/datasets/projectIssues?scopeId=p1');
    assert.deepEqual(Object.keys(after.body.data).sort(), ['fetchedAt', 'isCurrent', 'rows', 'shardsMeta']);
    assert.equal(after.body.data.fetchedAt, T0);
    assert.equal(after.body.data.isCurrent, true);
    assert.deepEqual(after.body.data.shardsMeta, [{ key: 'E-1', status: 'ok', lastOkAt: T0 }]);
    assert.equal('fields' in after.body.data.rows[0], false);
  });
});

test('mode defaults to delta; invalid mode and missing scopeId are 400', async () => {
  const { configStore, datasets } = build();
  configStore.save(makeConfig({ epics: ['E-1'] }));
  await withProxy({ config: configStore, datasets }, async (call) => {
    assert.equal((await call('POST', '/api/datasets/projectIssues/refresh?scopeId=p1')).status, 200);
    const badMode = await call('POST', '/api/datasets/projectIssues/refresh?scopeId=p1&mode=nuke');
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.error.code, 'VALIDATION_ERROR');
    assert.equal((await call('GET', '/api/datasets/projectIssues')).status, 400);
    assert.equal((await call('POST', '/api/datasets/projectIssues/refresh')).status, 400);
  });
});

test('unknown source and unknown project are NOT_FOUND', async () => {
  const { configStore, datasets } = build();
  configStore.save(makeConfig({ epics: ['E-1'] }));
  await withProxy({ config: configStore, datasets }, async (call) => {
    for (const [method, path] of [
      ['GET', '/api/datasets/teamBoard?scopeId=p1'],
      ['POST', '/api/datasets/teamBoard/refresh?scopeId=p1'],
      ['GET', '/api/datasets/projectIssues?scopeId=missing'],
      ['POST', '/api/datasets/projectIssues/refresh?scopeId=missing'],
    ]) {
      const res = await call(method, path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.error.code, 'NOT_FOUND', path);
    }
  });
});

test('DATA_KEY_INVALID surfaces as 409 on GET and refresh', async () => {
  const first = build();
  first.configStore.save(makeConfig({ epics: ['E-1'] }));
  await first.datasets.refresh('p1', 'full');
  // Same database, different data key.
  const wrong = build({ handle: first.db.handle });
  await withProxy({ config: wrong.configStore, datasets: wrong.datasets }, async (call) => {
    for (const [method, path] of [
      ['GET', '/api/datasets/projectIssues?scopeId=p1'],
      ['POST', '/api/datasets/projectIssues/refresh?scopeId=p1'],
    ]) {
      const res = await call(method, path);
      assert.equal(res.status, 409, path);
      assert.equal(res.body.error.code, 'DATA_KEY_INVALID', path);
    }
  });
});

test('without a datasets service the routes answer 503 STORAGE_UNAVAILABLE', async () => {
  await withProxy({}, async (call) => {
    const res = await call('GET', '/api/datasets/projectIssues?scopeId=p1');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'STORAGE_UNAVAILABLE');
  });
});

test('a failed epic is reported through shardsMeta, not as an error', async () => {
  const { configStore, db } = build();
  configStore.save(makeConfig({ epics: ['E-1'] }));
  const client = fakeClient(() => {
    throw Object.assign(new Error('x'), { name: 'ApiError', code: 'BAD_QUERY' });
  });
  const datasets = createProjectIssuesService({ db, client, getConfig: () => configStore.load(), now: () => T0 });
  await withProxy({ config: configStore, datasets }, async (call) => {
    const res = await call('POST', '/api/datasets/projectIssues/refresh?scopeId=p1&mode=full');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.isCurrent, false);
    assert.equal(res.body.data.shardsMeta[0].status, 'failed');
    assert.deepEqual(res.body.data.rows, []);
  });
});

test('GET /api/datasets/:source/meta answers the envelope without rows', async () => {
  const { configStore, datasets } = build();
  configStore.save(makeConfig({ epics: ['E-1'] }));
  await withProxy({ config: configStore, datasets }, async (call) => {
    const empty = await call('GET', '/api/datasets/projectIssues/meta?scopeId=p1');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data, { fetchedAt: null, isCurrent: false, shardsMeta: [] });

    await call('POST', '/api/datasets/projectIssues/refresh?scopeId=p1&mode=full');
    const meta = await call('GET', '/api/datasets/projectIssues/meta?scopeId=p1');
    assert.equal(meta.status, 200);
    assert.equal(meta.body.data.fetchedAt, T0);
    assert.equal(meta.body.data.isCurrent, true);
    assert.deepEqual(meta.body.data.shardsMeta.map((m) => [m.key, m.status]), [['E-1', 'ok']]);
    assert.equal('rows' in meta.body.data, false);

    assert.equal((await call('GET', '/api/datasets/projectIssues/meta')).status, 400);
    assert.equal((await call('GET', '/api/datasets/nope/meta?scopeId=p1')).status, 404);
  });
});

test('memberIssues: scopeId is the team, since is required and validated', async () => {
  const { configStore, db } = build();
  configStore.save(
    makeConfig({ overrides: { teams: [{ id: 't1', name: 'T', members: [{ accountId: 'acc-1', displayName: 'A' }] }] } }),
  );
  const client = fakeClient((jql) => {
    if (!jql.startsWith('assignee in ("acc-1")')) return [];
    const raw = issue('X-1', { parent: 'E-9' });
    raw.fields.assignee = { accountId: 'acc-1', displayName: 'A' };
    return [raw];
  });
  const datasets = createProjectIssuesService({ db, client, getConfig: () => configStore.load(), now: () => T0 });
  await withProxy({ config: configStore, datasets }, async (call) => {
    const base = '/api/datasets/memberIssues';
    const before = await call('GET', `${base}?scopeId=t1&since=2026-02-16`);
    assert.equal(before.status, 200);
    assert.equal(before.body.data.fetchedAt, null);

    const refreshed = await call('POST', `${base}/refresh?scopeId=t1&since=2026-02-16&mode=full`);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(refreshed.body.data.rows.map((r) => [r.key, r.epicKey]), [['X-1', 'E-9']]);
    assert.deepEqual(refreshed.body.data.shardsMeta, [{ key: 'members', status: 'ok', lastOkAt: T0 }]);

    const meta = await call('GET', `${base}/meta?scopeId=t1&since=2026-02-16`);
    assert.equal(meta.body.data.isCurrent, true);
    assert.equal('rows' in meta.body.data, false);

    for (const path of [`${base}?scopeId=t1`, `${base}?scopeId=t1&since=2026-02-30`, `${base}/meta?scopeId=t1&since=16-02-2026`]) {
      const res = await call('GET', path);
      assert.equal(res.status, 400, path);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR', path);
    }
    assert.equal((await call('POST', `${base}/refresh?scopeId=t1`)).status, 400);
    assert.equal((await call('GET', `${base}?scopeId=missing&since=2026-02-16`)).status, 404);
  });
});
