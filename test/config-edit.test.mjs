import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { validateConfig } from '../proxy/config/validate.mjs';
import * as edit from '../shared/config-edit.mjs';

const NOW = '2026-10-09T12:00:00.000Z';
const user = (accountId, extra = {}) => ({
  accountId,
  displayName: `User ${accountId}`,
  emailAddress: `${accountId}@example.com`,
  active: true,
  ...extra,
});
const base = () =>
  normalizeConfig({
    teams: [
      { id: 't1', name: 'Equipo Norte', members: [] },
      { id: 't2', name: 'Pagos', members: [] },
    ],
    projects: [
      { id: 'p1', teamId: 't1', name: 'Administración', epics: [{ key: 'ABC-1', issueTypeId: '10000', summary: 'Uno' }] },
      { id: 'p2', teamId: 't2', name: 'Cobranzas', epics: [] },
    ],
  });
const ok = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.deepEqual(validateConfig(result.config), []);
  return result.config;
};
const codes = (result) => {
  assert.equal(result.ok, false);
  return result.issues.map((i) => i.code);
};

test('mutations never modify the input config', () => {
  const config = base();
  const snapshot = structuredClone(config);
  edit.addTeam(config, { id: 't3', name: 'Nuevo' });
  edit.addEpic(config, 'p2', { key: 'ABC-9', issueTypeId: '10000', summary: 'x' });
  edit.removeProject(config, 'p2');
  assert.deepEqual(config, snapshot);
});

test('addTeam trims the name and rejects duplicates ignoring case', () => {
  const config = ok(edit.addTeam(base(), { id: 't3', name: '  Nuevo  ', description: '' }));
  assert.deepEqual(config.teams[2], { id: 't3', name: 'Nuevo', description: null, active: true, members: [] });
  assert.deepEqual(codes(edit.addTeam(base(), { id: 't3', name: 'equipo norte' })), ['TEAM_NAME_DUPLICATE']);
  assert.deepEqual(codes(edit.addTeam(base(), { id: 't3', name: '  ' })), ['TEAM_NAME_REQUIRED']);
});

test('updateTeam renames, toggles active and checks the name', () => {
  const config = ok(edit.updateTeam(base(), 't1', { name: 'Equipo Norte AR', active: false }));
  assert.equal(config.teams[0].name, 'Equipo Norte AR');
  assert.equal(config.teams[0].active, false);
  assert.deepEqual(codes(edit.updateTeam(base(), 't1', { name: 'PAGOS' })), ['TEAM_NAME_DUPLICATE']);
  assert.deepEqual(codes(edit.updateTeam(base(), 'zz', { name: 'x' })), ['TEAM_NOT_FOUND']);
});

test('removeTeam is blocked while the team has projects', () => {
  assert.deepEqual(codes(edit.removeTeam(base(), 't1')), ['TEAM_HAS_PROJECTS']);
  const withoutProjects = ok(edit.removeProject(ok(edit.removeEpic(base(), 'p1', 'ABC-1')), 'p1'));
  assert.deepEqual(ok(edit.removeTeam(withoutProjects, 't1')).teams.map((t) => t.id), ['t2']);
});

test('addMember copies the Jira data, rejects duplicates, and allows other teams', () => {
  const config = ok(edit.addMember(base(), 't1', user('a1'), NOW));
  assert.deepEqual(config.teams[0].members[0], {
    accountId: 'a1',
    displayName: 'User a1',
    emailAddress: 'a1@example.com',
    jiraActive: true,
    active: true,
    refreshedAt: NOW,
  });
  assert.deepEqual(codes(edit.addMember(config, 't1', user('a1'), NOW)), ['MEMBER_DUPLICATE']);
  const both = ok(edit.addMember(config, 't2', user('a1', { emailAddress: null, active: false }), NOW));
  assert.equal(both.teams[1].members[0].emailAddress, null);
  assert.equal(both.teams[1].members[0].jiraActive, false);
  assert.deepEqual(edit.memberTeams(both, 'a1').map((t) => t.id), ['t1', 't2']);
});

test('setMemberActive and removeMember', () => {
  const config = ok(edit.addMember(base(), 't1', user('a1'), NOW));
  assert.equal(ok(edit.setMemberActive(config, 't1', 'a1', false)).teams[0].members[0].active, false);
  assert.deepEqual(ok(edit.removeMember(config, 't1', 'a1')).teams[0].members, []);
  assert.deepEqual(codes(edit.removeMember(config, 't1', 'nobody')), ['MEMBER_NOT_FOUND']);
});

test('addProject defaults to task + count and checks team and name', () => {
  const config = ok(edit.addProject(base(), { id: 'p3', teamId: 't1', name: 'Reclamos' }));
  assert.deepEqual(config.projects[2], {
    id: 'p3',
    teamId: 't1',
    name: 'Reclamos',
    description: null,
    active: true,
    workUnit: 'task',
    measure: { kind: 'count' },
    epics: [],
  });
  assert.deepEqual(codes(edit.addProject(base(), { id: 'p3', teamId: 'zz', name: 'X' })), ['PROJECT_TEAM_MISSING']);
  assert.deepEqual(codes(edit.addProject(base(), { id: 'p3', teamId: 't1', name: 'cobranzas' })), ['PROJECT_NAME_DUPLICATE']);
});

test('updateProject sets the measurement', () => {
  const measure = { kind: 'field', fieldId: 'customfield_10016', fieldName: 'Story points', valueType: 'number' };
  const config = ok(edit.updateProject(base(), 'p1', { workUnit: 'both', measure }));
  assert.equal(config.projects[0].workUnit, 'both');
  assert.deepEqual(config.projects[0].measure, measure);
  assert.deepEqual(codes(edit.updateProject(base(), 'p1', { workUnit: 'nope' })), ['PROJECT_WORK_UNIT_INVALID']);
});

test('reassignProject moves a project to another existing team', () => {
  assert.equal(ok(edit.reassignProject(base(), 'p1', 't2')).projects[0].teamId, 't2');
  assert.deepEqual(codes(edit.reassignProject(base(), 'p1', 'zz')), ['PROJECT_TEAM_MISSING']);
});

test('removeProject is blocked while the project has epics', () => {
  assert.deepEqual(codes(edit.removeProject(base(), 'p1')), ['PROJECT_HAS_EPICS']);
  assert.deepEqual(ok(edit.removeProject(base(), 'p2')).projects.map((p) => p.id), ['p1']);
});

test('addEpic normalizes the key and reports the owner when it belongs to another project', () => {
  const config = ok(edit.addEpic(base(), 'p2', { key: ' abc-2 ', issueTypeId: '10000', summary: 'Dos' }));
  assert.deepEqual(config.projects[1].epics[0], {
    key: 'ABC-2',
    issueTypeId: '10000',
    summary: 'Dos',
    active: true,
    linkMethodUsed: null,
  });
  const owned = edit.addEpic(base(), 'p2', { key: 'abc-1', issueTypeId: '10000', summary: 'Uno' });
  assert.deepEqual(codes(owned), ['EPIC_OWNED_BY_OTHER_PROJECT']);
  assert.equal(owned.issues[0].ownerProjectId, 'p1');
  assert.deepEqual(codes(edit.addEpic(base(), 'p1', { key: 'ABC-1', issueTypeId: '1', summary: '' })), ['EPIC_DUPLICATE']);
  assert.equal(edit.findEpicOwner(base(), 'abc-1')?.id, 'p1');
  assert.equal(edit.findEpicOwner(base(), 'ABC-404'), null);
});

test('moveEpic keeps the epic data and moves it to the target project', () => {
  const config = ok(edit.moveEpic(base(), 'abc-1', 'p2'));
  assert.deepEqual(config.projects[0].epics, []);
  assert.equal(config.projects[1].epics[0].summary, 'Uno');
  assert.deepEqual(codes(edit.moveEpic(base(), 'ABC-1', 'p1')), ['EPIC_ALREADY_IN_PROJECT']);
  assert.deepEqual(codes(edit.moveEpic(base(), 'ABC-404', 'p2')), ['EPIC_NOT_FOUND']);
});

test('setEpicActive and removeEpic', () => {
  assert.equal(ok(edit.setEpicActive(base(), 'p1', 'ABC-1', false)).projects[0].epics[0].active, false);
  assert.deepEqual(ok(edit.removeEpic(base(), 'p1', 'ABC-1')).projects[0].epics, []);
  assert.deepEqual(codes(edit.removeEpic(base(), 'p2', 'ABC-1')), ['EPIC_NOT_FOUND']);
});

// ---- Jira connection (plan §6.1.1) ------------------------------------------------------------

test('setJiraConnection stores the trimmed URL and email and requires the email', () => {
  const config = ok(edit.setJiraConnection(base(), { baseUrl: 'https://acme.atlassian.net', email: '  a@b.c ' }));
  assert.equal(config.jira.baseUrl, 'https://acme.atlassian.net');
  assert.equal(config.jira.email, 'a@b.c');
  assert.deepEqual(codes(edit.setJiraConnection(base(), { baseUrl: 'https://acme.atlassian.net', email: ' ' })), [
    'JIRA_EMAIL_REQUIRED',
  ]);
});

test('setJiraParticularities sets link mode, field and overrides; epic_link needs the field', () => {
  const config = ok(
    edit.setJiraParticularities(base(), {
      epicLinkMode: 'epic_link',
      epicLinkFieldId: 'customfield_10014',
      statusCategoryOverrides: { '3': 'doing', '': 'done', '4': 'bogus' },
    }),
  );
  assert.equal(config.jira.epicLinkMode, 'epic_link');
  assert.equal(config.jira.epicLinkFieldId, 'customfield_10014');
  assert.deepEqual(config.jira.statusCategoryOverrides, { '3': 'doing' });

  const parent = ok(edit.setJiraParticularities(config, { epicLinkMode: 'parent', epicLinkFieldId: 'x', statusCategoryOverrides: {} }));
  assert.equal(parent.jira.epicLinkFieldId, null, 'parent mode never keeps a field');

  assert.deepEqual(
    codes(edit.setJiraParticularities(base(), { epicLinkMode: 'epic_link', epicLinkFieldId: ' ', statusCategoryOverrides: {} })),
    ['EPIC_LINK_FIELD_REQUIRED'],
  );
  assert.deepEqual(
    codes(edit.setJiraParticularities(base(), { epicLinkMode: 'other', epicLinkFieldId: null, statusCategoryOverrides: {} })),
    ['EPIC_LINK_MODE_INVALID'],
  );
});
