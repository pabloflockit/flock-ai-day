import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamScope, teamOutside } from '../shared/domain/scope.mjs';

const member = (accountId, o = {}) => ({ accountId, displayName: accountId, emailAddress: null, jiraActive: true, active: true, refreshedAt: '2024-01-01T00:00:00Z', ...o });
const epic = (key, active = true) => ({ key, issueTypeId: '1', summary: key, active, linkMethodUsed: 'parent' });
const config = () => ({
  teams: [
    { id: 't1', name: 'T1', description: null, active: true, members: [member('u1'), member('u2', { active: false }), member('shared')] },
    { id: 't2', name: 'T2', description: null, active: true, members: [member('shared'), member('u3')] },
  ],
  projects: [
    { id: 'p1', teamId: 't1', name: 'P1', description: null, active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E1'), epic('E1x', false)] },
    { id: 'p2', teamId: 't2', name: 'P2', description: null, active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E2')] },
    { id: 'p3', teamId: 't1', name: 'P3', description: null, active: false, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E3')] },
  ],
});
const unit = (key, o = {}) => ({ key, projectId: 'p1', epicKey: 'E1', assigneeAccountId: 'u1', assigneeName: 'U', statusCategory: 'doing', ...o });
const keys = (l) => l.map((u) => u.key);

test('teamScope keeps active project + active epic + active member', () => {
  const units = [
    unit('A'),
    unit('B', { epicKey: 'E1x' }),
    unit('C', { projectId: 'p3', epicKey: 'E3' }),
    unit('D', { assigneeAccountId: 'u2' }),
    unit('E', { assigneeAccountId: null }),
    unit('F', { assigneeAccountId: 'u3' }),
    unit('G', { projectId: 'zz' }),
    unit('H', { epicKey: null }),
  ];
  assert.deepEqual(keys(teamScope(units, 't1', config())), ['A']);
});

test('teamScope: unknown team gives []', () => {
  assert.deepEqual(teamScope([unit('A')], 'nope', config()), []);
});

test('a person in two teams only counts with each team projects work', () => {
  const units = [unit('A', { assigneeAccountId: 'shared' }), unit('B', { projectId: 'p2', epicKey: 'E2', assigneeAccountId: 'shared' })];
  assert.deepEqual(keys(teamScope(units, 't1', config())), ['A']);
  assert.deepEqual(keys(teamScope(units, 't2', config())), ['B']);
});

test('teamOutside splits unassigned and others (inactive or non-member), done included', () => {
  const units = [
    unit('A'),
    unit('U1', { assigneeAccountId: null }),
    unit('U2', { assigneeAccountId: null, statusCategory: 'done' }),
    unit('O1', { assigneeAccountId: 'u2' }),
    unit('O2', { assigneeAccountId: 'u3' }),
    unit('X', { epicKey: 'E1x', assigneeAccountId: null }),
    unit('Y', { projectId: 'p2', epicKey: 'E2', assigneeAccountId: null }),
  ];
  const out = teamOutside(units, 't1', config());
  assert.deepEqual(keys(out.unassigned), ['U1', 'U2']);
  assert.deepEqual(keys(out.others), ['O1', 'O2']);
  assert.deepEqual(teamOutside(units, 'nope', config()), { unassigned: [], others: [] });
});

test('inputs are not mutated', () => {
  const units = [unit('A')];
  const cfg = config();
  const snap = JSON.stringify([units, cfg]);
  teamScope(units, 't1', cfg);
  teamOutside(units, 't1', cfg);
  assert.equal(JSON.stringify([units, cfg]), snap);
});
