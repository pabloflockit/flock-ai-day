import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';
import { DashboardState } from './dashboard.state';

const member = (accountId: string, displayName: string, active = true) => ({
  accountId,
  displayName,
  emailAddress: null,
  jiraActive: true,
  active,
  refreshedAt: '2026-03-01T00:00:00.000Z',
});
const epic = (key: string, active = true) => ({ key, issueTypeId: '10000', summary: key, active, linkMethodUsed: 'parent' });
const project = (id: string, teamId: string, epics: string[], measure: unknown = { kind: 'count' }) => ({
  id,
  teamId,
  name: id.toUpperCase(),
  active: true,
  workUnit: 'task',
  measure,
  epics: epics.map((k) => epic(k)),
});

const CONFIG = normalizeConfig({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
  teams: [
    { id: 't0', name: 'Inactivo', active: false, members: [] },
    { id: 't1', name: 'Alfa', active: true, members: [member('u1', 'Ana'), member('u2', 'Beto', false)] },
    { id: 't2', name: 'Beta', active: true, members: [member('u1', 'Ana')] },
  ],
  projects: [
    project('p1', 't1', ['E-1', 'E-2']),
    project('p2', 't1', ['F-1'], { kind: 'field', fieldId: 'cf1', fieldName: 'Puntos', valueType: 'number' }),
    { ...project('p3', 't1', []), active: false },
    project('p4', 't2', ['G-1']),
  ],
});

const row = (key: string, epicKey: string, assignee: string | null, extra: Record<string, unknown> = {}) => ({
  key,
  summary: key,
  issueTypeName: 'Task',
  isSubtask: false,
  hierarchyLevel: 0,
  parentKey: null,
  epicKey,
  statusId: '1',
  statusName: 'En curso',
  statusCategory: 'doing',
  statusSince: '2026-03-02T10:00:00.000Z',
  createdAt: '2026-03-01T10:00:00.000Z',
  firstDoingAt: null,
  doneAt: null,
  assigneeAccountId: assignee,
  assigneeName: assignee,
  dueDate: null,
  measures: { cf1: 3 },
  ...extra,
});

const view = (rows: unknown[], fetchedAt: string | null) => ({ rows, fetchedAt, isCurrent: true, shardsMeta: [] });

describe('DashboardState', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
  const datasets: Record<string, unknown> = {
    p1: view(
      [row('A-1', 'E-1', 'u1'), row('A-2', 'E-2', 'u1'), row('A-3', 'E-1', null), row('A-4', 'E-1', 'u9')],
      '2026-03-03T10:00:00.000Z',
    ),
    p2: view([row('B-1', 'F-1', 'u1')], '2026-03-02T10:00:00.000Z'),
  };

  async function setup(overrides: Record<string, unknown> = {}) {
    const served = { ...datasets, ...overrides };
    const get = jasmine.createSpy('get').and.callFake((path: string) => {
      if (path === '/api/config') return Promise.resolve(CONFIG);
      const id = new URL(path, 'http://x').searchParams.get('scopeId') ?? '';
      return Promise.resolve(served[id] ?? view([], null));
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), DashboardState, { provide: ProxyClient, useValue: { get } }],
    });
    await TestBed.inject(AppStore).loadConfig();
    const state = TestBed.inject(DashboardState);
    TestBed.tick();
    await flush();
    return { state, get };
  }

  const datasetCalls = (get: jasmine.Spy) => get.calls.allArgs().filter(([p]) => String(p).startsWith('/api/datasets'));

  it('defaults to the first active team and lists its active projects', async () => {
    const { state } = await setup();
    expect(state.activeTeams().map((t) => t.id)).toEqual(['t1', 't2']);
    expect(state.teamId()).toBe('t1');
    expect(state.projectId()).toBeNull();
    expect(state.epicKey()).toBeNull();
    expect(state.projects().map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(state.epics().map((e) => e.key)).toEqual(['E-1', 'E-2', 'F-1']);
  });

  it('keeps units of projects with different measurement in separate groups', async () => {
    const { state } = await setup();
    expect(state.scoped().map((u) => u.key)).toEqual(['A-1', 'A-2', 'B-1']);
    expect(state.groups().length).toBe(2);
    const [count, field] = state.groups();
    expect(count.measure).toEqual({ kind: 'count' });
    expect(count.units.map((u) => u.key)).toEqual(['A-1', 'A-2']);
    expect(field.measure.kind).toBe('field');
    expect(field.units.map((u) => u.key)).toEqual(['B-1']);
    expect(field.units[0].measureValue).toBe(3);
  });

  it('filters by project and epic in memory without refetching', async () => {
    const { state, get } = await setup();
    const before = datasetCalls(get).length;
    state.projectId.set('p1');
    expect(state.epics().map((e) => e.key)).toEqual(['E-1', 'E-2']);
    expect(state.scoped().map((u) => u.key)).toEqual(['A-1', 'A-2']);
    state.epicKey.set('E-2');
    expect(state.scoped().map((u) => u.key)).toEqual(['A-2']);
    expect(state.outside().unassigned).toEqual([]);
    TestBed.tick();
    expect(datasetCalls(get).length).toBe(before);
    expect(before).toBe(2);
  });

  it('resets the epic when its project changes and the project when the team changes', async () => {
    const { state } = await setup();
    state.projectId.set('p1');
    state.epicKey.set('E-1');
    state.projectId.set('p2');
    expect(state.epicKey()).toBeNull();
    state.teamId.set('t2');
    expect(state.projectId()).toBeNull();
    expect(state.projects().map((p) => p.id)).toEqual(['p4']);
  });

  it('counts open outside units (unassigned + others) with the same filters', async () => {
    const { state } = await setup();
    expect(state.outsideOpenCount()).toBe(2);
    state.epicKey.set('E-2');
    expect(state.outsideOpenCount()).toBe(0);
  });

  it('does not count done units as open outside work', async () => {
    const { state } = await setup({
      p1: view(
        [row('A-3', 'E-1', null, { statusCategory: 'done', doneAt: '2026-03-02T10:00:00.000Z' })],
        '2026-03-03T10:00:00.000Z',
      ),
    });
    expect(state.outside().unassigned.length).toBe(1);
    expect(state.outsideOpenCount()).toBe(0);
  });

  it('reports missing datasets and ignores them for the data date', async () => {
    const { state } = await setup({ p2: view([], null) });
    expect(state.missingDatasets().map((p) => p.id)).toEqual(['p2']);
    expect(state.dataAsOf()).toBe('2026-03-03T10:00:00.000Z');
    expect(state.notCurrent()).toBe(false);
  });

  it('takes the oldest fetchedAt as the data date and flags a not-current dataset', async () => {
    const { state } = await setup({ p2: { ...view([], '2026-03-02T10:00:00.000Z'), isCurrent: false } });
    expect(state.missingDatasets()).toEqual([]);
    expect(state.dataAsOf()).toBe('2026-03-02T10:00:00.000Z');
    expect(state.notCurrent()).toBe(true);
  });

  it('computes the metrics per group with the clock it is given', async () => {
    const { state } = await setup();
    state.now.set('2026-03-04T12:00:00.000Z');
    const [count] = state.groups();
    expect(count.workInProgress.total.count).toBe(2);
    expect(count.load.map((m) => m.accountId)).toEqual(['u1']);
    expect(count.stale.length).toBe(0);
    expect(count.throughput.weeks.length).toBe(8);
    expect(state.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
