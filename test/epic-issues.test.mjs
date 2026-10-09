import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../shared/contracts.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createProjectIssuesService } from '../proxy/jira/refresh.mjs';
import { epicIssuesParams, resolveTarget } from '../shared/cache-key.mjs';
import { startTestProxy, withSecret } from './helpers.mjs';
import { issue, fakeClient, makeConfig } from './jira-fixtures.mjs';

const T0 = '2026-03-01T10:00:00.000Z';

function build(search, { mode = 'parent', fieldId = null } = {}) {
  const key = randomBytes(32);
  const handle = openDatabase({ path: ':memory:', now: () => T0 });
  const db = { handle, getDataKey: () => key };
  const configStore = createConfigStore(db);
  // No project owns epic X-9: the diagnostics source must not need (or touch) the config projects.
  const saved = configStore.save(makeConfig({ epics: [], mode, fieldId }));
  const client = fakeClient(search);
  const datasets = createProjectIssuesService({ db, client, getConfig: () => configStore.load(), now: () => T0 });
  return { db, configStore, datasets, client, saved };
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

const children = (jql) => (jql.startsWith('parent = "X-9"') ? [issue('A-1', { parent: 'X-9' })] : []);

test('resolveTarget accepts a { type, id } scope and shares the query params of projectIssues', () => {
  const config = makeConfig({ epics: [] });
  const params = epicIssuesParams('X-9', config);
  assert.deepEqual(params.epicKeys, ['X-9']);
  assert.deepEqual(params.measureFieldIds, []);
  const target = resolveTarget({ type: 'epic', id: 'X-9' }, 'epicIssues', params);
  assert.equal(target.scopeId, 'epic:X-9');
  assert.equal(target.cacheKey, `epic:X-9|epicIssues|${target.paramsKey}`);
  assert.equal(resolveTarget('p1', 'projectIssues', {}).scopeId, 'p1');
  assert.equal(resolveTarget('p1', 'projectIssues', {}).cacheKey.startsWith('p1|projectIssues|'), true);
  assert.throws(() => resolveTarget({ type: 'epic', id: '' }, 'epicIssues', params));
});

test('the epic params follow the current jira config (link mode moves the key)', () => {
  const a = epicIssuesParams('X-9', makeConfig({ epics: [], mode: 'parent' }));
  const b = epicIssuesParams('X-9', makeConfig({ epics: [], mode: 'epic_link', fieldId: 'customfield_7' }));
  assert.notEqual(
    resolveTarget({ type: 'epic', id: 'X-9' }, 'epicIssues', a).cacheKey,
    resolveTarget({ type: 'epic', id: 'X-9' }, 'epicIssues', b).cacheKey,
  );
});

test('GET before any fetch is empty; POST refresh then GET return the envelope', async () => {
  const { datasets, configStore, saved } = build(children);
  await withProxy({ config: configStore, datasets }, async (call) => {
    const before = await call('GET', '/api/datasets/epicIssues?scopeId=X-9');
    assert.deepEqual(before.body, { ok: true, data: { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] } });

    const refreshed = await call('POST', '/api/datasets/epicIssues/refresh?scopeId=X-9&mode=full');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.data.rows[0].key, 'A-1');
    assert.equal(refreshed.body.data.rows[0].epicKey, 'X-9');

    const after = await call('GET', '/api/datasets/epicIssues?scopeId=X-9');
    assert.deepEqual(Object.keys(after.body.data).sort(), ['fetchedAt', 'isCurrent', 'rows', 'shardsMeta']);
    assert.equal(after.body.data.fetchedAt, T0);
    assert.deepEqual(after.body.data.shardsMeta, [{ key: 'X-9', status: 'ok', lastOkAt: T0 }]);
  });
  assert.deepEqual(configStore.load(), saved, 'the diagnostics source never writes to the config');
});

test('rows are stored under the resolveTarget identity, never a hand-built key', async () => {
  const { datasets, db, configStore } = build(children);
  await datasets.refreshEpic('X-9', 'full');
  const { paramsKey } = resolveTarget({ type: 'epic', id: 'X-9' }, 'epicIssues', epicIssuesParams('X-9', configStore.load()));
  const stored = db.handle.db.prepare('SELECT scope_id, source, params_key FROM datasets').all();
  assert.deepEqual(stored.map((r) => ({ ...r })), [{ scope_id: 'epic:X-9', source: 'epicIssues', params_key: paramsKey }]);
});

test('invalid epic keys are 400 and unknown sources stay 404', async () => {
  const { datasets, configStore } = build(children);
  await withProxy({ config: configStore, datasets }, async (call) => {
    for (const scope of ['', 'nope', 'X-9%22%20OR%20x', '9-X']) {
      const res = await call('GET', `/api/datasets/epicIssues?scopeId=${scope}`);
      assert.equal(res.status, 400, scope);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR', scope);
    }
    assert.equal((await call('POST', '/api/datasets/epicIssues/refresh?scopeId=bad')).status, 400);
    assert.equal((await call('POST', '/api/datasets/epicIssues/refresh?scopeId=X-9&mode=x')).status, 400);
    assert.equal((await call('GET', '/api/datasets/epicIssue?scopeId=X-9')).status, 404);
  });
});

test('degrades to stale: a failing epic keeps its cached rows', async () => {
  let fail = false;
  const { datasets } = build((jql) => {
    if (fail) throw new ApiError(504, 'TIMEOUT', 'x');
    return children(jql);
  });
  await datasets.refreshEpic('X-9', 'full');
  fail = true;
  const view = await datasets.refreshEpic('X-9', 'delta');
  assert.equal(view.isCurrent, false);
  assert.deepEqual(view.rows.map((r) => r.key), ['A-1']);
  assert.deepEqual(view.shardsMeta, [{ key: 'X-9', status: 'failed', lastOkAt: T0, errorCode: 'TIMEOUT' }]);
});

test('concurrent refreshes of the same epic are coalesced', async () => {
  const { datasets, client } = build(children);
  const [a, b] = await Promise.all([datasets.refreshEpic('X-9', 'delta'), datasets.refreshEpic('X-9', 'delta')]);
  assert.equal(a, b);
  assert.equal(client.calls.filter((c) => c.jql.startsWith('parent = "X-9"')).length, 1);
});

test('uses the current jira config for the link mode', async () => {
  const { datasets, client } = build(() => [], { mode: 'epic_link', fieldId: 'customfield_7' });
  await datasets.refreshEpic('X-9', 'full');
  assert.match(client.calls[0].jql, /^cf\[7\] = "X-9"/);
});
