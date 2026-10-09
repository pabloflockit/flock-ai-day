import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ApiError, ERROR_CODES } from '../shared/contracts.mjs';
import { projectIssuesParams, resolveTarget } from '../shared/cache-key.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { PAYLOAD_VERSION, readDataset, writeDataset } from '../proxy/cache/datasets.mjs';
import { createProjectIssuesService, refreshProjectIssues } from '../proxy/jira/refresh.mjs';
import { issue, fakeClient, makeConfig } from './jira-fixtures.mjs';

const KEY = randomBytes(32);
const T0 = '2026-03-01T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** In-memory cache context with a controllable clock. */
function setup(config = makeConfig({ epics: ['E-1', 'E-2'] })) {
  const clock = { now: T0 };
  const handle = openDatabase({ path: ':memory:', now: () => clock.now });
  const db = { handle, getDataKey: () => KEY };
  const world = { children: {}, subtasks: [], failing: new Set(), jqls: [] };
  const client = fakeClient((jql) => {
    world.jqls.push(jql);
    const child = /^parent = "([^"]+)"/.exec(jql);
    if (child) {
      if (world.failing.has(child[1])) throw new ApiError(400, ERROR_CODES.BAD_QUERY, 'bad');
      return world.children[child[1]] ?? [];
    }
    const keys = [...(/\(([^)]*)\)/.exec(jql)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return world.subtasks.filter((s) => keys.includes(s.fields.parent.key));
  });
  const id = (cfg = config) => {
    const project = cfg.projects[0];
    return {
      scopeId: project.id,
      source: 'projectIssues',
      paramsKey: resolveTarget(project.id, 'projectIssues', projectIssuesParams(project, cfg)).paramsKey,
    };
  };
  const refresh = (mode, cfg = config) =>
    refreshProjectIssues({ db, client, config: cfg, projectId: 'p1', mode, now: clock.now });
  return { clock, db, world, client, config, id, refresh };
}

const child = (key, epic, opts) => issue(key, { parent: epic, ...opts });
const keysOf = (rows) => rows.map((r) => r.key).sort();

test('first refresh is a full fetch and stores rows, ok shards and a current dataset', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  s.world.children['E-2'] = [child('B-1', 'E-2')];
  const out = await s.refresh('delta');
  assert.deepEqual(keysOf(out.rows), ['A-1', 'B-1']);
  assert.equal(out.isCurrent, true);
  assert.equal(out.fetchedAt, T0);
  assert.deepEqual(out.shardsMeta, [
    { key: 'E-1', status: 'ok', lastOkAt: T0 },
    { key: 'E-2', status: 'ok', lastOkAt: T0 },
  ]);
  assert.equal(s.world.jqls.some((j) => j.includes('updated')), false);
  const stored = readDataset(s.db, s.id());
  assert.equal(stored.fullFetchedAt, T0);
  assert.equal(stored.payloadVersion, PAYLOAD_VERSION);
});

test('cache identity comes from resolveTarget(projectIssuesParams)', async () => {
  const s = setup();
  await s.refresh('full');
  assert.ok(readDataset(s.db, s.id()));
  assert.equal(
    s.db.handle.db.prepare('SELECT COUNT(*) AS n FROM datasets').get().n,
    1,
  );
});

test('delta merges updated rows by key over cached rows with minutes + margin', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1'), child('A-2', 'E-1')];
  s.world.children['E-2'] = [child('B-1', 'E-2')];
  await s.refresh('full');
  s.clock.now = at(30);
  s.world.jqls.length = 0;
  const changed = child('A-2', 'E-1');
  changed.fields.summary = 'changed';
  s.world.children['E-1'] = [changed, child('A-3', 'E-1')];
  s.world.children['E-2'] = [];
  const out = await s.refresh('delta');
  assert.deepEqual(keysOf(out.rows), ['A-1', 'A-2', 'A-3', 'B-1']);
  assert.equal(out.rows.find((r) => r.key === 'A-2').summary, 'changed');
  assert.ok(s.world.jqls.every((j) => j.endsWith(' AND updated >= "-35m"')), s.world.jqls.join('\n'));
  assert.equal(readDataset(s.db, s.id()).fullFetchedAt, T0, 'a delta keeps the last full time');
  assert.equal(out.fetchedAt, at(30));
});

test('delta covers subtasks of unchanged cached children and re-resolves a moved child', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  s.world.subtasks = [child('S-1', 'A-1', { type: '10003' })];
  await s.refresh('full');
  s.clock.now = at(10);
  // A-1 moves to E-2 (updated, so it shows in E-2's delta); E-1 reports nothing.
  s.world.children['E-1'] = [];
  s.world.children['E-2'] = [child('A-1', 'E-2')];
  s.world.subtasks = [];
  const out = await s.refresh('delta');
  const byKey = Object.fromEntries(out.rows.map((r) => [r.key, r]));
  assert.equal(byKey['A-1'].epicKey, 'E-2');
  assert.equal(byKey['S-1'].epicKey, 'E-2', 'subtask epic follows its parent');
});

test('full replaces rows of a successful epic, so deleted issues disappear', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1'), child('A-2', 'E-1')];
  await s.refresh('full');
  s.clock.now = at(5);
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  const out = await s.refresh('full');
  assert.deepEqual(keysOf(out.rows), ['A-1']);
});

test('payload version mismatch forces a full fetch', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  await s.refresh('full');
  writeDataset(s.db, {
    ...s.id(), rows: [{ key: 'OLD-1', epicKey: 'E-1', isSubtask: false }],
    shardsMeta: [{ key: 'E-1', status: 'ok', lastOkAt: T0 }, { key: 'E-2', status: 'ok', lastOkAt: T0 }],
    fetchedAt: T0, payloadVersion: PAYLOAD_VERSION - 1,
  });
  s.clock.now = at(5);
  s.world.jqls.length = 0;
  const out = await s.refresh('delta');
  assert.equal(s.world.jqls.some((j) => j.includes('updated')), false);
  assert.deepEqual(keysOf(out.rows), ['A-1']);
  assert.equal(readDataset(s.db, s.id()).payloadVersion, PAYLOAD_VERSION);
});

test('a last full load older than fullRefreshMaxAgeHours forces a full fetch', async () => {
  const s = setup();
  await s.refresh('full');
  s.clock.now = at(60 * 25);
  s.world.jqls.length = 0;
  await s.refresh('delta');
  assert.equal(s.world.jqls.some((j) => j.includes('updated')), false);
  s.clock.now = at(60 * 25 + 60);
  s.world.jqls.length = 0;
  await s.refresh('delta');
  assert.equal(s.world.jqls.every((j) => j.includes('updated >= "-65m"')), true, s.world.jqls.join('\n'));
});

test('failed epic keeps cached rows, is_current = 0 and keeps lastOkAt (delta and full)', async () => {
  for (const mode of ['delta', 'full']) {
    const s = setup();
    s.world.children['E-1'] = [child('A-1', 'E-1')];
    s.world.children['E-2'] = [child('B-1', 'E-2')];
    await s.refresh('full');
    s.clock.now = at(20);
    s.world.failing.add('E-2');
    s.world.children['E-1'] = [child('A-9', 'E-1')];
    const out = await s.refresh(mode);
    assert.ok(out.rows.some((r) => r.key === 'B-1'), `${mode}: cached rows of the failed epic survive`);
    assert.equal(out.isCurrent, false);
    assert.deepEqual(out.shardsMeta, [
      { key: 'E-1', status: 'ok', lastOkAt: at(20) },
      { key: 'E-2', status: 'failed', lastOkAt: T0, errorCode: 'BAD_QUERY' },
    ]);
    const stored = readDataset(s.db, s.id());
    assert.equal(stored.isCurrent, false);
    assert.equal(
      s.db.handle.db.prepare('SELECT is_current AS c FROM datasets').get().c,
      0,
    );
    if (mode === 'full') assert.equal(stored.fullFetchedAt, T0, 'a partial full is not a full load');
  }
});

test('a recovering epic uses its own lastOkAt for the delta window', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  s.world.children['E-2'] = [child('B-1', 'E-2')];
  await s.refresh('full');
  s.clock.now = at(20);
  s.world.failing.add('E-2');
  await s.refresh('delta');
  s.clock.now = at(40);
  s.world.failing.clear();
  s.world.jqls.length = 0;
  const out = await s.refresh('delta');
  assert.equal(out.isCurrent, true);
  // Oldest lastOkAt is T0 (E-2): 40 min + 5 margin for the whole group.
  assert.ok(s.world.jqls.every((j) => j.endsWith('"-45m"')), s.world.jqls.join('\n'));
});

test('first-ever fetch with a failing epic stores no rows for it but marks it failed', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  s.world.failing.add('E-2');
  const out = await s.refresh('delta');
  assert.deepEqual(keysOf(out.rows), ['A-1']);
  assert.equal(out.isCurrent, false);
  assert.deepEqual(out.shardsMeta[1], { key: 'E-2', status: 'failed', lastOkAt: null, errorCode: 'BAD_QUERY' });
  // The next refresh fetches that epic in full (no lastOkAt), not as a delta.
  s.clock.now = at(10);
  s.world.failing.clear();
  s.world.children['E-2'] = [child('B-1', 'E-2')];
  s.world.jqls.length = 0;
  const next = await s.refresh('delta');
  assert.ok(next.rows.some((r) => r.key === 'B-1'));
  assert.equal(next.isCurrent, true);
  assert.ok(s.world.jqls.some((j) => j.includes('"E-2"') && !j.includes('updated')));
  assert.ok(s.world.jqls.some((j) => j.includes('"E-1"') && j.includes('"-15m"')));
});

test('failed full keeps old-shape rows without promoting the payload version', async () => {
  const s = setup();
  writeDataset(s.db, {
    ...s.id(),
    rows: [{ key: 'OLD-1', epicKey: 'E-2', isSubtask: false }],
    shardsMeta: [{ key: 'E-1', status: 'ok', lastOkAt: T0 }, { key: 'E-2', status: 'ok', lastOkAt: T0 }],
    fetchedAt: T0,
    payloadVersion: PAYLOAD_VERSION - 1,
  });
  s.world.failing.add('E-2');
  s.clock.now = at(5);
  const out = await s.refresh('delta');
  assert.ok(out.rows.some((r) => r.key === 'OLD-1'));
  assert.equal(readDataset(s.db, s.id()).payloadVersion, PAYLOAD_VERSION - 1);
});

test('inactive epics are excluded; unknown or inactive project is NOT_FOUND', async () => {
  const config = makeConfig({ epics: ['E-1', 'E-2'] });
  config.projects[0].epics[1].active = false;
  const s = setup(config);
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  s.world.children['E-2'] = [child('B-1', 'E-2')];
  const out = await s.refresh('full');
  assert.deepEqual(keysOf(out.rows), ['A-1']);
  assert.deepEqual(out.shardsMeta.map((m) => m.key), ['E-1']);
  assert.equal(s.world.jqls.some((j) => j.includes('E-2')), false);

  await assert.rejects(
    refreshProjectIssues({ db: s.db, client: s.client, config, projectId: 'nope', mode: 'full', now: T0 }),
    (e) => e.code === ERROR_CODES.NOT_FOUND && e.status === 404,
  );
  config.projects[0].active = false;
  await assert.rejects(s.refresh('full', config), (e) => e.code === ERROR_CODES.NOT_FOUND);
});

test('a wrong data key surfaces DATA_KEY_INVALID (409) and writes nothing', async () => {
  const s = setup();
  s.world.children['E-1'] = [child('A-1', 'E-1')];
  await s.refresh('full');
  const wrong = { handle: s.db.handle, getDataKey: () => randomBytes(32) };
  await assert.rejects(
    refreshProjectIssues({ db: wrong, client: s.client, config: s.config, projectId: 'p1', mode: 'delta', now: T0 }),
    (e) => e.code === ERROR_CODES.DATA_KEY_INVALID && e.status === 409,
  );
});

test('service: concurrent refreshes of the same key share one in-flight run', async () => {
  const s = setup(makeConfig({ epics: ['E-1'] }));
  let release;
  const gate = new Promise((r) => { release = r; });
  let searches = 0;
  const slow = fakeClient(async () => { searches++; await gate; return []; });
  const service = createProjectIssuesService({ db: s.db, client: slow, getConfig: () => s.config, now: () => T0 });
  const a = service.refresh('p1', 'delta');
  const b = service.refresh('p1', 'delta');
  await new Promise((r) => setImmediate(r));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(searches, 1);
  assert.deepEqual(ra, rb);
  // Settled: a new request starts a new run.
  await service.refresh('p1', 'delta');
  assert.equal(searches, 2);
});

test('service: a full request waits for an in-flight delta instead of being dropped', async () => {
  const s = setup(makeConfig({ epics: ['E-1'] }));
  let gate = Promise.resolve();
  const modes = [];
  const slow = fakeClient(async (jql) => {
    modes.push(jql.includes('updated') ? 'delta' : 'full');
    await gate;
    return [];
  });
  const service = createProjectIssuesService({ db: s.db, client: slow, getConfig: () => s.config, now: () => T0 });
  await service.refresh('p1', 'full'); // seed so the next default is a delta
  let release;
  gate = new Promise((r) => { release = r; });
  modes.length = 0;
  const first = service.refresh('p1', 'delta');
  const second = service.refresh('p1', 'full');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(modes, ['delta'], 'the full run has not started yet');
  gate = Promise.resolve();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(modes, ['delta', 'full']);
});

test('service.read: never fetched -> empty rows with fetchedAt null; unknown project NOT_FOUND', async () => {
  const s = setup();
  const service = createProjectIssuesService({ db: s.db, client: s.client, getConfig: () => s.config, now: () => T0 });
  assert.deepEqual(service.read('p1'), { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] });
  assert.throws(() => service.read('zzz'), (e) => e.code === ERROR_CODES.NOT_FOUND);
  await service.refresh('p1', 'full');
  assert.equal(service.read('p1').fetchedAt, T0);
});
