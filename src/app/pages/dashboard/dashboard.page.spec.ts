import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { DashboardPage } from './dashboard.page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const empty = { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] };

async function render(config: unknown, datasets: Record<string, unknown> = {}) {
  const get = jasmine.createSpy('get').and.callFake((path: string) => {
    if (path === '/api/config') return Promise.resolve(normalizeConfig(config));
    return Promise.resolve(datasets[new URL(path, 'http://x').searchParams.get('scopeId') ?? ''] ?? empty);
  });
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(DashboardPage);
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('DashboardPage', () => {
  it('shows an empty state when there is no active team', async () => {
    const { el } = await render({ jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' }, teams: [], projects: [] });
    expect(el.textContent).toContain('Todavía no hay equipos activos');
  });

  it('asks to sync when a project of the team has no data yet', async () => {
    const { el } = await render({
      jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' },
      teams: [{ id: 't1', name: 'Alfa', active: true, members: [] }],
      projects: [{ id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] }],
    });
    expect(el.textContent).toContain('Faltan datos: sincronizá desde');
    expect(el.querySelector('a[href="/sync"]')).not.toBeNull();
  });

  describe('with data', () => {
    const epic = (key: string) => ({ key, issueTypeId: '10000', summary: `Épica ${key}`, active: true, linkMethodUsed: 'parent' });
    const config = {
      jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' },
      teams: [
        {
          id: 't1',
          name: 'Alfa',
          active: true,
          members: [{ accountId: 'u1', displayName: 'Ana', emailAddress: null, jiraActive: true, active: true, refreshedAt: '2026-03-01T00:00:00.000Z' }],
        },
      ],
      projects: [
        { id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E-1')] },
        {
          id: 'p2',
          teamId: 't1',
          name: 'Backoffice',
          active: true,
          workUnit: 'subtask',
          measure: { kind: 'field', fieldId: 'cf2', fieldName: 'Estimación', valueType: 'time_seconds' },
          epics: [epic('F-1')],
        },
      ],
    };
    const row = (key: string, epicKey: string, extra: Record<string, unknown> = {}) => ({
      key,
      summary: `Resumen ${key}`,
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
      assigneeAccountId: 'u1',
      assigneeName: 'Ana',
      dueDate: null,
      measures: {},
      ...extra,
    });
    const view = (rows: unknown[]) => ({ rows, fetchedAt: '2026-03-03T10:00:00.000Z', isCurrent: true, shardsMeta: [] });
    const datasets = {
      p1: view([
        row('A-1', 'E-1'),
        row('A-2', 'E-1', { statusName: 'Hecha', statusCategory: 'done', doneAt: '2026-03-02T10:00:00.000Z' }),
      ]),
      p2: view([
        row('B-1', 'F-1'),
        row('B-2', 'F-1'),
        row('B-3', 'F-1', { isSubtask: true, hierarchyLevel: 1, parentKey: 'B-2', measures: { cf2: 7200 } }),
        row('B-4', 'F-1', { isSubtask: true, hierarchyLevel: 1, parentKey: 'B-2', measures: { cf2: null } }),
      ]),
    };

    it('titles one section per group by unit and measure', async () => {
      const { el } = await render(config, datasets);
      const titles = Array.from(el.querySelectorAll('app-dashboard-group h2')).map((h) => h.textContent?.trim());
      expect(titles).toEqual(['Tareas · Cantidad', 'Subtareas · Estimación (h)']);
      expect(el.querySelector('.outside')?.textContent).toContain('0 unidades fuera del equipo');
    });

    it('reports missing measure data, tasks without subtasks and the lack of done data', async () => {
      const { el } = await render(config, datasets);
      const [, subtasks] = Array.from(el.querySelectorAll('app-dashboard-group'));
      expect(subtasks.textContent).toContain('1 subtarea sin Estimación');
      expect(subtasks.textContent).toContain('1 tarea no tiene subtareas y no está incluida en la medición por subtareas');
      expect(subtasks.textContent).toContain('Todavía no hay cierres registrados');
      const [tasks] = Array.from(el.querySelectorAll('app-dashboard-group'));
      expect(tasks.textContent).not.toContain('Todavía no hay cierres registrados');
      expect(tasks.textContent).not.toContain('no tiene subtareas');
    });

    it('opens a drill-down with the units behind a number', async () => {
      const { fixture, el } = await render(config, datasets);
      const kpi = el.querySelector<HTMLButtonElement>('app-dashboard-group .stat-number .num-link')!;
      kpi.click();
      fixture.detectChanges();
      const modal = el.querySelector('app-unit-list-modal')!;
      expect(modal.querySelector('h2')?.textContent).toContain('En curso · Tareas · Cantidad (1)');
      expect(Array.from(modal.querySelectorAll('tbody td.text-mono')).map((c) => c.textContent?.trim())).toEqual(['A-1']);
      modal.querySelector<HTMLButtonElement>('.modal-foot button')!.click();
      fixture.detectChanges();
      expect(el.querySelector('app-unit-list-modal')).toBeNull();
    });

    it('lists the tasks without subtasks from their notice', async () => {
      const { fixture, el } = await render(config, datasets);
      const notice = el.querySelector<HTMLButtonElement>('.notice .num-link')!;
      notice.click();
      fixture.detectChanges();
      const keys = Array.from(el.querySelectorAll('app-unit-list-modal tbody td.text-mono')).map((c) => c.textContent?.trim());
      expect(keys).toEqual(['B-1']);
    });

    it('says so when the filters leave no units', async () => {
      const { fixture, el } = await render(config, datasets);
      fixture.componentInstance.state.epicKey.set('E-1');
      fixture.componentInstance.state.projectId.set('p2');
      fixture.componentInstance.state.epicKey.set('F-1');
      fixture.detectChanges();
      expect(el.querySelectorAll('app-dashboard-group').length).toBe(1);
    });
  });
});
