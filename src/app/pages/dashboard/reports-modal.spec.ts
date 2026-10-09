import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { DashboardPage } from './dashboard.page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const config = {
  jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' },
  teams: [
    {
      id: 't1',
      name: 'Alfa Ñandú',
      active: true,
      members: [{ accountId: 'u1', displayName: 'Zulema Quispe', emailAddress: null, jiraActive: true, active: true, refreshedAt: '2026-03-01T00:00:00.000Z' }],
    },
  ],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      name: 'Portal',
      active: true,
      workUnit: 'task',
      measure: { kind: 'count' },
      epics: [{ key: 'E-1', issueTypeId: '10000', summary: 'Épica uno', active: true, linkMethodUsed: 'parent' }],
    },
  ],
};

const row = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  summary: `Resumen ${key}`,
  issueTypeName: 'Task',
  isSubtask: false,
  hierarchyLevel: 0,
  parentKey: null,
  epicKey: 'E-1',
  statusId: '1',
  statusName: 'En curso',
  statusCategory: 'doing',
  statusSince: '2026-03-02T10:00:00.000Z',
  createdAt: '2026-03-01T10:00:00.000Z',
  firstDoingAt: null,
  doneAt: null,
  assigneeAccountId: 'u1',
  assigneeName: 'Zulema Quispe',
  dueDate: null,
  measures: {},
  ...extra,
});

async function render(rows: unknown[]) {
  const dataset = { rows, fetchedAt: '2026-03-03T10:00:00.000Z', isCurrent: true, shardsMeta: [] };
  const get = jasmine.createSpy('get').and.callFake((path: string) =>
    Promise.resolve(path === '/api/config' ? normalizeConfig(config) : dataset),
  );
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(DashboardPage);
  for (let i = 0; i < 3; i++) {
    await flush();
    fixture.detectChanges();
  }
  const el = fixture.nativeElement as HTMLElement;
  const open = async (selector: string) => {
    el.querySelector<HTMLButtonElement>(selector)!.click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  const setDate = (label: string, value: string) => {
    const input = Array.from(el.querySelectorAll<HTMLLabelElement>('app-reports-modal label')).find((l) => l.textContent?.includes(label))!
      .querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const preview = () => el.querySelector('app-reports-modal .reports-preview')?.textContent ?? null;
  const button = (cls: string) => el.querySelector<HTMLButtonElement>(`app-reports-modal button.${cls}`)!;
  return { fixture, el, open, setDate, preview, button };
}

describe('Reports modal', () => {
  const rows = [row('A-1'), row('A-2', { statusName: 'Hecha', statusCategory: 'done', doneAt: '2026-03-02T10:00:00.000Z' })];
  afterEach(() => delete (window as { leadershipPanel?: unknown }).leadershipPanel);

  it('opens the sprint report with the default period and the dashboard scope', async () => {
    const { el, open, preview } = await render(rows);
    await open('.report-sprint');
    expect(el.querySelector('app-reports-modal h2')?.textContent).toContain('Informe de sprint');
    const [from, to] = Array.from(el.querySelectorAll<HTMLInputElement>('app-reports-modal input[type=date]')).map((i) => i.value);
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to >= from).toBeTrue();
    expect(el.querySelector('app-reports-modal .field-hint')?.textContent).toContain('Alfa Ñandú · Todos los proyectos');
    expect(preview()).toContain('# Informe de sprint — Alfa Ñandú');
  });

  it('shows an inline error and no report for an invalid period', async () => {
    const { el, open, setDate, preview } = await render(rows);
    await open('.report-sprint');
    setDate('Desde', '2099-01-02');
    setDate('Hasta', '2099-01-01');
    expect(el.querySelector('app-reports-modal [role=alert]')?.textContent).toContain('no puede ser posterior');
    expect(preview()).toBeNull();
  });

  it('never prints a member name in the client report', async () => {
    const { open, setDate, preview } = await render(rows);
    await open('.report-client');
    setDate('Desde', '2026-01-01');
    setDate('Hasta', '2099-01-01');
    expect(preview()).toContain('# Informe de avance');
    expect(preview()).toContain('A-2');
    expect(preview()).not.toContain('Zulema');
    expect(preview()).not.toContain('Quispe');
  });

  it('still renders the preview when there is no data in scope', async () => {
    const { open, preview } = await render([]);
    await open('.report-sprint');
    expect(preview()).toContain('Sin datos para el alcance seleccionado.');
  });

  it('disables copy and save outside Electron', async () => {
    const { el, open, button } = await render(rows);
    await open('.report-sprint');
    expect(button('copy').disabled).toBeTrue();
    expect(button('save').disabled).toBeTrue();
    expect(el.querySelector('app-reports-modal')?.textContent).toContain('solo están disponibles en la app de escritorio');
  });

  describe('with the bridge', () => {
    const bridge = (save: unknown = { ok: true }) => {
      const api = {
        copyText: jasmine.createSpy('copyText').and.resolveTo({ ok: true }),
        saveMarkdown: jasmine.createSpy('saveMarkdown').and.callFake(() => Promise.resolve(save)),
      };
      (window as { leadershipPanel?: unknown }).leadershipPanel = api;
      return api;
    };

    it('copies the previewed Markdown', async () => {
      const api = bridge();
      const { fixture, el, open, button, preview } = await render(rows);
      await open('.report-sprint');
      button('copy').click();
      await flush();
      fixture.detectChanges();
      expect(api.copyText).toHaveBeenCalledOnceWith(preview()!);
      expect(el.querySelector('app-reports-modal [role=status]')?.textContent).toContain('copiado');
    });

    it('saves with a slugged suggested name and the same content', async () => {
      const api = bridge();
      const { fixture, open, setDate, button, preview } = await render(rows);
      await open('.report-client');
      setDate('Desde', '2026-03-01');
      setDate('Hasta', '2026-03-14');
      button('save').click();
      await flush();
      fixture.detectChanges();
      expect(api.saveMarkdown).toHaveBeenCalledOnceWith('informe-cliente-alfa-nandu-2026-03-01_2026-03-14.md', preview()!);
    });

    it('stays silent when the save dialog is canceled', async () => {
      bridge({ ok: true, canceled: true });
      const { fixture, el, open, button } = await render(rows);
      await open('.report-sprint');
      button('save').click();
      await flush();
      fixture.detectChanges();
      expect(el.querySelector('app-reports-modal [role=alert], app-reports-modal [role=status]')).toBeNull();
    });

    it('reports a failed save', async () => {
      bridge({ ok: false, error: 'INVALID_PATH' });
      const { fixture, el, open, button } = await render(rows);
      await open('.report-sprint');
      button('save').click();
      await flush();
      fixture.detectChanges();
      expect(el.querySelector('app-reports-modal [role=alert]')?.textContent).toContain('No se pudo guardar');
    });
  });
});
