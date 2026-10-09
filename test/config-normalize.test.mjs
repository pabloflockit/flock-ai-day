import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, CONFIG_VERSION } from '../proxy/config/normalize.mjs';

test('defaults for an empty or garbage input', () => {
  for (const raw of [undefined, null, {}, 'x', 42, []]) {
    assert.deepEqual(normalizeConfig(raw), {
      version: CONFIG_VERSION,
      jira: {
        baseUrl: '',
        email: '',
        epicLinkMode: 'auto',
        epicLinkFieldId: null,
        timeoutMs: 15000,
        maxRetries: 3,
        statusCategoryOverrides: {},
      },
      settings: {
        staleBusinessDays: 5,
        agingBusinessDays: 10,
        fullRefreshMaxAgeHours: 24,
        ai: { enabled: false },
      },
      teams: [],
      projects: [],
    });
  }
});

const messy = {
  version: 0,
  token: 'SECRET',
  jira: {
    baseUrl: ' https://x.atlassian.net ',
    email: 'a@b.c',
    token: 'ATATT-secret',
    apiToken: 'secret',
    epicLinkMode: 'nonsense',
    epicLinkFieldId: 'customfield_1',
    timeoutMs: -5,
    maxRetries: 'many',
    statusCategoryOverrides: { 10: 'doing', 11: 'blocked', 12: 'done' },
  },
  settings: { staleBusinessDays: 7, ai: { enabled: true, apiKey: 'sk-secret' }, extra: 1 },
  teams: [
    {
      id: 't1',
      name: ' Team ',
      description: 7,
      extra: true,
      members: [
        { accountId: 'm1', displayName: 'M', emailAddress: 'm@x', password: 'p' },
        { displayName: 'no id' },
      ],
    },
    { name: 'no id' },
  ],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      name: 'P',
      workUnit: 'weird',
      measure: {
        kind: 'field',
        fieldId: 'customfield_2',
        fieldName: 'SP',
        valueType: 'number',
        z: 1,
      },
      epics: [{ key: ' E-1 ', issueTypeId: '10', secret: 1 }, { summary: 'no key' }],
    },
    { id: 'p2', teamId: 't1', name: 'Q', measure: { kind: 'field' } },
  ],
};

test('whitelist: unknown keys dropped, bad values defaulted, no secrets survive', () => {
  const c = normalizeConfig(messy);
  assert.equal(c.version, CONFIG_VERSION);
  assert.equal(c.jira.baseUrl, 'https://x.atlassian.net');
  assert.equal(c.jira.epicLinkMode, 'auto');
  assert.equal(c.jira.epicLinkFieldId, 'customfield_1');
  assert.equal(c.jira.timeoutMs, 15000);
  assert.equal(c.jira.maxRetries, 3);
  assert.deepEqual(c.jira.statusCategoryOverrides, { 10: 'doing', 12: 'done' });
  assert.equal(c.settings.staleBusinessDays, 7);
  assert.deepEqual(c.settings.ai, { enabled: true });
  assert.equal(c.teams.length, 1);
  assert.equal(c.teams[0].name, 'Team');
  assert.equal(c.teams[0].description, null);
  assert.equal(c.teams[0].active, true);
  assert.equal(c.teams[0].members.length, 1);
  assert.equal(c.teams[0].members[0].jiraActive, true);
  assert.equal(c.projects[0].workUnit, 'task');
  assert.equal(c.projects[0].epics.length, 1);
  assert.equal(c.projects[0].epics[0].key, 'E-1');
  assert.equal(c.projects[0].epics[0].linkMethodUsed, null);
  assert.equal(c.projects[1].measure.kind, 'count', 'field measure without fieldId falls back');
  assert.ok(!/SECRET|secret|sk-|password/i.test(JSON.stringify(c)));
});

test('idempotent', () => {
  for (const raw of [undefined, messy]) {
    const once = normalizeConfig(raw);
    assert.deepEqual(normalizeConfig(once), once);
  }
});

test('does not mutate its input', () => {
  const copy = structuredClone(messy);
  normalizeConfig(messy);
  assert.deepEqual(messy, copy);
});

test('a valid jira.baseUrl is stored as its canonical origin; an invalid one is kept for validation', () => {
  assert.equal(normalizeConfig({ jira: { baseUrl: 'https://ACME.atlassian.net/' } }).jira.baseUrl, 'https://acme.atlassian.net');
  assert.equal(normalizeConfig({ jira: { baseUrl: 'https://acme.atlassian.net/some/path' } }).jira.baseUrl, 'https://acme.atlassian.net');
  // Invalid values are not silently "fixed": validateConfig must still see and reject them.
  assert.equal(normalizeConfig({ jira: { baseUrl: 'http://acme.atlassian.net' } }).jira.baseUrl, 'http://acme.atlassian.net');
  const once = normalizeConfig({ jira: { baseUrl: 'https://ACME.atlassian.net/' } });
  assert.deepEqual(normalizeConfig(once), once);
});
