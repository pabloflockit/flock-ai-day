import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSprintClose, layersOf, movedInPeriod } from '../shared/domain/sprint-close.mjs';

const TZ = 'America/Argentina/Buenos_Aires';
const PERIOD = { from: '2026-09-01', to: '2026-09-14' };

// Status ids: 1 To Do (todo), 2 In Progress (doing), 4 Done (done), 5 Blocked (doing), 6 QA OK (doing, overridden to done)
const STATUSES = [
  { id: '1', name: 'To Do', statusCategory: 'todo' },
  { id: '2', name: 'In Progress', statusCategory: 'doing' },
  { id: '4', name: 'Done', statusCategory: 'done' },
  { id: '5', name: 'Blocked', statusCategory: 'doing' },
  { id: '6', name: 'QA OK', statusCategory: 'doing' },
];
const CATEGORY = Object.fromEntries(STATUSES.map((s) => [s.id, s.statusCategory]));
const NAME = Object.fromEntries(STATUSES.map((s) => [s.id, s.name]));

/** Components: 1 FE, 2 BE, 3 functional, 9 an unmapped area. */
const COMPONENT_LAYERS = [
  { projectKey: 'A', componentId: '1', componentName: 'FRONTEND', layer: 'frontend' },
  { projectKey: 'A', componentId: '2', componentName: 'BACKEND', layer: 'backend' },
  { projectKey: 'A', componentId: '3', componentName: 'QA', layer: 'functional' },
];

/**
 * @param {string} key
 * @param {{ sub?: boolean, parent?: string | null, epic?: string | null, status?: string, comps?: string[],
 *   moves?: Array<[string, string | null, string]>, who?: string | null, level?: number }} [o]
 */
function row(key, o = {}) {
  const status = o.status ?? '2';
  return {
    key,
    issueTypeId: o.sub ? '10004' : '10001',
    issueTypeName: o.sub ? 'Sub-task' : 'Story',
    hierarchyLevel: o.level ?? (o.sub ? -1 : 0),
    isSubtask: Boolean(o.sub),
    summary: `Summary ${key}`,
    parentKey: o.parent ?? null,
    epicKey: o.epic === undefined ? 'A-1' : o.epic,
    statusId: status,
    statusName: NAME[status],
    statusCategory: CATEGORY[status],
    statusSince: null,
    firstDoingAt: null,
    doneAt: null,
    resolvedAt: null,
    statusChanges: (o.moves ?? []).map(([at, fromStatusId, toStatusId]) => ({ at, fromStatusId, toStatusId })),
    components: (o.comps ?? []).map((id) => ({ id, name: `C${id}` })),
    assigneeAccountId: o.who === undefined ? 'acc-1' : o.who,
    assigneeName: o.who === null ? null : 'Ana',
    priorityName: null,
    measures: {},
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
    dueDate: null,
  };
}

const CONFIG = {
  jira: { statusCategoryOverrides: { 6: 'done' }, componentLayers: COMPONENT_LAYERS },
  teams: [{ id: 't1', name: 'Team', active: true, members: [] }],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      active: true,
      epics: [
        { key: 'A-1', summary: 'Epic one', active: true },
        { key: 'A-2', summary: 'Epic two', active: true },
        { key: 'A-3', summary: 'Inactive', active: false },
      ],
    },
    { id: 'p2', teamId: 'other', active: true, epics: [{ key: 'B-1', summary: 'Other team', active: true }] },
  ],
};

const IN = (at) => `${at}T15:00:00.000Z`;

function build({ epicRows = [], memberRows = [], blockedStatusIds = ['5'], config = CONFIG } = {}) {
  return buildSprintClose({
    teamId: 't1',
    config,
    period: PERIOD,
    timeZone: TZ,
    statuses: STATUSES,
    blockedStatusIds,
    epicRows,
    memberRows,
  });
}

const keysOf = (primaries) => primaries.map((p) => [p.key, p.counted, p.subtasks.map((s) => s.key)]);

test('movedInPeriod: at least one transition on a local calendar day inside [from, to]', () => {
  const opts = { ...PERIOD, timeZone: TZ };
  assert.equal(movedInPeriod(row('A-10', { moves: [['2026-09-01T03:30:00.000Z', '1', '2']] }), opts), true);
  // 2026-09-01T02:00Z is still Aug 31 in Buenos Aires (UTC-3).
  assert.equal(movedInPeriod(row('A-10', { moves: [['2026-09-01T02:00:00.000Z', '1', '2']] }), opts), false);
  assert.equal(movedInPeriod(row('A-10', { moves: [['2026-09-15T02:59:00.000Z', '1', '2']] }), opts), true);
  assert.equal(movedInPeriod(row('A-10', { moves: [] }), opts), false);
});

test('layersOf: mapped components by Jira project key + component id, in layer order', () => {
  assert.deepEqual(layersOf(row('A-10', { comps: ['2', '9', '1'] }), COMPONENT_LAYERS), ['frontend', 'backend']);
  assert.deepEqual(layersOf(row('A-10', { comps: ['9'] }), COMPONENT_LAYERS), []);
  // Same component id in another Jira project is not mapped.
  assert.deepEqual(layersOf(row('B-10', { comps: ['1'] }), COMPONENT_LAYERS), []);
});

test('layers: subtasks under their primary; a primary without its own layer is a ref., not counted', () => {
  const epicRows = [
    row('A-10', { comps: ['9'], moves: [[IN('2026-09-02'), '1', '2']] }),
    row('A-11', { sub: true, parent: 'A-10', comps: ['1'], moves: [[IN('2026-09-03'), '1', '2']] }),
    row('A-12', { sub: true, parent: 'A-10', comps: ['2'], moves: [[IN('2026-09-04'), '1', '2']] }),
    row('A-13', { sub: true, parent: 'A-10', comps: ['2'], moves: [[IN('2026-08-20'), '1', '2']] }),
  ];
  const report = build({ epicRows });
  assert.deepEqual(report.layers.map((l) => l.layer), ['frontend', 'backend', null]);
  const [fe, be, none] = report.layers;
  assert.deepEqual(keysOf(fe.epics[0].primaries), [['A-10', false, ['A-11']]]);
  assert.deepEqual(keysOf(be.epics[0].primaries), [['A-10', false, ['A-12']]]);
  // The primary moved but maps to no layer: counted once, in "Sin capa".
  assert.deepEqual(keysOf(none.epics[0].primaries), [['A-10', true, []]]);
  assert.equal(fe.epics[0].epicKey, 'A-1');
  assert.equal(fe.epics[0].epicSummary, 'Epic one');
  assert.deepEqual(report.kpis, { withMovement: 3, primaries: 1, secondaries: 2, closed: 0, blocked: 0 });
  assert.deepEqual(fe.kpis, { counted: 1, closed: 0, blocked: 0 });
});

test('a primary with its own layer is counted there and a ref. in the other layers', () => {
  const epicRows = [
    row('A-10', { comps: ['3'], moves: [[IN('2026-09-02'), '1', '2']] }),
    row('A-11', { sub: true, parent: 'A-10', comps: ['1'], moves: [[IN('2026-09-03'), '1', '2']] }),
  ];
  const report = build({ epicRows });
  const byLayer = Object.fromEntries(report.layers.map((l) => [l.layer, keysOf(l.epics[0].primaries)]));
  assert.deepEqual(byLayer, { frontend: [['A-10', false, ['A-11']]], functional: [['A-10', true, []]] });
});

test('a primary without movement still heads its moved subtasks as a ref.; untouched rows are left out', () => {
  const epicRows = [
    row('A-10', { comps: ['1'], moves: [[IN('2026-08-01'), '1', '2']] }),
    row('A-11', { sub: true, parent: 'A-10', comps: ['1'], moves: [[IN('2026-09-03'), '1', '2']] }),
    row('A-20', { epic: 'A-2', comps: ['1'], moves: [] }),
  ];
  const report = build({ epicRows });
  assert.deepEqual(report.layers.map((l) => l.layer), ['frontend']);
  assert.deepEqual(keysOf(report.layers[0].epics[0].primaries), [['A-10', false, ['A-11']]]);
  assert.equal(report.layers[0].epics.length, 1);
});

test('closed: last transition into an effectively done status inside the period; blocked: configured statuses', () => {
  const epicRows = [
    // Done inside the period.
    row('A-10', { comps: ['1'], status: '4', moves: [[IN('2026-09-02'), '1', '2'], [IN('2026-09-05'), '2', '4']] }),
    // Override: QA OK counts as done.
    row('A-11', { comps: ['1'], status: '6', moves: [[IN('2026-09-06'), '2', '6']] }),
    // Moved in the period but closed after it.
    row('A-12', { comps: ['1'], status: '4', moves: [[IN('2026-09-10'), '1', '2'], [IN('2026-09-20'), '2', '4']] }),
    // Closed before the period, reopened and re-closed inside it: the LAST done transition counts.
    row('A-13', { comps: ['1'], status: '4', moves: [[IN('2026-08-10'), '2', '4'], [IN('2026-09-03'), '4', '2'], [IN('2026-09-04'), '2', '4']] }),
    row('A-14', { comps: ['1'], status: '5', moves: [[IN('2026-09-08'), '2', '5']] }),
  ];
  const report = build({ epicRows });
  const items = report.layers[0].epics[0].primaries;
  assert.deepEqual(items.map((p) => [p.key, p.item.closedInPeriod, p.item.blocked]), [
    ['A-10', true, false],
    ['A-11', true, false],
    ['A-12', false, false],
    ['A-13', true, false],
    ['A-14', false, true],
  ]);
  assert.deepEqual(report.kpis, { withMovement: 5, primaries: 5, secondaries: 0, closed: 3, blocked: 1 });
  assert.deepEqual(report.layers[0].kpis, { counted: 5, closed: 3, blocked: 1 });
  assert.equal(build({ epicRows, blockedStatusIds: [] }).kpis.blocked, 0);
});

test('item view: status names from the catalog, effective category, only the period transitions', () => {
  const epicRows = [
    row('A-10', { comps: ['1'], status: '6', moves: [[IN('2026-08-30'), '1', '2'], [IN('2026-09-06'), '2', '6']] }),
  ];
  const { item } = build({ epicRows }).layers[0].epics[0].primaries[0];
  assert.equal(item.statusName, 'QA OK');
  assert.equal(item.category, 'done');
  assert.equal(item.assigneeName, 'Ana');
  assert.deepEqual(item.periodChanges, [
    { at: IN('2026-09-06'), fromStatusId: '2', fromStatusName: 'In Progress', toStatusId: '6', toStatusName: 'QA OK' },
  ]);
});

test('scope: only the team active epics; epics follow the configuration order; epic rows are not items', () => {
  const moved = [[IN('2026-09-02'), '1', '2']];
  const epicRows = [
    row('A-20', { epic: 'A-2', comps: ['1'], moves: moved }),
    row('A-10', { epic: 'A-1', comps: ['1'], moves: moved }),
    row('A-30', { epic: 'A-3', comps: ['1'], moves: moved }),
    row('B-10', { epic: 'B-1', comps: ['1'], moves: moved }),
    row('A-1', { epic: null, level: 1, comps: ['1'], moves: moved }),
  ];
  const report = build({ epicRows });
  assert.deepEqual(report.layers[0].epics.map((e) => e.epicKey), ['A-1', 'A-2']);
  assert.equal(report.kpis.withMovement, 2);
});

test('hygiene notes: two layers, open parent with all subtasks done, open subtask under a done parent', () => {
  const moved = (day) => [[IN(day), '1', '2']];
  const epicRows = [
    row('A-10', { comps: ['1', '2'], moves: moved('2026-09-02') }),
    row('A-20', { status: '2', moves: [] }),
    row('A-21', { sub: true, parent: 'A-20', comps: ['1'], status: '4', moves: [[IN('2026-09-03'), '2', '4']] }),
    row('A-22', { sub: true, parent: 'A-20', comps: ['2'], status: '4', moves: [] }),
    row('A-30', { status: '4', moves: [] }),
    row('A-31', { sub: true, parent: 'A-30', comps: ['1'], status: '2', moves: moved('2026-09-04') }),
  ];
  const report = build({ epicRows });
  assert.deepEqual(report.hygiene, [
    { code: 'multiple_layers', key: 'A-10', layers: ['frontend', 'backend'] },
    { code: 'parent_open_all_subtasks_done', key: 'A-20', subtaskKeys: ['A-21', 'A-22'] },
    { code: 'subtask_open_under_done_parent', key: 'A-31', parentKey: 'A-30' },
  ]);
  // A two-layer item is listed in each layer but counted once in the totals.
  assert.equal(report.kpis.withMovement, 3);
  assert.deepEqual(report.layers.map((l) => [l.layer, l.kpis.counted]), [['frontend', 3], ['backend', 1]]);
});

test('outside: member work with movement outside the team epics, grouped by epic, no epic last', () => {
  const moved = [[IN('2026-09-02'), '1', '2']];
  const epicRows = [row('A-10', { comps: ['1'], moves: moved })];
  const memberRows = [
    row('A-10', { comps: ['1'], moves: moved }),
    row('A-11', { epic: 'A-1', comps: ['1'], moves: moved }),
    row('C-5', { epic: 'C-1', moves: moved }),
    row('C-6', { epic: 'C-1', sub: true, parent: 'C-9', comps: ['2'], moves: moved }),
    row('D-1', { epic: null, moves: moved }),
    row('C-7', { epic: 'C-1', moves: [] }),
    row('B-10', { epic: 'B-1', moves: moved }),
  ];
  const { outside } = build({ epicRows, memberRows });
  assert.deepEqual(outside.epics.map((e) => e.epicKey), ['B-1', 'C-1', null]);
  const c1 = outside.epics[1];
  assert.equal(c1.epicSummary, null);
  assert.deepEqual(keysOf(c1.primaries), [['C-5', true, []], ['C-9', false, ['C-6']]]);
  assert.equal(c1.primaries[1].item, null);
  assert.deepEqual(outside.kpis, { withMovement: 4, primaries: 3, secondaries: 1, closed: 0, blocked: 0 });
});

test('inputs are not mutated and the result is deterministic', () => {
  const epicRows = [row('A-10', { comps: ['1'], moves: [[IN('2026-09-02'), '1', '2']] })];
  const frozen = JSON.stringify(epicRows);
  const a = build({ epicRows });
  const b = build({ epicRows });
  assert.equal(JSON.stringify(epicRows), frozen);
  assert.deepEqual(a, b);
});

test('rows from an older payload (no statusChanges / components) do not throw and have no movement', () => {
  const legacy = (key) => {
    const r = row(key, { comps: ['1'] });
    delete r.statusChanges;
    delete r.components;
    return r;
  };
  const opts = { ...PERIOD, timeZone: TZ };
  assert.equal(movedInPeriod(legacy('A-10'), opts), false);
  assert.deepEqual(layersOf(legacy('A-10'), COMPONENT_LAYERS), []);
  const moved = row('A-11', { moves: [['2026-09-02T15:00:00.000Z', '1', '2']] });
  const report = build({ epicRows: [legacy('A-10'), moved], memberRows: [legacy('M-1')] });
  assert.equal(report.kpis.withMovement, 1);
  assert.equal(report.outside.kpis.withMovement, 0);
});
