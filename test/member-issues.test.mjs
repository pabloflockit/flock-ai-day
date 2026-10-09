import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ApiError, ERROR_CODES, isIsoDate } from '../shared/contracts.mjs';
import { memberIssuesParams, resolveTarget } from '../shared/cache-key.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { readDataset } from '../proxy/cache/datasets.mjs';
import { fetchMemberIssues, MEMBER_BATCH_SIZE } from '../proxy/jira/member-issues.mjs';
import { createProjectIssuesService, refreshMemberIssues } from '../proxy/jira/refresh.mjs';
import { issue, fakeClient, makeConfig } from './jira-fixtures.mjs';

const SINCE = '2026-02-16';
const T0 = '2026-03-01T10:00:00.000Z';
const KEY = randomBytes(32);
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** An issue assigned to `accountId`, optionally with an epic-link field value. */
const assigned = (key, accountId, opts = {}) => {
  const raw = issue(key, opts);
  raw.fields.assignee = { accountId, displayName: `Name ${accountId}` };
  if (opts.epicLink) raw.fields.customfield_10014 = opts.epicLink;
  return raw;
};

const member = (accountId, active = true) => ({ accountId, displayName: accountId, active });

function teamConfig({ members = [member('acc-1'), member('acc-2')], mode = 'parent', fieldId = null } = {}) {
  return makeConfig({
    mode,
    fieldId,
    overrides: { teams: [{ id: 't1', name: 'T', members }] },
  });
}

const fetchFor = (client, config, extra = {}) =>
  fetchMemberIssues({
    client,
    accountIds: config.teams[0].members.filter((m) => m.active).map((m) => m.accountId),
    since: SINCE,
    config,
    sinceMinutes: null,
    ...extra,
  });

test('isIsoDate accepts real calendar dates only', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2024-02-29'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '2026-2-1', '2026-02-01T00:00:00Z', '', null, 20260201]) {
    assert.equal(isIsoDate(bad), false, String(bad));
  }
});

test('memberIssuesParams: active members sorted + since + link config; names do not move the key', () => {
  const config = teamConfig({ members: [member('acc-2'), member('acc-1'), member('acc-9', false)] });
  const params = memberIssuesParams(config.teams[0], SINCE, config);
  assert.deepEqual(params, {
    accountIds: ['acc-1', 'acc-2'],
    since: SINCE,
    epicLinkMode: 'parent',
    epicLinkFieldId: null,
  });
  const renamed = structuredClone(config.teams[0]);
  renamed.name = 'Other';
  renamed.members[0].displayName = 'Someone';
  const key = (team, since = SINCE) => resolveTarget({ type: 'team', id: 't1' }, 'memberIssues', memberIssuesParams(team, since, config)).cacheKey;
  assert.equal(key(renamed), key(config.teams[0]));
  assert.notEqual(key(config.teams[0], '2026-02-17'), key(config.teams[0]));
  const fewer = structuredClone(config.teams[0]);
  fewer.members = fewer.members.slice(1);
  assert.notEqual(key(fewer), key(config.teams[0]));
});

test('JQL: quoted assignees + absolute since, with changelog; rows project assignee and epic', async () => {
  const client = fakeClient(() => [assigned('X-1', 'acc-1', { parent: 'E-9' })]);
  const out = await fetchFor(client, teamConfig());
  assert.equal(out.status, 'ok');
  assert.equal(client.calls[0].jql, 'assignee in ("acc-1","acc-2") AND updated >= "2026-02-16"');
  assert.equal(client.calls[0].expand, 'changelog');
  assert.deepEqual(out.rows.map((r) => [r.key, r.epicKey, r.assigneeAccountId]), [['X-1', 'E-9', 'acc-1']]);
});

test('account ids are escaped and batched; delta adds a relative clause', async () => {
  const ids = Array.from({ length: MEMBER_BATCH_SIZE + 3 }, (_, i) => `acc-${i}`);
  ids[0] = 'we"ird\\id';
  const client = fakeClient(() => []);
  const config = teamConfig();
  await fetchMemberIssues({ client, accountIds: ids, since: SINCE, config, sinceMinutes: 20 });
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[0].jql.startsWith('assignee in ("we\\"ird\\\\id",'));
  assert.equal(client.calls[1].jql.match(/"acc-/g).length, 3);
  assert.ok(client.calls.every((c) => c.jql.endsWith(' AND updated >= "2026-02-16" AND updated >= "-20m"')));
});

test('no active members: ok with no rows and no Jira call', async () => {
  const client = fakeClient(() => {
    throw new Error('should not be called');
  });
  const out = await fetchMemberIssues({ client, accountIds: [], since: SINCE, config: teamConfig(), sinceMinutes: null });
  assert.deepEqual(out, { status: 'ok', rows: [], errorCode: null });
});

test('subtask epic: from its parent in the result, else from a batched key lookup', async () => {
  const client = fakeClient((jql) => {
    if (jql.startsWith('assignee in')) {
      return [
        assigned('X-1', 'acc-1', { parent: 'E-1' }),
        assigned('X-2', 'acc-1', { parent: 'X-1', type: '10003' }),
        assigned('Y-2', 'acc-2', { parent: 'Y-1', type: '10003' }),
        assigned('Z-2', 'acc-2', { parent: 'Z-1', type: '10003' }),
        assigned('W-1', 'acc-2'),
      ];
    }
    if (jql === 'key in ("Y-1","Z-1")') return [issue('Y-1', { parent: 'E-2' }), issue('Z-1')];
    throw new Error(`unexpected ${jql}`);
  });
  const out = await fetchFor(client, teamConfig());
  assert.equal(out.status, 'ok');
  const epicOf = Object.fromEntries(out.rows.map((r) => [r.key, r.epicKey]));
  assert.deepEqual(epicOf, { 'X-1': 'E-1', 'X-2': 'E-1', 'Y-2': 'E-2', 'Z-2': null, 'W-1': null });
  const lookup = client.calls.find((c) => c.jql.startsWith('key in'));
  assert.equal(lookup.expand, undefined);
  assert.deepEqual(lookup.fields, ['parent']);
});

test('epic_link mode: epic from the link field, also for parents looked up', async () => {
  const client = fakeClient((jql) => {
    if (jql.startsWith('assignee in')) {
      return [assigned('X-1', 'acc-1', { epicLink: 'E-5' }), assigned('Y-2', 'acc-1', { parent: 'Y-1', type: '10003' })];
    }
    const parent = issue('Y-1');
    parent.fields.customfield_10014 = 'E-6';
    return [parent];
  });
  const out = await fetchFor(client, teamConfig({ mode: 'epic_link', fieldId: 'customfield_10014' }));
  assert.deepEqual(out.rows.map((r) => r.epicKey), ['E-5', 'E-6']);
  assert.ok(client.calls[0].fields.includes('customfield_10014'));
  assert.deepEqual(client.calls[1].fields, ['parent', 'customfield_10014']);
});

test('metadata or search failure -> failed with the error code, never an empty ok', async () => {
  const meta = fakeClient(() => [], {
    statuses: async () => {
      throw new ApiError(401, ERROR_CODES.AUTH, 'no');
    },
  });
  assert.deepEqual(await fetchFor(meta, teamConfig()), { status: 'failed', rows: [], errorCode: ERROR_CODES.AUTH });

  const search = fakeClient(() => {
    throw new ApiError(400, ERROR_CODES.BAD_QUERY, 'bad');
  });
  assert.deepEqual(await fetchFor(search, teamConfig()), { status: 'failed', rows: [], errorCode: ERROR_CODES.BAD_QUERY });
});

/** Refresh harness over an in-memory cache with a controllable clock. */
function setup(config = teamConfig()) {
  const clock = { now: T0 };
  const handle = openDatabase({ path: ':memory:', now: () => clock.now });
  const db = { handle, getDataKey: () => KEY };
  const world = { issues: [], failing: false, jqls: [] };
  const client = fakeClient((jql) => {
    world.jqls.push(jql);
    if (world.failing) throw new ApiError(502, ERROR_CODES.SERVER_ERROR, 'down');
    return world.issues;
  });
  const refresh = (mode, since = SINCE) =>
    refreshMemberIssues({ db, client, config, teamId: 't1', since, mode, now: clock.now });
  const id = (since = SINCE) => ({
    scopeId: 'team:t1',
    source: 'memberIssues',
    paramsKey: resolveTarget({ type: 'team', id: 't1' }, 'memberIssues', memberIssuesParams(config.teams[0], since, config)).paramsKey,
  });
  return { clock, db, world, client, config, refresh, id };
}

test('refresh: full first, then a delta merged by key; one "members" shard', async () => {
  const s = setup();
  s.world.issues = [assigned('X-1', 'acc-1'), assigned('X-2', 'acc-2')];
  const first = await s.refresh('delta');
  assert.deepEqual(first.rows.map((r) => r.key).sort(), ['X-1', 'X-2']);
  assert.deepEqual(first.shardsMeta, [{ key: 'members', status: 'ok', lastOkAt: T0 }]);
  assert.equal(first.isCurrent, true);
  assert.equal(s.world.jqls[0].includes('"-'), false);
  assert.ok(readDataset(s.db, s.id()));

  s.clock.now = at(30);
  const changed = assigned('X-2', 'acc-2');
  changed.fields.summary = 'Changed';
  s.world.issues = [changed, assigned('X-3', 'acc-1')];
  const second = await s.refresh('delta');
  assert.ok(s.world.jqls.at(-1).endsWith(' AND updated >= "-35m"'));
  assert.deepEqual(second.rows.map((r) => r.key).sort(), ['X-1', 'X-2', 'X-3']);
  assert.equal(second.rows.find((r) => r.key === 'X-2').summary, 'Changed');
});

test('refresh: a failure keeps the cached rows and marks the dataset not current', async () => {
  const s = setup();
  s.world.issues = [assigned('X-1', 'acc-1')];
  await s.refresh('full');
  s.clock.now = at(10);
  s.world.failing = true;
  const out = await s.refresh('delta');
  assert.deepEqual(out.rows.map((r) => r.key), ['X-1']);
  assert.equal(out.isCurrent, false);
  assert.deepEqual(out.shardsMeta, [{ key: 'members', status: 'failed', lastOkAt: T0, errorCode: ERROR_CODES.SERVER_ERROR }]);
});

test('refresh: full replaces rows; another since is another cache entry', async () => {
  const s = setup();
  s.world.issues = [assigned('X-1', 'acc-1')];
  await s.refresh('full');
  s.world.issues = [assigned('X-9', 'acc-1')];
  s.clock.now = at(5);
  const out = await s.refresh('full');
  assert.deepEqual(out.rows.map((r) => r.key), ['X-9']);
  await s.refresh('full', '2026-01-01');
  assert.equal(s.db.handle.db.prepare('SELECT COUNT(*) AS n FROM datasets').get().n, 2);
});

test('service: unknown/inactive team 404, invalid since 400, read before fetch is empty', async () => {
  const config = teamConfig();
  const handle = openDatabase({ path: ':memory:', now: () => T0 });
  const service = createProjectIssuesService({
    db: { handle, getDataKey: () => KEY },
    client: fakeClient(() => []),
    getConfig: () => config,
    now: () => T0,
  });
  assert.deepEqual(service.readMembers('t1', SINCE), { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] });
  assert.throws(() => service.readMembers('nope', SINCE), (e) => e.status === 404);
  assert.throws(() => service.readMembers('t1', '2026-02-30'), (e) => e.status === 400 && e.code === ERROR_CODES.VALIDATION_ERROR);
  const out = await service.refreshMembers('t1', SINCE, 'full');
  assert.equal(out.isCurrent, true);
});
