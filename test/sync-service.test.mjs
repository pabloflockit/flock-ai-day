import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSyncService } from '../proxy/sync/service.mjs';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { ApiError, ERROR_CODES } from '../shared/contracts.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { createProjectIssuesService } from '../proxy/jira/refresh.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { createDemoFetch, DEMO_HOST, DEMO_TOKEN, buildDemoConfig } from '../fixtures/demo/index.mjs';

const NOW = '2026-10-09T12:00:00.000Z';

function config() {
  return normalizeConfig({
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'lead@example.com' },
    teams: [
      { id: 't1', name: 'Active team', members: [{ accountId: 'acc-1', displayName: 'Old' }, { accountId: 'acc-2', displayName: 'Gone' }] },
      { id: 't2', name: 'Paused team', active: false, members: [{ accountId: 'acc-9', displayName: 'Skip me' }] },
    ],
    projects: [
      { id: 'p1', teamId: 't1', name: 'P1', epics: [{ key: 'ABC-1', issueTypeId: '1' }, { key: 'ABC-2', issueTypeId: '1' }] },
      { id: 'p2', teamId: 't1', name: 'P2 inactive', active: false, epics: [{ key: 'ABC-5', issueTypeId: '1' }] },
      { id: 'p3', teamId: 't2', name: 'P3 of paused team', epics: [{ key: 'ABC-7', issueTypeId: '1' }] },
    ],
  });
}

function fakeDeps({ refresh, users } = {}) {
  let stored = config();
  const calls = { refreshed: [], users: [], issues: [], saves: 0 };
  const deps = {
    client: {
      async user(accountId) {
        calls.users.push(accountId);
        if (users?.[accountId] instanceof Error) throw users[accountId];
        return users?.[accountId] ?? { accountId, displayName: `Jira ${accountId}`, emailAddress: null, active: true };
      },
      async issue(key, options) {
        calls.issues.push({ key, options });
        return { key, fields: { summary: `Summary of ${key}` } };
      },
    },
    refreshProject:
      refresh ??
      (async (projectId, mode) => {
        calls.refreshed.push({ projectId, mode });
        return {
          isCurrent: true,
          shardsMeta: [
            { key: 'ABC-1', status: 'ok' },
            { key: 'ABC-2', status: 'ok' },
          ],
          linkMethods: { 'ABC-1': 'parent', 'ABC-2': 'parent' },
        };
      }),
    loadConfig: () => structuredClone(stored),
    saveConfig: (next) => {
      calls.saves++;
      stored = normalizeConfig(next);
      return stored;
    },
    now: () => NOW,
  };
  return { deps, calls, getStored: () => stored, setStored: (c) => (stored = c) };
}

test('starts idle', () => {
  const { deps } = fakeDeps();
  const sync = createSyncService(deps);
  assert.equal(sync.status().state, 'idle');
  assert.equal(sync.status().runId, null);
});

test('syncs only active projects of active teams and members of active teams', async () => {
  const { deps, calls, getStored } = fakeDeps();
  const sync = createSyncService(deps);
  const started = sync.start({ mode: 'full' });
  assert.equal(started.state, 'running');
  await sync.whenIdle();

  assert.deepEqual(calls.refreshed, [{ projectId: 'p1', mode: 'full' }]);
  assert.deepEqual([...calls.users].sort(), ['acc-1', 'acc-2']);
  assert.deepEqual(calls.issues.map((c) => c.key).sort(), ['ABC-1', 'ABC-2']);
  assert.deepEqual(calls.issues[0].options, { fields: ['summary'] });

  const status = sync.status();
  assert.equal(status.state, 'done');
  assert.equal(status.startedAt, NOW);
  assert.equal(status.finishedAt, NOW);
  assert.deepEqual(status.projects, { total: 1, done: 1, failed: 0 });
  assert.deepEqual(status.members, { total: 2, done: 2, failed: 0 });
  assert.deepEqual(status.failedEpics, []);

  const saved = getStored();
  assert.equal(saved.teams[0].members[0].displayName, 'Jira acc-1');
  assert.equal(saved.projects[0].epics[0].summary, 'Summary of ABC-1');
  assert.equal(saved.projects[0].epics[0].linkMethodUsed, 'parent');
  // Not synced: inactive project and paused team keep their data.
  assert.equal(saved.teams[1].members[0].displayName, 'Skip me');
});

test('a second start while running returns the same run (single flight)', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { deps, calls } = fakeDeps({
    refresh: async (projectId, mode) => {
      calls.refreshed.push({ projectId, mode });
      await gate;
      return { isCurrent: true, shardsMeta: [], linkMethods: {} };
    },
  });
  const sync = createSyncService(deps);
  const first = sync.start();
  const second = sync.start({ mode: 'full' });
  assert.equal(second.runId, first.runId);
  assert.equal(second.state, 'running');
  release();
  await sync.whenIdle();
  assert.equal(calls.refreshed.length, 1);
  const third = sync.start();
  assert.notEqual(third.runId, first.runId);
  await sync.whenIdle();
});

test('404 member is flagged jiraActive false; transient failure leaves it untouched', async () => {
  const notFound = new ApiError(404, ERROR_CODES.NOT_FOUND, 'not found');
  const flaky = new ApiError(502, ERROR_CODES.SERVER_ERROR, 'boom');
  const { deps, getStored } = fakeDeps({ users: { 'acc-1': flaky, 'acc-2': notFound } });
  const sync = createSyncService(deps);
  sync.start();
  await sync.whenIdle();
  const [m1, m2] = getStored().teams[0].members;
  assert.equal(m1.displayName, 'Old');
  assert.equal(m1.jiraActive, true);
  assert.equal(m2.jiraActive, false);
  assert.equal(m2.refreshedAt, NOW);
  assert.deepEqual(sync.status().members, { total: 2, done: 1, failed: 1 });
});

test('failed epics are listed while the rest is synced', async () => {
  const { deps, getStored } = fakeDeps({
    refresh: async () => ({
      isCurrent: false,
      shardsMeta: [
        { key: 'ABC-1', status: 'ok' },
        { key: 'ABC-2', status: 'failed', errorCode: 'BAD_QUERY' },
      ],
      linkMethods: { 'ABC-1': 'epic_link' },
    }),
  });
  const sync = createSyncService(deps);
  sync.start();
  await sync.whenIdle();
  const status = sync.status();
  assert.equal(status.state, 'done');
  assert.deepEqual(status.failedEpics, [{ projectId: 'p1', key: 'ABC-2', errorCode: 'BAD_QUERY' }]);
  const [e1, e2] = getStored().projects[0].epics;
  assert.equal(e1.linkMethodUsed, 'epic_link');
  assert.equal(e2.linkMethodUsed, null);
});

test('a project whose refresh throws counts as failed without aborting the run', async () => {
  const { deps } = fakeDeps({
    refresh: async () => {
      throw new ApiError(409, ERROR_CODES.DATA_KEY_INVALID ?? 'DATA_KEY_INVALID', 'bad key');
    },
  });
  const sync = createSyncService(deps);
  sync.start();
  await sync.whenIdle();
  assert.equal(sync.status().state, 'done');
  assert.deepEqual(sync.status().projects, { total: 1, done: 0, failed: 1 });
});

test('merges into the LATEST config: a user edit made during the run is preserved', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const harness = fakeDeps({
    refresh: async () => {
      await gate;
      return { isCurrent: true, shardsMeta: [], linkMethods: {} };
    },
  });
  const sync = createSyncService(harness.deps);
  sync.start();
  // The user renames the team and the project while the sync is running.
  const edited = structuredClone(harness.getStored());
  edited.teams[0].name = 'Renamed team';
  edited.projects[0].name = 'Renamed project';
  harness.setStored(edited);
  release();
  await sync.whenIdle();
  assert.equal(harness.getStored().teams[0].name, 'Renamed team');
  assert.equal(harness.getStored().projects[0].name, 'Renamed project');
  assert.equal(harness.getStored().teams[0].members[0].displayName, 'Jira acc-1');
});

test('an unexpected failure ends in state error without secrets', async () => {
  const { deps } = fakeDeps();
  deps.loadConfig = () => {
    throw new ApiError(409, 'DATA_KEY_INVALID', 'La clave de datos no descifra la base.');
  };
  const sync = createSyncService(deps);
  sync.start();
  await sync.whenIdle();
  const status = sync.status();
  assert.equal(status.state, 'error');
  assert.deepEqual(status.error, { code: 'DATA_KEY_INVALID', message: 'La clave de datos no descifra la base.' });
});

test('demo end to end: members and epics are synced from the demo fixtures', async () => {
  const handle = openDatabase({ path: ':memory:', now: () => NOW });
  const key = randomBytes(32);
  const store = createConfigStore({ handle, getDataKey: () => key });
  const demo = buildDemoConfig(); // seeds demo-account-099, unknown to the demo Jira
  demo.projects[0].epics[0].summary = 'stale summary';
  store.save(demo);

  const client = createJiraClient({
    getConfig: () => store.load(),
    secrets: { getJiraToken: () => DEMO_TOKEN },
    fetchImpl: createGuardedFetch({ fetchImpl: createDemoFetch({ now: () => Date.parse(NOW) }), getAllowedHosts: () => [DEMO_HOST] }),
    sleep: async () => {},
  });
  const datasets = createProjectIssuesService({
    db: { handle, getDataKey: () => key },
    client,
    getConfig: () => store.load(),
    now: () => NOW,
  });
  const sync = createSyncService({
    client,
    refreshProject: (projectId, mode) => datasets.refresh(projectId, mode),
    loadConfig: () => store.load(),
    saveConfig: (next) => store.save(next),
    now: () => NOW,
  });
  sync.start({ mode: 'full' });
  await sync.whenIdle();

  const status = sync.status();
  assert.equal(status.state, 'done', JSON.stringify(status.error));
  assert.deepEqual(status.failedEpics.map((e) => e.key), ['DEMO-3']);
  const saved = store.load();
  const former = saved.teams[0].members.find((m) => m.accountId === 'demo-account-099');
  assert.equal(former.jiraActive, false);
  assert.equal(former.refreshedAt, NOW);
  const ana = saved.teams[0].members.find((m) => m.accountId === 'demo-account-001');
  assert.equal(ana.refreshedAt, NOW);
  const demo1 = saved.projects[0].epics.find((e) => e.key === 'DEMO-1');
  assert.notEqual(demo1.summary, 'stale summary');
  assert.ok(['parent', 'epic_link'].includes(demo1.linkMethodUsed));
});
