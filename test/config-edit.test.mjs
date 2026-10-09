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

test('setGeneralSettings sets business days and AI; days must be whole numbers from 1 to 365', () => {
  const config = ok(edit.setGeneralSettings(base(), { staleBusinessDays: 3, agingBusinessDays: 15, aiEnabled: true }));
  assert.equal(config.settings.staleBusinessDays, 3);
  assert.equal(config.settings.agingBusinessDays, 15);
  assert.equal(config.settings.ai.enabled, true);
  assert.equal(config.settings.fullRefreshMaxAgeHours, base().settings.fullRefreshMaxAgeHours);

  assert.deepEqual(
    codes(edit.setGeneralSettings(base(), { staleBusinessDays: 0, agingBusinessDays: 2.5, aiEnabled: false })),
    ['SETTINGS_DAYS_INVALID', 'SETTINGS_DAYS_INVALID'],
  );
  const issue = edit.setGeneralSettings(base(), { staleBusinessDays: 5, agingBusinessDays: 366, aiEnabled: false });
  assert.equal(issue.ok, false);
  assert.equal(issue.issues[0].path, 'settings.agingBusinessDays');
});

test('setComponentLayer maps a component to a layer, replaces it and removes it with null', () => {
  const component = { projectKey: 'ABC', componentId: '10', componentName: 'FRONTEND' };
  const first = ok(edit.setComponentLayer(base(), component, 'frontend'));
  assert.deepEqual(first.jira.componentLayers, [{ ...component, layer: 'frontend' }]);

  const other = ok(edit.setComponentLayer(first, { projectKey: 'ABC', componentId: '11', componentName: 'BACKEND' }, 'backend'));
  const moved = ok(edit.setComponentLayer(other, { ...component, componentName: 'Front' }, 'functional'));
  assert.deepEqual(moved.jira.componentLayers.map((l) => [l.componentId, l.layer, l.componentName]), [
    ['10', 'functional', 'Front'],
    ['11', 'backend', 'BACKEND'],
  ]);

  const removed = ok(edit.setComponentLayer(moved, component, null));
  assert.deepEqual(removed.jira.componentLayers.map((l) => l.componentId), ['11']);
  // The same component id under another Jira project is a different component.
  const twin = ok(edit.setComponentLayer(removed, { ...component, projectKey: 'XYZ' }, 'backend'));
  assert.equal(twin.jira.componentLayers.length, 2);
  assert.equal(ok(edit.setComponentLayer(base(), component, null)).jira.componentLayers.length, 0);
});

test('setComponentLayer rejects bad input and never modifies the config', () => {
  const config = base();
  const snapshot = structuredClone(config);
  const component = { projectKey: 'ABC', componentId: '10', componentName: 'FE' };
  assert.deepEqual(codes(edit.setComponentLayer(config, component, 'qa')), ['COMPONENT_LAYER_INVALID']);
  assert.deepEqual(codes(edit.setComponentLayer(config, { ...component, projectKey: 'a b' }, 'backend')), [
    'COMPONENT_LAYER_PROJECT_KEY_INVALID',
  ]);
  assert.deepEqual(codes(edit.setComponentLayer(config, { ...component, componentId: ' ' }, 'backend')), [
    'COMPONENT_LAYER_COMPONENT_REQUIRED',
  ]);
  edit.setComponentLayer(config, component, 'backend');
  assert.deepEqual(config, snapshot);
});

test('setJiraParticularities keeps the component layers', () => {
  const withLayer = ok(edit.setComponentLayer(base(), { projectKey: 'ABC', componentId: '1', componentName: 'FE' }, 'frontend'));
  const next = ok(edit.setJiraParticularities(withLayer, { epicLinkMode: 'parent', epicLinkFieldId: null, statusCategoryOverrides: {} }));
  assert.equal(next.jira.componentLayers.length, 1);
});

test('setBlockedStatus adds a status id once, keeps order and removes it with false', () => {
  const one = ok(edit.setBlockedStatus(base(), '10', true));
  assert.deepEqual(one.jira.blockedStatusIds, ['10']);
  const two = ok(edit.setBlockedStatus(one, ' 3 ', true));
  assert.deepEqual(two.jira.blockedStatusIds, ['10', '3']);
  assert.deepEqual(ok(edit.setBlockedStatus(two, '10', true)).jira.blockedStatusIds, ['10', '3']);
  assert.deepEqual(ok(edit.setBlockedStatus(two, '10', false)).jira.blockedStatusIds, ['3']);
  assert.deepEqual(ok(edit.setBlockedStatus(base(), '99', false)).jira.blockedStatusIds, []);
});

test('setBlockedStatus rejects an empty id and never modifies the config', () => {
  const config = base();
  const snapshot = structuredClone(config);
  assert.deepEqual(codes(edit.setBlockedStatus(config, '  ', true)), ['BLOCKED_STATUS_REQUIRED']);
  assert.deepEqual(config, snapshot);
});
