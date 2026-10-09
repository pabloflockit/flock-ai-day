import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { validateConfig, guardDeleteTeam, guardDeleteProject } from '../proxy/config/validate.mjs';

const member = (accountId) => ({ accountId });
const base = () => ({
  jira: { baseUrl: 'https://acme.atlassian.net' },
  teams: [
    { id: 't1', name: 'Alpha', members: [member('m1'), member('m2')] },
    { id: 't2', name: 'Beta', members: [member('m1')] },
  ],
  projects: [
    { id: 'p1', teamId: 't1', name: 'One', epics: [{ key: 'E-1' }, { key: 'E-2' }] },
    { id: 'p2', teamId: 't2', name: 'Two', epics: [{ key: 'E-3' }] },
  ],
});
const codes = (raw) =>
  validateConfig(normalizeConfig(raw))
    .map((i) => `${i.code}@${i.path}`)
    .sort();

test('a valid config (same person in two teams, empty URL) has no issues', () => {
  assert.deepEqual(validateConfig(normalizeConfig(base())), []);
  assert.deepEqual(validateConfig(normalizeConfig({})), []);
});

const rules = [
  ['duplicate team name', (c) => (c.teams[1].name = ' alpha '), ['TEAM_NAME_DUPLICATE@teams[1].name']],
  [
    'duplicate project name',
    (c) => (c.projects[1].name = 'ONE'),
    ['PROJECT_NAME_DUPLICATE@projects[1].name'],
  ],
  ['empty team name', (c) => (c.teams[0].name = ''), ['TEAM_NAME_REQUIRED@teams[0].name']],
  [
    'empty project name',
    (c) => (c.projects[0].name = ''),
    ['PROJECT_NAME_REQUIRED@projects[0].name'],
  ],
  [
    'unknown team',
    (c) => (c.projects[0].teamId = 'nope'),
    ['PROJECT_TEAM_MISSING@projects[0].teamId'],
  ],
  [
    'epic in two projects',
    (c) => c.projects[1].epics.push({ key: 'e-1' }),
    ['EPIC_DUPLICATE@projects[1].epics[1].key'],
  ],
  [
    'epic twice in one project',
    (c) => c.projects[0].epics.push({ key: 'E-2' }),
    ['EPIC_DUPLICATE@projects[0].epics[2].key'],
  ],
  [
    'member twice in a team',
    (c) => c.teams[0].members.push(member('m1')),
    ['MEMBER_DUPLICATE@teams[0].members[2].accountId'],
  ],
  [
    'http url',
    (c) => (c.jira.baseUrl = 'http://acme.atlassian.net'),
    ['JIRA_URL_INVALID@jira.baseUrl'],
  ],
  [
    'private host',
    (c) => (c.jira.baseUrl = 'https://127.0.0.1'),
    ['JIRA_URL_INVALID@jira.baseUrl'],
  ],
  [
    'duplicate team id',
    (c) => (c.teams[1].id = 't1'),
    ['PROJECT_TEAM_MISSING@projects[1].teamId', 'TEAM_ID_DUPLICATE@teams[1].id'],
  ],
  [
    'duplicate project id',
    (c) => (c.projects[1].id = 'p1'),
    ['PROJECT_ID_DUPLICATE@projects[1].id'],
  ],
  [
    'epic_link mode without field',
    (c) => (c.jira.epicLinkMode = 'epic_link'),
    ['EPIC_LINK_FIELD_REQUIRED@jira.epicLinkFieldId'],
  ],
];
for (const [name, mutate, expected] of rules) {
  test(`rule: ${name}`, () => {
    const raw = base();
    mutate(raw);
    assert.deepEqual(codes(raw), expected);
  });
}

test('issues carry Spanish messages', () => {
  const raw = base();
  raw.teams[1].name = 'Alpha';
  const [issue] = validateConfig(normalizeConfig(raw));
  assert.deepEqual(Object.keys(issue).sort(), ['code', 'message', 'path']);
  assert.match(issue.message, /equipo/i);
});

test('delete guards', () => {
  const config = normalizeConfig(base());
  assert.deepEqual(
    guardDeleteTeam(config, 't1').map((i) => i.code),
    ['TEAM_HAS_PROJECTS'],
  );
  assert.deepEqual(
    guardDeleteProject(config, 'p1').map((i) => i.code),
    ['PROJECT_HAS_EPICS'],
  );
  const empty = normalizeConfig({
    teams: [{ id: 't', name: 'T' }],
    projects: [{ id: 'p', teamId: 't', name: 'P' }],
  });
  assert.deepEqual(guardDeleteProject(empty, 'p'), []);
  assert.deepEqual(
    guardDeleteTeam(normalizeConfig({ teams: [{ id: 't', name: 'T' }] }), 't'),
    [],
  );
  assert.deepEqual(
    guardDeleteTeam(config, 'missing').map((i) => i.code),
    ['TEAM_NOT_FOUND'],
  );
});

test('componentLayers: bad project keys and layers are rejected with codes', () => {
  const layers = (c, list) => (c.jira.componentLayers = list);
  const entry = (extra = {}) => ({ projectKey: 'ABC', componentId: '1', componentName: 'FE', layer: 'frontend', ...extra });
  const issues = (list) => {
    const config = normalizeConfig(base());
    layers(config, list);
    return validateConfig(config).map((i) => `${i.code}@${i.path}`);
  };
  assert.deepEqual(issues([entry(), entry({ componentId: '2', layer: 'backend' })]), []);
  assert.deepEqual(issues([entry({ projectKey: 'abc-1' })]), ['COMPONENT_LAYER_PROJECT_KEY_INVALID@jira.componentLayers[0].projectKey']);
  assert.deepEqual(issues([entry(), entry({ componentId: '2', layer: 'qa' })]), ['COMPONENT_LAYER_INVALID@jira.componentLayers[1].layer']);
  assert.deepEqual(issues([entry(), entry({ layer: 'backend' })]), ['COMPONENT_LAYER_DUPLICATE@jira.componentLayers[1].componentId']);
});

test('blockedStatusIds: non-array and non-string entries are rejected with a code', () => {
  const issues = (value) => {
    const config = normalizeConfig(base());
    config.jira.blockedStatusIds = value;
    return validateConfig(config).map((i) => `${i.code}@${i.path}`);
  };
  assert.deepEqual(issues(['10', '11']), []);
  assert.deepEqual(issues('10'), ['BLOCKED_STATUS_INVALID@jira.blockedStatusIds']);
  assert.deepEqual(issues(['10', 7, '']), [
    'BLOCKED_STATUS_INVALID@jira.blockedStatusIds[1]',
    'BLOCKED_STATUS_INVALID@jira.blockedStatusIds[2]',
  ]);
});
