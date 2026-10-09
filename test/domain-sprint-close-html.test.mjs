import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSprintClose } from '../shared/domain/sprint-close.mjs';
import { renderSprintCloseHtml } from '../shared/domain/sprint-close-html.mjs';

const TZ = 'America/Argentina/Buenos_Aires';
const PERIOD = { from: '2026-09-01', to: '2026-09-14' };
const STATUSES = [
  { id: '1', name: 'To Do', statusCategory: 'todo' },
  { id: '2', name: 'In Progress', statusCategory: 'doing' },
  { id: '4', name: 'Done', statusCategory: 'done' },
  { id: '5', name: 'Blocked', statusCategory: 'doing' },
];
const CATEGORY = Object.fromEntries(STATUSES.map((s) => [s.id, s.statusCategory]));
const NAME = Object.fromEntries(STATUSES.map((s) => [s.id, s.name]));
const COMPONENT_LAYERS = [
  { projectKey: 'A', componentId: '1', componentName: 'FRONTEND', layer: 'frontend' },
  { projectKey: 'A', componentId: '2', componentName: 'BACKEND', layer: 'backend' },
  { projectKey: 'A', componentId: '3', componentName: 'QA', layer: 'functional' },
];
const CONFIG = {
  jira: { statusCategoryOverrides: {}, componentLayers: COMPONENT_LAYERS },
  teams: [{ id: 't1', name: 'Team', active: true, members: [] }],
  projects: [
    { id: 'p1', teamId: 't1', active: true, epics: [{ key: 'A-1', summary: 'Epic one', active: true }] },
  ],
};
const IN = (day) => `${day}T15:00:00.000Z`;

function row(key, o = {}) {
  const status = o.status ?? '2';
  return {
    key,
    issueTypeId: o.sub ? '10004' : '10001',
    issueTypeName: o.sub ? 'Sub-task' : 'Story',
    hierarchyLevel: o.sub ? -1 : 0,
    isSubtask: Boolean(o.sub),
    summary: o.summary ?? `Summary ${key}`,
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
    assigneeAccountId: 'acc-1',
    assigneeName: o.who ?? 'Ana',
    priorityName: null,
    measures: {},
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
    dueDate: null,
  };
}

function build({ epicRows = [], memberRows = [] } = {}) {
  return buildSprintClose({
    teamId: 't1',
    config: CONFIG,
    period: PERIOD,
    timeZone: TZ,
    statuses: STATUSES,
    blockedStatusIds: ['5'],
    epicRows,
    memberRows,
  });
}

const OPTIONS = { title: 'Cierre de sprint', teamName: 'Equipo Uno', generatedAt: '2026-09-15T12:30:00.000Z', timeZone: TZ };
const render = (report, extra = {}) => renderSprintCloseHtml(report, { ...OPTIONS, ...extra });
const moved = (day) => [[IN(day), '1', '2']];

function richReport() {
  const epicRows = [
    row('A-10', { comps: ['3'], moves: moved('2026-09-02') }),
    row('A-11', { sub: true, parent: 'A-10', comps: ['1'], status: '4', moves: [[IN('2026-09-03'), '2', '4']] }),
    row('A-12', { sub: true, parent: 'A-10', comps: ['2'], status: '5', moves: [[IN('2026-09-04'), '2', '5']] }),
    row('A-20', { comps: ['1', '2'], moves: moved('2026-09-05') }),
    row('A-30', { comps: ['9'], moves: moved('2026-09-06') }),
  ];
  const memberRows = [row('C-5', { epic: 'C-1', moves: moved('2026-09-02') })];
  return build({ epicRows, memberRows });
}

test('document shape: doctype, inline style, print media, no script, no remote URLs', () => {
  const html = render(richReport());
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<style>') && html.includes('@media print') && html.includes('--brand'));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/https?:/i.test(html));
  assert.ok(!/<link|<img|src=/i.test(html));
  assert.ok(html.includes('Cierre de sprint') && html.includes('Equipo Uno'));
  assert.ok(html.includes('del 1/9/2026 al 14/9/2026'));
});

test('KPI cards and generated-at come from the model', () => {
  const html = render(richReport());
  for (const label of ['Ítems con movimiento', 'Primarias', 'Secundarias', 'Cerrados', 'Bloqueados']) {
    assert.ok(html.includes(label), label);
  }
  assert.ok(html.includes('Generado el 15/9/2026'));
});

test('layers render in model order with Spanish labels', () => {
  const html = render(richReport());
  const at = ['Frontend', 'Backend', 'Funcional', 'Sin capa'].map((l) => html.indexOf(`<h2>${l}</h2>`));
  assert.ok(at.every((i) => i >= 0), String(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

test('epic groups, primary rows, indented subtasks, chips and transitions', () => {
  const html = render(richReport());
  assert.ok(html.includes('Epic one'));
  assert.ok(html.includes('Summary A-10') && html.includes('Summary A-11'));
  assert.ok(html.includes('class="row sub"'));
  assert.ok(html.includes('chip chip-done') && html.includes('chip chip-doing'));
  assert.ok(html.includes('chip-blocked'));
  assert.ok(html.includes('cerrado'));
  assert.ok(html.includes('In Progress → Done'));
  assert.ok(html.includes('Ana'));
});

test('a not counted primary is dimmed with a ref. badge; an item null primary shows key + ref.', () => {
  const epicRows = [
    row('A-10', { comps: ['3'], moves: [] }),
    row('A-11', { sub: true, parent: 'A-10', comps: ['1'], moves: moved('2026-09-03') }),
  ];
  const memberRows = [row('C-6', { epic: 'C-1', sub: true, parent: 'C-9', moves: moved('2026-09-03') })];
  const html = render(build({ epicRows, memberRows }));
  assert.ok(html.includes('class="primary dim"'));
  assert.ok(html.includes('class="ref"'));
  const orphan = html.slice(html.indexOf('C-9'));
  assert.ok(orphan.includes('ref.'));
  assert.ok(!html.includes('Summary C-9'));
});

test('outside section only when there are outside epics', () => {
  assert.ok(render(richReport()).includes('Fuera de las épicas del equipo'));
  const only = build({ epicRows: [row('A-10', { comps: ['1'], moves: moved('2026-09-02') })] });
  assert.ok(!render(only).includes('Fuera de las épicas del equipo'));
});

test('hygiene section: Spanish sentence per code, absent without notes', () => {
  const epicRows = [
    row('A-10', { comps: ['1', '2'], moves: moved('2026-09-02') }),
    row('A-20', { moves: [] }),
    row('A-21', { sub: true, parent: 'A-20', comps: ['1'], status: '4', moves: [[IN('2026-09-03'), '2', '4']] }),
    row('A-30', { status: '4', moves: [] }),
    row('A-31', { sub: true, parent: 'A-30', comps: ['1'], status: '2', moves: moved('2026-09-04') }),
  ];
  const html = render(build({ epicRows }));
  assert.ok(html.includes('Notas de higiene de Jira'));
  assert.ok(html.includes('figura en más de una capa (Frontend, Backend)'));
  assert.ok(html.includes('sigue abierta con todas sus subtareas cerradas'));
  assert.ok(html.includes('sigue abierta bajo'));
  assert.ok(html.includes('que ya está cerrada'));
  const clean = build({ epicRows: [row('A-10', { comps: ['1'], moves: moved('2026-09-02') })] });
  assert.ok(!render(clean).includes('Notas de higiene de Jira'));
});

test('everything from Jira is escaped', () => {
  const evil = '<img src=x onerror=alert(1)> & "q" \'s\'';
  const epicRows = [row('A-10', { comps: ['1'], summary: evil, who: '<b>Eve</b>', moves: moved('2026-09-02') })];
  const html = render(build({ epicRows }), { title: '<script>t</script>', teamName: '<i>team</i>' });
  assert.ok(!html.includes('<img'));
  assert.ok(!/<script/i.test(html) && !html.includes('<b>Eve') && !html.includes('<i>team'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s&#39;'));
  assert.ok(html.includes('&lt;b&gt;Eve&lt;/b&gt;'));
});

test('keys link to Jira only with an https base', () => {
  const report = build({ epicRows: [row('A-10', { comps: ['1'], moves: moved('2026-09-02') })] });
  const linked = render(report, { jiraBaseUrl: 'https://acme.atlassian.net/' });
  assert.ok(linked.includes('<a href="https://acme.atlassian.net/browse/A-10" rel="noopener noreferrer"'));
  const bad = ['http://acme.atlassian.net', 'ja' + 'vascript:alert(1)', 'not a url', '', null, undefined];
  for (const base of bad) {
    const html = render(report, { jiraBaseUrl: base });
    assert.ok(!html.includes('<a '), String(base));
    assert.ok(!/https?:/i.test(html), String(base));
  }
});

test('deterministic: same input, same string', () => {
  const report = richReport();
  assert.equal(render(report), render(report));
  assert.equal(render(richReport()), render(report));
});

test('empty report: header, zero KPIs and the no-movement message', () => {
  const html = render(build());
  assert.ok(html.includes('No hubo movimiento de estados en el período.'));
  assert.ok(html.includes('Ítems con movimiento'));
  assert.ok(!html.includes('<h2>Frontend</h2>'));
});


test('narrative block: Titulares + Lectura after the KPIs, escaped, labelled as AI', () => {
  const narrative = { headlines: ['Se cerraron 2 <b>ítems</b>'], reading: 'Lectura "x" & más\nSegunda línea' };
  const html = render(richReport(), { narrative });
  assert.ok(html.includes('<h2>Titulares</h2>') && html.includes('<h2>Lectura del sprint</h2>'));
  assert.ok(html.includes('Se cerraron 2 &lt;b&gt;ítems&lt;/b&gt;'));
  assert.ok(html.includes('Lectura &quot;x&quot; &amp; más'));
  assert.ok(!html.includes('<b>ítems'));
  assert.ok(html.includes('Redactado con IA y revisado por el equipo'));
  assert.ok(html.indexOf('class="kpis"') < html.indexOf('<section class="narrative">'));
  assert.ok(html.indexOf('<section class="narrative">') < html.indexOf('<section class="layer">'));
});

test('no narrative (absent, null, empty): no block at all', () => {
  for (const narrative of [undefined, null, { headlines: [], reading: '  ' }]) {
    const html = render(richReport(), { narrative });
    assert.ok(!html.includes('<section class="narrative">'));
    assert.ok(!html.includes('Redactado con IA'));
  }
});
