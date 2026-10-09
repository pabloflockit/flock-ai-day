import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectIssue, searchFields, completeChangelogs } from '../proxy/jira/projection.mjs';

const types = new Map([
  ['10001', { id: '10001', name: 'Task', hierarchyLevel: 0, subtask: false }],
  ['10002', { id: '10002', name: 'Task', hierarchyLevel: 0, subtask: false }], // same visible name
  ['10003', { id: '10003', name: 'Sub-task', hierarchyLevel: -1, subtask: true }],
]);
const statuses = new Map([
  ['1', { id: '1', name: 'To Do', statusCategory: { key: 'new' } }],
  ['2', { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } }],
  ['3', { id: '3', name: 'Done', statusCategory: { key: 'done' } }],
  ['4', { id: '4', name: 'Review', statusCategory: { key: 'indeterminate' } }],
]);

const raw = (overrides = {}, fields = {}) => ({
  key: 'ABC-2',
  fields: {
    summary: 'Do it',
    issuetype: { id: '10001', name: 'Task' },
    parent: { key: 'ABC-1' },
    status: { id: '2', name: 'In Progress' },
    assignee: { accountId: 'acc-1', displayName: 'Ana' },
    priority: { name: 'High' },
    created: '2024-01-05T10:00:00.000-0300',
    updated: '2024-02-01T00:30:00.000+0100',
    duedate: '2024-03-09',
    resolutiondate: null,
    ...fields,
  },
  ...overrides,
});
const ctx = (extra = {}) => ({
  issueTypesById: types,
  statusesById: statuses,
  measureFieldIds: ['customfield_1'],
  epicKeyByKey: new Map([['ABC-2', 'ABC-1']]),
  ...extra,
});
const history = (created, from, to) => ({
  created,
  items: [{ field: 'status', fieldId: 'status', from, to }],
});

test('measures: null when absent, 0 stays 0, numeric string parsed, non-numeric null', () => {
  const run = (value) =>
    projectIssue(raw({}, value === undefined ? {} : { customfield_1: value }), ctx()).measures.customfield_1;
  assert.equal(run(undefined), null);
  assert.equal(run(null), null);
  assert.equal(run(0), 0);
  assert.equal(run(5), 5);
  assert.equal(run('8'), 8);
  assert.equal(run('abc'), null);
  assert.equal(run(''), null);
  assert.equal(run({ x: 1 }), null);
  assert.equal(run(Number.NaN), null);
});

test('identity by id: two types sharing a name stay distinct', () => {
  const a = projectIssue(raw(), ctx());
  const b = projectIssue(raw({}, { issuetype: { id: '10002', name: 'Task' } }), ctx());
  assert.equal(a.issueTypeId, '10001');
  assert.equal(b.issueTypeId, '10002');
  assert.equal(a.issueTypeName, 'Task');
  assert.equal(a.hierarchyLevel, 0);
  assert.equal(a.statusId, '2');
  assert.equal(a.statusName, 'In Progress');
});

test('hierarchy level and subtask come from /issuetype metadata by id, not the embedded type', () => {
  const embeddedLies = raw({}, { issuetype: { id: '10003', name: 'Task', hierarchyLevel: 0, subtask: false } });
  const row = projectIssue(embeddedLies, ctx());
  assert.equal(row.isSubtask, true);
  assert.equal(row.hierarchyLevel, -1);
});

test('isSubtask is strict: a child with a parent is not a subtask', () => {
  const child = projectIssue(raw(), ctx());
  assert.equal(child.parentKey, 'ABC-1');
  assert.equal(child.isSubtask, false);
  // level -1 without the flag still counts; neither -> false
  const lvl = new Map([['9', { id: '9', name: 'X', hierarchyLevel: -1, subtask: false }]]);
  assert.equal(
    projectIssue(raw({}, { issuetype: { id: '9', name: 'X' } }), ctx({ issueTypesById: lvl })).isSubtask,
    true,
  );
});

test('unknown type id falls back to the embedded issuetype', () => {
  const row = projectIssue(
    raw({}, { issuetype: { id: '77', name: 'Weird', hierarchyLevel: 0, subtask: false } }),
    ctx(),
  );
  assert.equal(row.issueTypeId, '77');
  assert.equal(row.hierarchyLevel, 0);
  assert.equal(row.isSubtask, false);
});

test('status category is Jira category by id, no overrides', () => {
  assert.equal(projectIssue(raw(), ctx()).statusCategory, 'doing');
  assert.equal(projectIssue(raw({}, { status: { id: '3', name: 'Done' } }), ctx()).statusCategory, 'done');
  assert.equal(projectIssue(raw({}, { status: { id: '1', name: 'To Do' } }), ctx()).statusCategory, 'todo');
});

test('instants become ISO Z; dueDate stays a calendar date', () => {
  const row = projectIssue(raw({}, { resolutiondate: '2024-02-02T09:15:00.000-0300' }), ctx());
  assert.equal(row.createdAt, '2024-01-05T13:00:00.000Z');
  assert.equal(row.updatedAt, '2024-01-31T23:30:00.000Z');
  assert.equal(row.resolvedAt, '2024-02-02T12:15:00.000Z');
  assert.equal(row.dueDate, '2024-03-09');
  assert.equal(projectIssue(raw({}, { duedate: null }), ctx()).dueDate, null);
});

test('assignee, priority, epic resolution and no raw fields leak', () => {
  const row = projectIssue(raw(), ctx());
  assert.equal(row.assigneeAccountId, 'acc-1');
  assert.equal(row.assigneeName, 'Ana');
  assert.equal(row.priorityName, 'High');
  assert.equal(row.epicKey, 'ABC-1');
  assert.equal('fields' in row, false);
  assert.equal(Object.keys(row).some((k) => k.startsWith('customfield')), false);
  const none = projectIssue(raw({}, { assignee: null, priority: null }), ctx({ epicKeyByKey: new Map() }));
  assert.equal(none.assigneeAccountId, null);
  assert.equal(none.priorityName, null);
  assert.equal(none.epicKey, null);
});

test('changelog: statusSince, firstDoingAt, doneAt, ordered by created', () => {
  const histories = [
    history('2024-01-20T10:00:00.000+0000', '4', '3'), // out of order on purpose
    history('2024-01-06T10:00:00.000+0000', '1', '2'),
    history('2024-01-10T10:00:00.000+0000', '2', '4'),
    { created: '2024-01-07T10:00:00.000+0000', items: [{ field: 'assignee', fieldId: 'assignee', from: null, to: 'x' }] },
  ];
  const row = projectIssue(
    raw({ changelog: { histories, total: 4, maxResults: 100 } }, { status: { id: '3', name: 'Done' } }),
    ctx(),
  );
  assert.equal(row.firstDoingAt, '2024-01-06T10:00:00.000Z');
  assert.equal(row.doneAt, '2024-01-20T10:00:00.000Z');
  assert.equal(row.statusSince, '2024-01-20T10:00:00.000Z');
});

test('changelog: doneAt falls back to resolutiondate; statusSince falls back to createdAt', () => {
  const resolved = projectIssue(
    raw({ changelog: { histories: [] } }, { resolutiondate: '2024-02-02T09:15:00.000-0300' }),
    ctx(),
  );
  assert.equal(resolved.doneAt, '2024-02-02T12:15:00.000Z');
  assert.equal(resolved.statusSince, resolved.createdAt);
  assert.equal(resolved.firstDoingAt, null);
  const bare = projectIssue(raw(), ctx());
  assert.equal(bare.doneAt, null);
  assert.equal(bare.statusSince, bare.createdAt);
});

test('changelog uses status ids: to-status of unknown id is skipped for category', () => {
  const row = projectIssue(
    raw({ changelog: { histories: [history('2024-01-06T10:00:00.000+0000', '1', '999')] } }),
    ctx(),
  );
  assert.equal(row.firstDoingAt, null);
  assert.equal(row.statusSince, '2024-01-06T10:00:00.000Z');
});

test('searchFields requests everything up front, deduped, epic link only when used', () => {
  const f = searchFields({ measureFieldIds: ['customfield_1', 'customfield_1'], epicLinkFieldId: null });
  for (const name of [
    'summary', 'issuetype', 'parent', 'status', 'assignee', 'priority',
    'created', 'updated', 'duedate', 'resolutiondate', 'customfield_1',
  ]) assert.ok(f.includes(name), name);
  assert.equal(f.filter((x) => x === 'customfield_1').length, 1);
  assert.equal(f.includes('customfield_9'), false);
  assert.ok(searchFields({ measureFieldIds: [], epicLinkFieldId: 'customfield_9' }).includes('customfield_9'));
});

test('completeChangelogs: fetches per issue only when truncated or missing', async () => {
  const calls = [];
  const client = {
    issueChangelog: async (key) => {
      calls.push(key);
      return [history('2024-01-06T10:00:00.000+0000', '1', '2')];
    },
  };
  const issues = [
    { key: 'A-1', changelog: { histories: [1, 2], total: 2, maxResults: 100 } }, // complete
    { key: 'A-2', changelog: { histories: [1], total: 3, maxResults: 100 } }, // histories < total
    { key: 'A-3', changelog: { histories: [1, 2], total: 150, maxResults: 2 } }, // maxResults < total
    { key: 'A-4' }, // no changelog at all
  ];
  await completeChangelogs({ client, issues });
  assert.deepEqual(calls.sort(), ['A-2', 'A-3', 'A-4']);
  assert.equal(issues[1].changelog.histories.length, 1);
  assert.equal(issues[0].changelog.histories.length, 2);
});

test('completeChangelogs: a failing per-issue fetch rejects (shard fails, never silent)', async () => {
  const client = { issueChangelog: async () => { throw new Error('boom'); } };
  await assert.rejects(completeChangelogs({ client, issues: [{ key: 'A-1' }] }), /boom/);
});
