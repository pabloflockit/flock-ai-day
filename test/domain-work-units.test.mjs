import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkUnits } from '../shared/domain/work-units.mjs';

const config = (overrides = {}) => ({ jira: { statusCategoryOverrides: overrides } });
const project = (o = {}) => ({
  id: 'p1',
  teamId: 't1',
  workUnit: 'task',
  measure: { kind: 'count' },
  ...o,
});
const row = (o = {}) => ({
  key: 'A-1',
  issueTypeId: '1',
  issueTypeName: 'Task',
  hierarchyLevel: 0,
  isSubtask: false,
  summary: 'Do it',
  parentKey: null,
  epicKey: 'A-100',
  statusId: '10',
  statusName: 'In progress',
  statusCategory: 'doing',
  statusSince: '2024-03-04T13:00:00Z',
  firstDoingAt: '2024-03-03T13:00:00Z',
  doneAt: null,
  resolvedAt: null,
  assigneeAccountId: 'u1',
  assigneeName: 'Ana',
  priorityName: null,
  measures: {},
  createdAt: '2024-03-01T13:00:00Z',
  updatedAt: '2024-03-05T13:00:00Z',
  dueDate: '2024-03-20',
  ...o,
});
const sub = (o = {}) => row({ key: 'A-2', issueTypeName: 'Sub-task', hierarchyLevel: -1, isSubtask: true, parentKey: 'A-1', ...o });
const epic = (o = {}) => row({ key: 'A-100', issueTypeName: 'Epic', hierarchyLevel: 1, epicKey: null, ...o });
const field = (valueType = 'number') => ({ kind: 'field', fieldId: 'cf1', fieldName: 'Points', valueType });

test('task + count: one flat unit per task, measureValue 1, epics excluded', () => {
  const { units, tasksWithoutSubtasks } = buildWorkUnits([row(), epic(), sub()], project(), config());
  assert.equal(units.length, 1);
  assert.deepEqual(units[0], {
    key: 'A-1',
    unitType: 'task',
    projectId: 'p1',
    teamId: 't1',
    epicKey: 'A-100',
    parentKey: null,
    summary: 'Do it',
    issueTypeName: 'Task',
    statusId: '10',
    statusName: 'In progress',
    statusCategory: 'doing',
    statusSince: '2024-03-04T13:00:00Z',
    createdAt: '2024-03-01T13:00:00Z',
    firstDoingAt: '2024-03-03T13:00:00Z',
    doneAt: null,
    assigneeAccountId: 'u1',
    assigneeName: 'Ana',
    dueDate: '2024-03-20',
    measureValue: 1,
  });
  assert.deepEqual(tasksWithoutSubtasks, []);
});

test('hierarchyLevel null counts as a task', () => {
  const { units } = buildWorkUnits([row({ hierarchyLevel: null })], project(), config());
  assert.equal(units.length, 1);
});

test('status override changes the effective statusCategory and doneAt', () => {
  const r = row({ doneAt: '2024-03-06T12:00:00Z' });
  assert.equal(buildWorkUnits([r], project(), config())[ 'units' ][0].statusCategory, 'doing');
  const [u] = buildWorkUnits([r], project(), config({ 10: 'done' })).units;
  assert.equal(u.statusCategory, 'done');
  assert.equal(u.doneAt, '2024-03-06T12:00:00Z');
});

test('reopened issue: doneAt kept by the projection but effective category not done -> doneAt null', () => {
  const r = row({ statusCategory: 'doing', doneAt: '2024-03-06T12:00:00Z' });
  assert.equal(buildWorkUnits([r], project(), config()).units[0].doneAt, null);
});

test('does not mutate its inputs', () => {
  const rows = [row(), sub()];
  const p = project({ workUnit: 'both' });
  const snapshot = structuredClone({ rows, p });
  buildWorkUnits(rows, p, config());
  assert.deepEqual({ rows, p }, snapshot);
});

test('field measure: value, 0 stays 0, null and missing key -> null', () => {
  const p = project({ measure: field() });
  const rows = [
    row({ key: 'A-1', measures: { cf1: 5 } }),
    row({ key: 'A-2', measures: { cf1: 0 } }),
    row({ key: 'A-3', measures: { cf1: null } }),
    row({ key: 'A-4', measures: {} }),
  ];
  assert.deepEqual(buildWorkUnits(rows, p, config()).units.map((u) => u.measureValue), [5, 0, null, null]);
});

test('field measure time_seconds -> hours, keeping the fraction; 0 and null preserved', () => {
  const p = project({ measure: field('time_seconds') });
  const rows = [
    row({ key: 'A-1', measures: { cf1: 7200 } }),
    row({ key: 'A-2', measures: { cf1: 5400 } }),
    row({ key: 'A-3', measures: { cf1: 0 } }),
    row({ key: 'A-4', measures: { cf1: null } }),
  ];
  assert.deepEqual(buildWorkUnits(rows, p, config()).units.map((u) => u.measureValue), [2, 1.5, 0, null]);
});

test('subtask: only subtask units; tasks with no referencing subtask are listed as task-shaped units', () => {
  const rows = [
    row({ key: 'A-1' }),
    row({ key: 'A-3' }),
    epic(),
    sub({ key: 'A-2', parentKey: 'A-1' }),
    sub({ key: 'A-4', parentKey: 'A-1' }),
  ];
  const { units, tasksWithoutSubtasks } = buildWorkUnits(rows, project({ workUnit: 'subtask' }), config());
  assert.deepEqual(units.map((u) => [u.key, u.unitType]), [['A-2', 'subtask'], ['A-4', 'subtask']]);
  assert.equal(units[0].parentKey, 'A-1');
  assert.deepEqual(tasksWithoutSubtasks.map((u) => [u.key, u.unitType]), [['A-3', 'task']]);
});

test('subtask: field measure applies to subtask rows and tasksWithoutSubtasks use the same measure', () => {
  const p = project({ workUnit: 'subtask', measure: field('time_seconds') });
  const rows = [row({ key: 'A-3', measures: { cf1: 3600 } }), sub({ measures: { cf1: 1800 } })];
  const r = buildWorkUnits(rows, p, config());
  assert.equal(r.units[0].measureValue, 0.5);
  assert.equal(r.tasksWithoutSubtasks[0].measureValue, 1);
});

test('task: tasksWithoutSubtasks is empty', () => {
  assert.deepEqual(buildWorkUnits([row()], project(), config()).tasksWithoutSubtasks, []);
});

test('both: tasks and subtasks in one array, distinguished by unitType', () => {
  const rows = [row({ key: 'A-1' }), row({ key: 'A-3' }), epic(), sub({ key: 'A-2', parentKey: 'A-1' })];
  const { units, tasksWithoutSubtasks } = buildWorkUnits(rows, project({ workUnit: 'both' }), config());
  assert.deepEqual(units.map((u) => [u.key, u.unitType]), [['A-1', 'task'], ['A-3', 'task'], ['A-2', 'subtask']]);
  assert.deepEqual(tasksWithoutSubtasks.map((u) => u.key), ['A-3']);
});
