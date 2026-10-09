import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { DashboardPage } from './dashboard.page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (fixture: { detectChanges: () => void }) => {
  for (let i = 0; i < 3; i++) {
    await flush();
    fixture.detectChanges();
  }
};

const member = (accountId: string, displayName: string, active = true) => ({
  accountId,
  displayName,
  emailAddress: null,
  jiraActive: true,
  active,
  refreshedAt: '2026-03-01T00:00:00.000Z',
});
const epic = (key: string) => ({ key, issueTypeId: '10000', summary: `Épica ${key}`, active: true, linkMethodUsed: 'parent' });

const seed = () => ({
  jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' },
  teams: [{ id: 't1', name: 'Alfa', active: true, members: [member('u1', 'Ana'), member('u3', 'Carlos Inactivo', false)] }],
  projects: [
    { id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [epic('E-1')] },
    {
      id: 'p2',
      teamId: 't1',
      name: 'Backoffice',
      active: true,
      workUnit: 'task',
      measure: { kind: 'field', fieldId: 'cf2', fieldName: 'Puntos', valueType: 'number' },
      epics: [epic('F-1')],
    },
  ],
});

const row = (key: string, epicKey: string, assignee: [string, string] | null, extra: Record<string, unknown> = {}) => ({
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
  assigneeAccountId: assignee?.[0] ?? null,
  assigneeName: assignee?.[1] ?? null,
  dueDate: null,
  measures: {},
  ...extra,
});
const view = (rows: unknown[]) => ({ rows, fetchedAt: '2026-03-03T10:00:00.000Z', isCurrent: true, shardsMeta: [] });
const datasets: Record<string, unknown> = {
  p1: view([
    row('A-1', 'E-1', ['u1', 'Ana']),
    row('A-2', 'E-1', null),
    row('A-3', 'E-1', ['u9', 'Beto Gómez']),
    row('A-4', 'E-1', ['u9', 'Beto Gómez']),
    row('A-5', 'E-1', ['u3', 'Carlos Inactivo']),
    row('A-6', 'E-1', ['u9', 'Beto Gómez'], { statusCategory: 'done', statusName: 'Hecha', doneAt: '2026-03-02T10:00:00.000Z' }),
  ]),
  p2: view([row('B-1', 'F-1', ['u1', 'Ana'], { measures: { cf2: 3 } }), row('B-2', 'F-1', null, { measures: { cf2: 5 } })]),
};

async function render(data: Record<string, unknown> = datasets) {
  let stored = normalizeConfig(seed());
  const get = jasmine.createSpy('get').and.callFake((path: string) => {
    if (path === '/api/config') return Promise.resolve(stored);
    if (path === '/api/connection/status') return Promise.resolve({ tokenStored: true, aiKeyStored: false });
    if (path.startsWith('/api/jira/users')) {
      return Promise.resolve([{ accountId: 'u9', displayName: 'Beto Gómez', emailAddress: 'beto@a.com', active: true }]);
    }
    return Promise.resolve(data[new URL(path, 'http://x').searchParams.get('scopeId') ?? ''] ?? null);
  });
  const put = jasmine.createSpy('put').and.callFake((_path: string, body: unknown) => {
    stored = normalizeConfig(body);
    return Promise.resolve({ config: stored, movedKeys: [] });
  });
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: { get, put } }],
  });
  const fixture = TestBed.createComponent(DashboardPage);
  await settle(fixture);
  const el = fixture.nativeElement as HTMLElement;
  const button = (text: string, root: ParentNode = el) =>
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement;
  return { fixture, el, get, put, button, stored: () => stored };
}

describe('Dashboard "Fuera del equipo" view', () => {
  it('keeps work outside the team out of the main view and shows it only in the outside view', async () => {
    const { fixture, el, button } = await render();
    const mainKeys = fixture.componentInstance.state.groups().flatMap((g) => g.units.map((u) => u.key));
    expect(mainKeys).toEqual(jasmine.arrayContaining(['A-1', 'B-1']));
    for (const key of ['A-2', 'A-3', 'A-5', 'B-2']) expect(mainKeys).not.toContain(key);
    expect(el.querySelector('app-dashboard-outside')).toBeNull();

    button('Fuera del equipo').click();
    await settle(fixture);
    const outsideKeys = [...fixture.componentInstance.state.outside().unassigned, ...fixture.componentInstance.state.outside().others].map((u) => u.key);
    expect(outsideKeys).toEqual(jasmine.arrayContaining(['A-2', 'A-3', 'A-5', 'B-2']));
    expect(el.querySelector('app-dashboard-outside')).not.toBeNull();
    expect(el.querySelector('app-dashboard-group')).toBeNull();
  });

  it('switches view without refetching and keeps the selection', async () => {
    const { fixture, el, get, button } = await render();
    fixture.componentInstance.state.projectId.set('p1');
    fixture.componentInstance.state.epicKey.set('E-1');
    await settle(fixture);
    const calls = get.calls.count();
    expect(button('Fuera del equipo (')?.textContent).toContain('Fuera del equipo (4)');
    button('Fuera del equipo (').click();
    await settle(fixture);
    expect(fixture.componentInstance.state.projectId()).toBe('p1');
    expect(fixture.componentInstance.state.epicKey()).toBe('E-1');
    expect(el.querySelectorAll('app-dashboard-outside section').length).toBe(1);
    el.querySelector<HTMLButtonElement>('.tabs .tab')!.click();
    await settle(fixture);
    expect(el.querySelector('app-dashboard-group')).not.toBeNull();
    expect(get.calls.count()).toBe(calls);
  });

  it('opens the outside view from the header counter', async () => {
    const { fixture, el } = await render();
    const counter = el.querySelector<HTMLButtonElement>('.outside-counter')!;
    expect(counter.textContent).toContain('5 unidades fuera del equipo');
    counter.click();
    await settle(fixture);
    expect(el.querySelector('app-dashboard-outside')).not.toBeNull();
  });

  it('renders F1 and F2 per measurement group and opens their drill-downs', async () => {
    const { fixture, el, button } = await render();
    button('Fuera del equipo (').click();
    await settle(fixture);
    const sections = Array.from(el.querySelectorAll<HTMLElement>('app-dashboard-outside section'));
    expect(sections.map((s) => s.querySelector('h2')?.textContent?.trim())).toEqual(['Tareas · Cantidad', 'Tareas · Puntos']);
    const [count, points] = sections;

    const f1 = count.querySelector<HTMLButtonElement>('.f1 .num-link')!;
    expect(f1.textContent?.trim()).toBe('1 tarea');
    f1.click();
    await settle(fixture);
    expect(Array.from(el.querySelectorAll('app-unit-list-modal tbody td.text-mono')).map((c) => c.textContent?.trim())).toEqual(['A-2']);
    el.querySelector<HTMLButtonElement>('app-unit-list-modal .modal-foot button')!.click();
    await settle(fixture);

    const people = Array.from(count.querySelectorAll<HTMLElement>('.f2 tbody tr'));
    expect(people.map((r) => r.querySelector('td')?.textContent?.trim())).toEqual(['Beto Gómez', 'Carlos Inactivo']);
    people[0].querySelector<HTMLButtonElement>('.num-link')!.click();
    await settle(fixture);
    expect(Array.from(el.querySelectorAll('app-unit-list-modal tbody td.text-mono')).map((c) => c.textContent?.trim())).toEqual(['A-3', 'A-4']);
    el.querySelector<HTMLButtonElement>('app-unit-list-modal .modal-foot button')!.click();
    await settle(fixture);

    expect(points.querySelector('.f1 .num-link')?.textContent?.trim()).toBe('5 (1 tarea)');
    expect(points.querySelector('.f2')?.textContent).toContain('No hay unidades asignadas a otras personas');
  });

  it('says all the work is assigned to members when nothing open is outside the team', async () => {
    const { fixture, el, button } = await render({
      p1: view([row('A-1', 'E-1', ['u1', 'Ana'])]),
      p2: view([row('B-1', 'F-1', ['u1', 'Ana'], { measures: { cf2: 3 } })]),
    });
    expect(el.querySelector('.outside-counter')?.textContent).toContain('0 unidades fuera del equipo');
    button('Fuera del equipo (').click();
    await settle(fixture);
    expect(el.textContent).toContain(
      'Todo el trabajo de las épicas del equipo está asignado a integrantes',
    );
  });

  it('"Agregar al equipo" opens the member search preloaded and adds through the config op for the selected team', async () => {
    const { fixture, el, get, put, button, stored } = await render();
    button('Fuera del equipo (').click();
    await settle(fixture);
    button('Agregar al equipo', el.querySelector('.f2 tbody tr')!).click();
    await settle(fixture);
    const modal = el.querySelector('app-add-member-modal')!;
    expect(modal.querySelector<HTMLInputElement>('#member-search')!.value).toBe('Beto Gómez');
    await new Promise((r) => setTimeout(r, 50));
    await settle(fixture);
    expect(get).toHaveBeenCalledWith('/api/jira/users?query=Beto%20G%C3%B3mez');
    button('Agregar', modal.querySelector('.hits')!).click();
    await settle(fixture);
    expect(put).toHaveBeenCalled();
    const added = stored().teams[0].members.find((m) => m.accountId === 'u9')!;
    expect(added.displayName).toBe('Beto Gómez');
    expect(added.emailAddress).toBe('beto@a.com');
    expect(el.querySelector('app-add-member-modal')).toBeNull();
    // state is derived from config: the person's units are now in the team scope
    expect(fixture.componentInstance.state.scoped().map((u) => u.key)).toEqual(jasmine.arrayContaining(['A-3', 'A-4']));
  });

  it('offers reactivation, not adding, for an inactive member of the team', async () => {
    const { fixture, el, put, button, stored } = await render();
    button('Fuera del equipo (').click();
    await settle(fixture);
    const carlos = Array.from(el.querySelectorAll<HTMLElement>('.f2 tbody tr')).find((r) => r.textContent?.includes('Carlos'))!;
    expect(carlos.textContent).toContain('Inactivo en el equipo');
    expect(button('Agregar al equipo', carlos)).toBeUndefined();
    button('Reactivar', carlos).click();
    await settle(fixture);
    expect(put).toHaveBeenCalled();
    expect(stored().teams[0].members.find((m) => m.accountId === 'u3')!.active).toBeTrue();
  });
});
