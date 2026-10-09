import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSyncedFields } from '../proxy/sync/merge.mjs';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { validateConfig } from '../proxy/config/validate.mjs';
import { projectIssuesParams, resolveTarget } from '../shared/cache-key.mjs';

const NOW = '2026-10-09T12:00:00.000Z';
const OLD = '2026-10-01T09:00:00.000Z';

function baseConfig() {
  return normalizeConfig({
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'lead@example.com', epicLinkMode: 'auto' },
    settings: { staleBusinessDays: 7 },
    teams: [
      {
        id: 't1',
        name: 'Team One',
        description: 'kept',
        members: [
          { accountId: 'acc-1', displayName: 'Old Name', emailAddress: 'old@example.com', refreshedAt: OLD },
          { accountId: 'acc-2', displayName: 'Gone User', emailAddress: null, refreshedAt: OLD },
          { accountId: 'acc-3', displayName: 'Flaky User', emailAddress: 'flaky@example.com', refreshedAt: OLD },
          { accountId: 'acc-4', displayName: 'Paused Member', active: false, refreshedAt: OLD },
        ],
      },
    ],
    projects: [
      {
        id: 'p1',
        teamId: 't1',
        name: 'Project One',
        measure: { kind: 'field', fieldId: 'customfield_1', fieldName: 'SP', valueType: 'number' },
        epics: [
          { key: 'ABC-1', issueTypeId: '10000', summary: 'Old summary' },
          { key: 'ABC-2', issueTypeId: '10000', summary: 'Failed epic', linkMethodUsed: 'parent' },
          { key: 'ABC-3', issueTypeId: '10000', summary: 'Inactive epic', active: false },
        ],
      },
    ],
  });
}

const syncResult = {
  members: {
    'acc-1': { status: 'ok', user: { displayName: 'New Name', emailAddress: 'new@example.com', active: true } },
    'acc-2': { status: 'not_found' },
    'acc-3': { status: 'error', errorCode: 'SERVER_ERROR' },
    'acc-4': { status: 'ok', user: { displayName: 'Paused Member', active: false } },
  },
  epics: {
    'ABC-1': { summary: 'Fresh summary', linkMethodUsed: 'epic_link' },
    'ABC-2': { summary: 'Fresh failed summary' },
  },
};

const keyOf = (config) =>
  config.projects.map((p) => resolveTarget({ type: 'project', id: p.id }, 'projectIssues', projectIssuesParams(p, config)).cacheKey);

test('writes only the §6.7 member fields', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(before, syncResult, { now: NOW });
  const [m1, m2, m3, m4] = after.teams[0].members;

  assert.deepEqual(m1, { ...before.teams[0].members[0], displayName: 'New Name', emailAddress: 'new@example.com', jiraActive: true, refreshedAt: NOW });
  // Not found in Jira: kept, flagged inactive in Jira, never removed.
  assert.deepEqual(m2, { ...before.teams[0].members[1], jiraActive: false, refreshedAt: NOW });
  // Transient failure: untouched (not flagged inactive).
  assert.deepEqual(m3, before.teams[0].members[2]);
  // `active` (membership in this team) is user-owned and never changed by sync.
  assert.equal(m4.active, false);
  assert.equal(m4.jiraActive, false);
  assert.equal(after.teams[0].members.length, 4);
});

test('writes only summary and linkMethodUsed on epics, and only with data', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(before, syncResult, { now: NOW });
  const [e1, e2, e3] = after.projects[0].epics;
  assert.deepEqual(e1, { ...before.projects[0].epics[0], summary: 'Fresh summary', linkMethodUsed: 'epic_link' });
  // No linkMethodUsed in the result (failed shard): previous value kept.
  assert.deepEqual(e2, { ...before.projects[0].epics[1], summary: 'Fresh failed summary' });
  assert.deepEqual(e3, before.projects[0].epics[2]);
  assert.equal(after.projects[0].epics.length, 3);
});

test('everything outside the §6.7 fields is deep-equal', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(before, syncResult, { now: NOW });
  const strip = (config) => ({
    ...config,
    teams: config.teams.map((t) => ({
      ...t,
      members: t.members.map(({ displayName, emailAddress, jiraActive, refreshedAt, ...rest }) => rest),
    })),
    projects: config.projects.map((p) => ({
      ...p,
      epics: p.epics.map(({ summary, linkMethodUsed, ...rest }) => rest),
    })),
  });
  assert.deepEqual(strip(after), strip(before));
});

test('does not mutate its input and the result is valid and normalized', () => {
  const before = baseConfig();
  const snapshot = structuredClone(before);
  const after = mergeSyncedFields(before, syncResult, { now: NOW });
  assert.deepEqual(before, snapshot);
  assert.deepEqual(after, normalizeConfig(after));
  assert.deepEqual(validateConfig(after), []);
});

test('cache keys never move', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(before, syncResult, { now: NOW });
  assert.deepEqual(keyOf(after), keyOf(before));
});

test('ignores results for members or epics that are not in the config', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(
    before,
    {
      members: { stranger: { status: 'ok', user: { displayName: 'Stranger', active: true } } },
      epics: { 'XYZ-9': { summary: 'Unknown epic', linkMethodUsed: 'parent' } },
    },
    { now: NOW },
  );
  assert.deepEqual(after, before);
});

test('prototype keys in results are ignored', () => {
  const before = baseConfig();
  const after = mergeSyncedFields(before, { members: {}, epics: {} }, { now: NOW });
  assert.deepEqual(after, before);
  const tricky = normalizeConfig({ ...before, teams: [{ ...before.teams[0], members: [{ accountId: 'toString' }] }] });
  assert.deepEqual(mergeSyncedFields(tricky, { members: {}, epics: {} }, { now: NOW }), tricky);
});
