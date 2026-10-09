import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClientReport, buildSprintReport, closedInPeriod, defaultPeriod } from '../shared/domain/reports.mjs';
import { measurementGroups, progress } from '../shared/domain/metrics.mjs';

const TZ = 'America/Argentina/Buenos_Aires';
const NOW = '2024-03-15T15:00:00Z';
const unit = (key, o = {}) => ({
  key,
  unitType: 'task',
  projectId: 'p1',
  teamId: 't1',
  epicKey: 'E1',
  parentKey: null,
  summary: `Resumen ${key}`,
  issueTypeName: 'Task',
  statusId: '1',
  statusName: 'To do',
  statusCategory: 'todo',
  statusSince: '2024-03-14T13:00:00Z',
  createdAt: '2024-03-01T13:00:00Z',
  firstDoingAt: null,
  doneAt: null,
  assigneeAccountId: 'acc-zq-1',
  assigneeName: 'Zoe Quintana',
  dueDate: null,
  measureValue: 1,
  ...o,
});
const epic = (key, summary) => ({ key, issueTypeId: '1', summary, active: true, linkMethodUsed: 'parent' });
const project = (o = {}) => ({
  id: 'p1',
  teamId: 't1',
  name: 'Proyecto Uno',
  description: null,
  active: true,
  workUnit: 'task',
  measure: { kind: 'count' },
  epics: [epic('E1', 'Epica Alfa'), epic('E2', 'Epica Beta')],
  ...o,
});
const member = (accountId, displayName) => ({ accountId, displayName, emailAddress: null, jiraActive: true, active: true, refreshedAt: '' });

const SP = { kind: 'field', fieldId: 'cf1', fieldName: 'Story Points', valueType: 'number' };

function buildInput(over = {}) {
  const units = [
    unit('A-1', { statusCategory: 'done', statusName: 'Hecho interno', doneAt: '2024-03-12T15:00:00Z', measureValue: 5 }),
    unit('A-2', { statusCategory: 'done', statusName: 'Hecho interno', doneAt: '2024-02-01T15:00:00Z', measureValue: 3 }),
    unit('A-3', { statusCategory: 'doing', statusName: 'En revision interna', statusSince: '2024-03-14T13:00:00Z', measureValue: 8 }),
    unit('A-4', { statusCategory: 'doing', statusName: 'En revision interna', statusSince: '2024-02-20T13:00:00Z', epicKey: 'E2', measureValue: null }),
    unit('A-5', { statusCategory: 'todo', assigneeAccountId: 'acc-mm-2', assigneeName: 'Mateo Mendez', measureValue: 2 }),
  ];
  const projects = [project({ measure: SP })];
  const unassigned = [unit('U-1', { assigneeAccountId: null, assigneeName: null, summary: 'Sin dueno visible', measureValue: 1 })];
  return {
    teamName: 'Equipo Rayo',
    scopeLabel: 'Todos los proyectos',
    groups: measurementGroups(units, projects).map((g) => ({ ...g, unassignedOpen: unassigned })),
    projects,
    members: [member('acc-zq-1', 'Zoe Quintana'), member('acc-mm-2', 'Mateo Mendez')],
    staleBusinessDays: 5,
    period: { from: '2024-03-02', to: '2024-03-15' },
    now: NOW,
    timeZone: TZ,
    generatedAt: NOW,
    ...over,
  };
}

test('defaultPeriod: last 14 days inclusive on the local calendar', () => {
  assert.deepEqual(defaultPeriod({ now: NOW, timeZone: TZ }), { from: '2024-03-02', to: '2024-03-15' });
  // 01:00Z is still the previous local day in Buenos Aires.
  assert.deepEqual(defaultPeriod({ now: '2024-03-15T01:00:00Z', timeZone: TZ }), { from: '2024-03-01', to: '2024-03-14' });
});

test('closedInPeriod: inclusive bounds, local calendar, ignores open units', () => {
  const units = [
    unit('IN', { doneAt: '2024-03-10T12:00:00Z' }),
    unit('FROM', { doneAt: '2024-03-02T12:00:00Z' }),
    unit('TO', { doneAt: '2024-03-15T20:00:00Z' }),
    // 02:30Z of the 2nd is still the 1st in Buenos Aires -> before the period.
    unit('EARLY', { doneAt: '2024-03-02T02:30:00Z' }),
    // 02:30Z of the 16th is the 15th locally -> inside.
    unit('LATE', { doneAt: '2024-03-16T02:30:00Z' }),
    unit('AFTER', { doneAt: '2024-03-16T12:00:00Z' }),
    unit('OPEN', { doneAt: null }),
  ];
  const keys = closedInPeriod(units, { from: '2024-03-02', to: '2024-03-15', timeZone: TZ }).map((u) => u.key);
  assert.deepEqual(keys.sort(), ['FROM', 'IN', 'LATE', 'TO']);
});

test('sprint report: sections and figures', () => {
  const md = buildSprintReport(buildInput());
  for (const s of ['# Informe de sprint', 'Equipo Rayo', 'Todos los proyectos', '## Tareas · Story Points', 'Avance', 'Cerrado en el período', 'En curso', 'Estancadas', 'Bloqueos visibles', 'Carga por persona']) {
    assert.ok(md.includes(s), `missing: ${s}`);
  }
  assert.match(md, /A-1 — Resumen A-1 — Zoe Quintana/);
  assert.match(md, /A-4 — Resumen A-4 — En revision interna — Zoe Quintana — \d+ días hábiles/);
  assert.match(md, /U-1 — Sin dueno visible/);
  assert.match(md, /sin Story Points/);
  // alphabetical load: Mateo before Zoe
  assert.ok(md.indexOf('| Mateo Mendez') < md.indexOf('| Zoe Quintana'));
});

test('sprint report: A-2 (closed before the period) is not listed as closed', () => {
  const md = buildSprintReport(buildInput());
  const closed = md.split('### Cerrado en el período')[1].split('###')[0];
  assert.ok(closed.includes('A-1'));
  assert.ok(!closed.includes('A-2'));
});

test('client report: no person names or account ids, no stale/internal info', () => {
  const input = buildInput();
  const md = buildClientReport(input);
  for (const forbidden of ['Zoe Quintana', 'Zoe', 'Quintana', 'acc-zq-1', 'Mateo Mendez', 'acc-mm-2', 'Fuera del equipo', 'Sin asignar', 'sin asignar', 'Sin dueno visible', 'U-1', 'Hecho interno', 'En revision interna', 'Estancad', 'estancad', 'Carga por persona', 'Bloqueo']) {
    assert.ok(!md.includes(forbidden), `client report leaks: ${forbidden}`);
  }
  for (const s of ['# Informe de avance', 'Equipo Rayo', '## Tareas · Story Points', 'Avance', 'Entregables del período', 'Próximos pasos']) {
    assert.ok(md.includes(s), `missing: ${s}`);
  }
  assert.match(md, /A-1 — Resumen A-1/);
  assert.match(md, /A-3 — Resumen A-3/);
});

test('figures equal the dashboard progress in both reports', () => {
  const input = buildInput();
  const [group] = input.groups;
  const [p] = progress(group.units, input.projects);
  const total = `${p.done.measure} de ${p.total.measure} Story Points`;
  const pct = `${Math.round((p.done.measure / p.total.measure) * 100)}%`;
  const tasks = `${p.done.count} de ${p.total.count} tareas`;
  const epicE1 = p.epics.find((e) => e.epicKey === 'E1');
  const epicLine = `${epicE1.done.measure} de ${epicE1.total.measure} Story Points`;
  for (const md of [buildSprintReport(input), buildClientReport(input)]) {
    assert.ok(md.includes(total), `missing ${total}`);
    assert.ok(md.includes(pct), `missing ${pct}`);
    assert.ok(md.includes(tasks), `missing ${tasks}`);
    assert.ok(md.includes(epicLine), `missing ${epicLine}`);
    assert.ok(md.includes('1 sin Story Points'));
  }
});

test('count measure prints tasks only and no percentage when the total is zero measure', () => {
  const projects = [project()];
  const units = [unit('C-1', { statusCategory: 'done', doneAt: NOW }), unit('C-2')];
  const input = buildInput({ projects, groups: measurementGroups(units, projects) });
  const md = buildClientReport(input);
  assert.ok(md.includes('1 de 2 tareas (50%)'));
  const zero = [project({ measure: SP })];
  const zUnits = [unit('Z-1', { measureValue: 0 })];
  const zmd = buildClientReport(buildInput({ projects: zero, groups: measurementGroups(zUnits, zero) }));
  assert.ok(!zmd.includes('NaN'));
  assert.ok(!/\b0%/.test(zmd));
});

test('empty sections say so', () => {
  const projects = [project()];
  const units = [unit('C-1')];
  const groups = measurementGroups(units, projects);
  const sprint = buildSprintReport(buildInput({ projects, groups }));
  const client = buildClientReport(buildInput({ projects, groups }));
  assert.ok(sprint.includes('Sin cierres en el período'));
  assert.ok(client.includes('Sin cierres en el período'));
  assert.ok(sprint.includes('Sin tareas estancadas'));
  assert.ok(buildClientReport(buildInput({ groups: [] })).includes('Sin datos'));
});

test('markdown in summaries is escaped', () => {
  const projects = [project()];
  const units = [unit('M-1', { statusCategory: 'doing', summary: '# Fix a|b *x* [l](u) <b>', assigneeName: 'A|B' })];
  const input = buildInput({ projects, groups: measurementGroups(units, projects) });
  for (const md of [buildSprintReport(input), buildClientReport(input)]) {
    assert.ok(md.includes('\\# Fix a\\|b \\*x\\* \\[l\\](u) \\<b\\>'), md);
    assert.ok(!/(^|[^\\])\|b /.test(md.split('\n').filter((l) => l.includes('M-1')).join('\n')));
  }
});

test('pure: does not mutate the input', () => {
  const input = buildInput();
  const copy = structuredClone(input);
  buildSprintReport(input);
  buildClientReport(input);
  assert.deepEqual(input, copy);
});
