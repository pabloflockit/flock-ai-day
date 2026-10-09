import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate,
  measurementGroups,
  progress,
  statusDistribution,
  workInProgress,
  loadByMember,
  staleUnits,
  weeklyThroughput,
  unassignedOpen,
  othersOpenByPerson,
} from '../shared/domain/metrics.mjs';
import { daysInStatus } from '../shared/domain/status.mjs';

const TZ = 'America/Argentina/Buenos_Aires';
const unit = (key, o = {}) => ({
  key,
  unitType: 'task',
  projectId: 'p1',
  teamId: 't1',
  epicKey: 'E1',
  parentKey: null,
  summary: key,
  issueTypeName: 'Task',
  statusId: '1',
  statusName: 'To do',
  statusCategory: 'todo',
  statusSince: '2024-03-04T13:00:00Z',
  createdAt: '2024-03-01T13:00:00Z',
  firstDoingAt: null,
  doneAt: null,
  assigneeAccountId: 'u1',
  assigneeName: 'Ana',
  dueDate: null,
  measureValue: 1,
  ...o,
});
const epic = (key, active = true) => ({ key, issueTypeId: '1', summary: `S-${key}`, active, linkMethodUsed: 'parent' });
const project = (o = {}) => ({ id: 'p1', teamId: 't1', name: 'P1', description: null, active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E1'), epic('E2')], ...o });
const member = (accountId, displayName, active = true) => ({ accountId, displayName, emailAddress: null, jiraActive: true, active, refreshedAt: '' });
const keys = (l) => l.map((u) => u.key);

test('aggregate: count, measure sum, null measure reported, 0 counts', () => {
  const a = unit('A', { measureValue: 0 });
  const b = unit('B', { measureValue: 3 });
  const c = unit('C', { measureValue: null });
  assert.deepEqual(aggregate([a, b, c]), { count: 3, measure: 3, missingMeasure: [c] });
  assert.deepEqual(aggregate([a]), { count: 1, measure: 0, missingMeasure: [] });
  assert.deepEqual(aggregate([]), { count: 0, measure: 0, missingMeasure: [] });
});

test('measurementGroups: never mixes unit types or measures; stable order', () => {
  const projects = [
    project({ id: 'p1', measure: { kind: 'count' } }),
    project({ id: 'p2', measure: { kind: 'field', fieldId: 'cf1', fieldName: 'Pts', valueType: 'number' } }),
  ];
  const units = [
    unit('S1', { unitType: 'subtask', projectId: 'p1' }),
    unit('T2', { projectId: 'p2' }),
    unit('T1', { projectId: 'p1' }),
    unit('T3', { projectId: 'p1' }),
  ];
  const groups = measurementGroups(units, projects);
  assert.deepEqual(groups.map((g) => [g.unitType, g.measureKey, keys(g.units)]), [
    ['task', 'count', ['T1', 'T3']],
    ['task', 'field:cf1', ['T2']],
    ['subtask', 'count', ['S1']],
  ]);
  assert.deepEqual(groups[1].measure, projects[1].measure);
});

test('M1 progress: project is the sum of units, only active epics, config order, empty omitted', () => {
  const projects = [project({ epics: [epic('E1'), epic('E2'), epic('E3', false)] }), project({ id: 'p2', name: 'P2' })];
  const units = [
    unit('A', { epicKey: 'E2', statusCategory: 'done' }),
    unit('B', { epicKey: 'E1', statusCategory: 'done', measureValue: null }),
    unit('C', { epicKey: 'E1' }),
    unit('D', { epicKey: 'E1' }),
    unit('X', { epicKey: 'E3' }),
  ];
  const [p, ...rest] = progress(units, projects);
  assert.equal(rest.length, 0);
  assert.equal(p.projectId, 'p1');
  assert.equal(p.projectName, 'P1');
  assert.equal(p.total.count, 5); // sum of the given units; epic scoping is teamScope's job
  assert.equal(p.done.count, 2);
  assert.deepEqual(keys(p.done.units), ['A', 'B']);
  assert.deepEqual(keys(p.done.missingMeasure), ['B']);
  assert.deepEqual(p.epics.map((e) => [e.epicKey, e.epicSummary, e.total.count, e.done.count]), [
    ['E1', 'S-E1', 3, 1],
    ['E2', 'S-E2', 1, 1],
  ]);
});

test('M2 statusDistribution: epics first-seen, categories todo/doing/done, empty omitted', () => {
  const units = [
    unit('A', { epicKey: 'E2', statusCategory: 'done', statusId: '9', statusName: 'Done' }),
    unit('B', { epicKey: 'E1', statusCategory: 'doing', statusId: '5', statusName: 'Dev' }),
    unit('C', { epicKey: 'E1', statusCategory: 'todo', statusId: '1', statusName: 'To do' }),
    unit('D', { epicKey: 'E1', statusCategory: 'doing', statusId: '5', statusName: 'Dev' }),
  ];
  const dist = statusDistribution(units);
  assert.deepEqual(dist.map((d) => d.epicKey), ['E2', 'E1']);
  assert.deepEqual(dist[0].categories.map((c) => c.category), ['done']);
  assert.deepEqual(dist[1].categories.map((c) => c.category), ['todo', 'doing']);
  const dev = dist[1].categories[1].statuses[0];
  assert.equal(dev.statusId, '5');
  assert.equal(dev.statusName, 'Dev');
  assert.equal(dev.count, 2);
  assert.deepEqual(keys(dev.units), ['B', 'D']);
});

test('M3 workInProgress: doing only, alphabetical (es), only members with doing work', () => {
  const members = [member('u1', 'Zoe'), member('u2', 'Álvaro'), member('u3', 'Bea')];
  const units = [
    unit('A', { statusCategory: 'doing', assigneeAccountId: 'u1' }),
    unit('B', { statusCategory: 'doing', assigneeAccountId: 'u2' }),
    unit('C', { statusCategory: 'todo', assigneeAccountId: 'u3' }),
    unit('D', { statusCategory: 'doing', assigneeAccountId: 'u1', measureValue: null }),
  ];
  const wip = workInProgress(units, members);
  assert.equal(wip.total.count, 3);
  assert.deepEqual(wip.byMember.map((m) => [m.accountId, m.displayName, m.count]), [
    ['u2', 'Álvaro', 1],
    ['u1', 'Zoe', 2],
  ]);
  assert.deepEqual(keys(wip.byMember[1].missingMeasure), ['D']);
});

test('M4 loadByMember: active members alphabetical, empty buckets, done excluded', () => {
  const members = [member('u1', 'Zoe'), member('u2', 'Ana'), member('u3', 'Old', false)];
  const units = [
    unit('A', { assigneeAccountId: 'u1', statusCategory: 'todo' }),
    unit('B', { assigneeAccountId: 'u1', statusCategory: 'doing' }),
    unit('C', { assigneeAccountId: 'u1', statusCategory: 'done' }),
  ];
  const load = loadByMember(units, members);
  assert.deepEqual(load.map((l) => l.accountId), ['u2', 'u1']);
  assert.deepEqual(load[0].open, { count: 0, measure: 0, missingMeasure: [], units: [] });
  assert.deepEqual([load[1].open.count, load[1].todo.count, load[1].doing.count], [2, 1, 1]);
});

test('M5 staleUnits: strictly above threshold, open only, days desc then key', () => {
  const now = '2024-03-13T15:00:00Z';
  const opts = { now, timeZone: TZ };
  const old = unit('B', { statusSince: '2024-03-01T13:00:00Z' });
  const old2 = unit('A', { statusSince: '2024-03-01T13:00:00Z' });
  const mid = unit('C', { statusSince: '2024-03-08T13:00:00Z' });
  const done = unit('D', { statusSince: '2024-03-01T13:00:00Z', statusCategory: 'done' });
  const fresh = unit('E', { statusSince: '2024-03-13T13:00:00Z' });
  const days = daysInStatus(mid, opts);
  assert.ok(days > 0);
  assert.deepEqual(staleUnits([mid], days, opts), []);
  assert.deepEqual(staleUnits([mid], days - 1, opts), [{ unit: mid, days }]);
  const res = staleUnits([mid, old, done, fresh, old2], days - 1, opts);
  assert.deepEqual(res.map((r) => r.unit.key), ['A', 'B', 'C']);
  assert.ok(res[0].days > res[2].days);
});

test('M6 weeklyThroughput: exactly N weeks oldest->newest, year end and time zone', () => {
  const now = '2025-01-02T15:00:00Z'; // Thu, ISO 2025-W01 (Monday 2024-12-30)
  const units = [
    unit('A', { statusCategory: 'done', doneAt: '2024-12-30T01:00:00Z' }), // Dec 29 local -> 2024-W52
    unit('B', { statusCategory: 'done', doneAt: '2024-12-31T15:00:00Z' }), // 2025-W01
    unit('C', { statusCategory: 'done', doneAt: '2025-01-02T10:00:00Z', measureValue: null }), // 2025-W01
    unit('D', { statusCategory: 'done', doneAt: '2020-01-01T10:00:00Z' }), // outside window
    unit('E'),
  ];
  const { weeks, hasDoneData } = weeklyThroughput(units, { now, timeZone: TZ, weeks: 3 });
  assert.equal(hasDoneData, true);
  assert.deepEqual(weeks.map((w) => [w.weekKey, w.weekStart, w.count]), [
    ['2024-W51', '2024-12-16', 0],
    ['2024-W52', '2024-12-23', 1],
    ['2025-W01', '2024-12-30', 2],
  ]);
  assert.deepEqual(keys(weeks[2].missingMeasure), ['C']);
  assert.equal(weeklyThroughput(units, { now, timeZone: TZ }).weeks.length, 8);
});

test('M6 weeklyThroughput: hasDoneData false without any doneAt', () => {
  const r = weeklyThroughput([unit('A')], { now: '2025-01-02T15:00:00Z', timeZone: TZ, weeks: 2 });
  assert.equal(r.hasDoneData, false);
  assert.equal(r.weeks.length, 2);
});

test('F1/F2 outside-team views are open only', () => {
  const outside = {
    unassigned: [unit('A', { assigneeAccountId: null }), unit('B', { assigneeAccountId: null, statusCategory: 'done' })],
    others: [
      unit('C', { assigneeAccountId: 'u9', assigneeName: 'Zed' }),
      unit('D', { assigneeAccountId: 'u8', assigneeName: null }),
      unit('E', { assigneeAccountId: 'u9', assigneeName: 'Zed' }),
      unit('F', { assigneeAccountId: 'u7', assigneeName: 'Bo', statusCategory: 'done' }),
    ],
  };
  const f1 = unassignedOpen(outside);
  assert.deepEqual(keys(f1.units), ['A']);
  assert.equal(f1.count, 1);
  const f2 = othersOpenByPerson(outside);
  assert.deepEqual(f2.map((p) => [p.accountId, p.displayName, p.count]), [
    ['u8', 'u8', 1],
    ['u9', 'Zed', 2],
  ]);
});

test('inputs are not mutated', () => {
  const units = [unit('B'), unit('A', { statusCategory: 'done', doneAt: '2025-01-02T10:00:00Z' })];
  const snap = JSON.stringify(units);
  const projects = [project()];
  workInProgress(units, []);
  progress(units, projects);
  statusDistribution(units);
  weeklyThroughput(units, { now: '2025-01-02T15:00:00Z', timeZone: TZ });
  assert.equal(JSON.stringify(units), snap);
});
