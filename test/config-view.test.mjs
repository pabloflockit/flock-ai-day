import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { componentLayerRows, epicSyncRows, initials, jiraProjectKey, measureFields, teamSummaries, userSearchHits } from '../shared/config-view.mjs';

const member = (accountId, extra = {}) => ({ accountId, displayName: `User ${accountId}`, ...extra });
const config = () =>
  normalizeConfig({
    teams: [
      { id: 't1', name: 'Equipo Norte', members: [member('a'), member('b', { active: false })] },
      { id: 't2', name: 'Pagos', active: false, members: [member('a')] },
    ],
    projects: [
      { id: 'p1', teamId: 't1', name: 'Uno', epics: [{ key: 'A-1', issueTypeId: '1' }, { key: 'A-2', issueTypeId: '1' }] },
      { id: 'p2', teamId: 't1', name: 'Dos', epics: [{ key: 'A-3', issueTypeId: '1' }] },
    ],
  });

test('initials: first letters of the first and last word, upper-case', () => {
  assert.equal(initials('Ana María López'), 'AL');
  assert.equal(initials('  juan  '), 'J');
  assert.equal(initials('Ñandú Ávila'), 'ÑÁ');
  assert.equal(initials(''), '?');
});

test('teamSummaries counts members, projects and epics per team', () => {
  const rows = teamSummaries(config());
  assert.deepEqual(
    rows.map((r) => [r.team.id, r.members, r.activeMembers, r.projects, r.epics]),
    [
      ['t1', 2, 1, 2, 3],
      ['t2', 1, 1, 0, 0],
    ],
  );
});

test('userSearchHits marks people already in this team and lists their other teams', () => {
  const hits = userSearchHits(config(), 't1', [
    { accountId: 'a', displayName: 'Ana', emailAddress: 'ana@x.com' },
    { accountId: 'z', displayName: 'Zoe', emailAddress: null },
  ]);
  assert.deepEqual(
    hits.map((h) => [h.user.accountId, h.inThisTeam, h.otherTeams]),
    [
      ['a', true, ['Pagos']],
      ['z', false, []],
    ],
  );
});

test('measureFields keeps numeric fields sorted by name and marks Jira time tracking as seconds', () => {
  const fields = [
    { id: 'summary', name: 'Resumen', custom: false, schema: { type: 'string' } },
    { id: 'customfield_10016', name: 'Story points', custom: true, schema: { type: 'number' } },
    { id: 'timeoriginalestimate', name: 'Estimación original', custom: false, schema: { type: 'number' } },
    { id: 'aggregatetimespent', name: 'Σ Tiempo invertido', custom: false, schema: { type: 'number' } },
    { id: 'timetracking', name: 'Seguimiento de tiempo', custom: false, schema: { type: 'timetracking' } },
    { id: 'customfield_1', name: 'Sin tipo', custom: true, schema: { type: null } },
  ];
  assert.deepEqual(measureFields(fields), [
    { fieldId: 'timeoriginalestimate', fieldName: 'Estimación original', valueType: 'time_seconds' },
    { fieldId: 'customfield_10016', fieldName: 'Story points', valueType: 'number' },
    { fieldId: 'aggregatetimespent', fieldName: 'Σ Tiempo invertido', valueType: 'time_seconds' },
  ]);
});

test('epicSyncRows joins each epic with its shard meta: ok, failed or never synced', () => {
  const project = config().projects[0];
  const rows = epicSyncRows(project, [
    { key: 'A-1', status: 'ok', lastOkAt: '2026-10-01T10:00:00Z' },
    { key: 'A-2', status: 'failed', lastOkAt: '2026-09-30T10:00:00Z', errorCode: 'JIRA_UNAVAILABLE' },
    { key: 'Z-9', status: 'ok', lastOkAt: '2026-10-01T10:00:00Z' },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.epic.key, r.status, r.lastOkAt, r.errorCode]),
    [
      ['A-1', 'ok', '2026-10-01T10:00:00Z', null],
      ['A-2', 'failed', '2026-09-30T10:00:00Z', 'JIRA_UNAVAILABLE'],
    ],
  );
  assert.deepEqual(
    epicSyncRows(project, []).map((r) => [r.status, r.lastOkAt, r.errorCode]),
    [
      ['never', null, null],
      ['never', null, null],
    ],
  );
});

test('componentLayerRows lists the distinct Jira project keys of ALL epics (sorted) with their mappings', () => {
  const c = normalizeConfig({
    jira: {
      componentLayers: [
        { projectKey: 'ZED', componentId: '1', componentName: 'FE', layer: 'frontend' },
        { projectKey: 'ZED', componentId: '2', componentName: 'BE', layer: 'backend' },
        { projectKey: 'GONE', componentId: '9', componentName: 'Old', layer: 'backend' },
      ],
    },
    teams: [{ id: 't1', name: 'T' }],
    projects: [
      { id: 'p1', teamId: 't1', name: 'Uno', epics: [{ key: 'zed-1' }, { key: 'ABC-7', active: false }] },
      { id: 'p2', teamId: 't1', name: 'Dos', active: false, epics: [{ key: 'ZED-2' }, { key: 'MY_KEY-3' }] },
    ],
  });
  assert.deepEqual(
    componentLayerRows(c).map((r) => [r.projectKey, r.mappings.map((m) => m.componentId)]),
    [['ABC', []], ['MY_KEY', []], ['ZED', ['1', '2']]],
  );
  assert.deepEqual(componentLayerRows(normalizeConfig({})), []);
});

test('jiraProjectKey takes the project part of an issue key', () => {
  assert.equal(jiraProjectKey(' abc-12 '), 'ABC');
  assert.equal(jiraProjectKey('A_B-1'), 'A_B');
});
