import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { SprintClosePage } from './sprint-close.page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const empty = { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] };
const NOW = '2026-09-10T15:00:00.000Z';

const row = (key: string, epicKey: string | null, extra: Record<string, unknown> = {}) => ({
  key,
  issueTypeId: '10001',
  issueTypeName: 'Story',
  hierarchyLevel: 0,
  isSubtask: false,
  summary: `Resumen ${key}`,
  parentKey: null,
  epicKey,
  statusId: '2',
  statusName: 'En curso',
  statusCategory: 'doing',
  statusSince: null,
  firstDoingAt: null,
  doneAt: null,
  resolvedAt: null,
  statusChanges: [{ at: NOW, fromStatusId: '1', toStatusId: '2' }],
  components: [],
  assigneeAccountId: 'u1',
  assigneeName: 'Ana',
  priorityName: null,
  measures: {},
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: NOW,
  dueDate: null,
  ...extra,
});
const view = (rows: unknown[]) => ({ rows, fetchedAt: '2026-09-11T10:00:00.000Z', isCurrent: true, shardsMeta: [] });

const baseConfig = (extraJira: Record<string, unknown> = {}) => ({
  jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c', ...extraJira },
  teams: [
    {
      id: 't1',
      name: 'Equipo Ñandú',
      active: true,
      members: [{ accountId: 'u1', displayName: 'Ana', emailAddress: null, jiraActive: true, active: true, refreshedAt: '2026-03-01T00:00:00.000Z' }],
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
      epics: [{ key: 'E-1', issueTypeId: '10000', summary: 'Épica', active: true, linkMethodUsed: 'parent' }],
    },
  ],
});

interface Options {
  config?: unknown;
  statusesFail?: boolean;
  datasets?: Record<string, unknown>;
  aiEnabled?: boolean;
  aiKeyStored?: boolean;
  aiAnswer?: unknown;
  aiFails?: boolean;
}

async function render({ config = baseConfig(), statusesFail = false, datasets = {}, aiEnabled = false, aiKeyStored = false, aiAnswer, aiFails = false }: Options = {}) {
  const effectiveConfig = aiEnabled ? { ...(config as object), settings: { ai: { enabled: true } } } : config;
  const post = jasmine.createSpy('post').and.callFake((path: string) => {
    if (path === '/api/reports/ai') {
      return aiFails ? Promise.reject(new Error('La IA está desactivada.')) : Promise.resolve(aiAnswer);
    }
    const scopeId = new URL(path, 'http://x').searchParams.get('scopeId') ?? '';
    return Promise.resolve(datasets[scopeId] ?? empty);
  });
  const get = jasmine.createSpy('get').and.callFake((path: string) => {
    if (path === '/api/config') return Promise.resolve(normalizeConfig(effectiveConfig));
    if (path === '/api/connection/status') return Promise.resolve({ tokenStored: true, aiKeyStored });
    if (path === '/api/jira/statuses') {
      return statusesFail
        ? Promise.reject(new Error('Jira caído'))
        : Promise.resolve([
            { id: '1', name: 'Por hacer', statusCategory: 'todo' },
            { id: '2', name: 'En curso', statusCategory: 'doing' },
          ]);
    }
    return Promise.resolve(datasets[new URL(path, 'http://x').searchParams.get('scopeId') ?? ''] ?? empty);
  });
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: { get, post } }],
  });
  const fixture = TestBed.createComponent(SprintClosePage);
  const page = fixture.componentInstance;
  page.from.set('2026-09-01');
  page.to.set('2026-09-14');
  for (let i = 0; i < 3; i++) {
    await flush();
    fixture.detectChanges();
  }
  const settle = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  };
  return { fixture, page, el: fixture.nativeElement as HTMLElement, get, post, settle };
}

const datasets = { p1: view([row('A-1', 'E-1')]), t1: view([row('M-1', 'Z-9')]) };

describe('SprintClosePage', () => {
  afterEach(() => delete (window as { leadershipPanel?: unknown }).leadershipPanel);

  it('shows an empty state without a team', async () => {
    const { el } = await render({ config: { ...baseConfig(), teams: [], projects: [] } });
    expect(el.textContent).toContain('Elegí un equipo');
    expect(el.querySelector('iframe')).toBeNull();
  });

  it('shows an inline message and no report for an invalid range', async () => {
    const { page, fixture, el } = await render({ datasets });
    page.from.set('2026-09-20');
    fixture.detectChanges();
    expect(el.querySelector('.period-error')?.textContent).toContain('no puede ser posterior');
    expect(el.querySelector('iframe')).toBeNull();
    page.from.set('');
    fixture.detectChanges();
    expect(el.querySelector('.period-error')?.textContent).toContain('Completá las dos fechas');
  });

  it('builds the report from the project datasets and the member dataset', async () => {
    const { el, get } = await render({ datasets });
    expect(get).toHaveBeenCalledWith('/api/datasets/memberIssues?scopeId=t1&since=2026-09-01');
    const kpis = Array.from(el.querySelectorAll('.kpi-value')).map((e) => e.textContent?.trim());
    expect(kpis[0]).toBe('1');
    expect(el.querySelector('.outside-count')?.textContent).toContain('1 con movimiento');
    const iframe = el.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.srcdoc).toContain('A-1');
    expect(iframe.srcdoc).toContain('M-1');
    expect(iframe.srcdoc).not.toContain('<script');
  });

  it('still renders when the statuses catalog fails', async () => {
    const { el } = await render({ datasets, statusesFail: true });
    expect(el.querySelector('.statuses-error')?.textContent).toContain('Jira caído');
    expect(el.querySelector('iframe')?.srcdoc).toContain('A-1');
  });

  it('hints that no component is mapped to a layer, and stops when one is', async () => {
    const without = await render({ datasets });
    expect(without.el.querySelector('.layer-hint')?.textContent).toContain('Todavía no mapeaste componentes a capas');
    expect(without.el.querySelector('.layer-hint a[href="/connection"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const mapped = await render({
      datasets,
      config: baseConfig({ componentLayers: [{ projectKey: 'E', componentId: '1', componentName: 'FRONTEND', layer: 'frontend' }] }),
    });
    expect(mapped.el.querySelector('.layer-hint')).toBeNull();
  });

  it('"Actualizar datos" refreshes the member rows and the team projects (delta)', async () => {
    const { page, post, settle } = await render({ datasets });
    await page.refresh();
    await settle();
    const paths = post.calls.allArgs().map(([path]) => String(path));
    expect(paths).toContain('/api/datasets/memberIssues/refresh?scopeId=t1&since=2026-09-01&mode=delta');
    expect(paths.some((path) => path.startsWith('/api/datasets/projectIssues/refresh?scopeId=p1') && path.endsWith('mode=delta'))).toBeTrue();
    expect(page.refreshing()).toBeFalse();
  });

  it('warns about rows from an older app version until they are reloaded', async () => {
    const legacy = row('A-1', 'E-1') as Record<string, unknown>;
    delete legacy['statusChanges'];
    delete legacy['components'];
    const stale = await render({ datasets: { p1: view([legacy]), t1: view([row('M-1', 'Z-9')]) } });
    expect(stale.el.textContent).toContain('versión anterior de la app');
    expect(stale.el.textContent).toContain('Actualizar datos');
    expect(stale.el.querySelector('iframe')).not.toBeNull();
    TestBed.resetTestingModule();
    const legacyMember = await render({ datasets: { p1: view([row('A-1', 'E-1')]), t1: view([legacy]) } });
    expect(legacyMember.el.textContent).toContain('versión anterior de la app');
    TestBed.resetTestingModule();
    const fresh = await render({ datasets });
    expect(fresh.el.textContent).not.toContain('versión anterior de la app');
  });

  describe('export', () => {
    const exportButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.export')!;

    it('is disabled with a tooltip without the desktop bridge', async () => {
      const { el } = await render({ datasets });
      expect(exportButton(el).disabled).toBeTrue();
      expect(exportButton(el).title).toContain('app de escritorio');
    });

    it('saves the HTML with a .html name', async () => {
      const saveHtml = jasmine.createSpy('saveHtml').and.resolveTo({ ok: true });
      (window as { leadershipPanel?: unknown }).leadershipPanel = { saveHtml };
      const { el, settle } = await render({ datasets });
      exportButton(el).click();
      await settle();
      const [name, content] = saveHtml.calls.mostRecent().args as [string, string];
      expect(name).toBe('cierre-equipo-nandu-2026-09-01-2026-09-14.html');
      expect(content).toContain('<html');
      expect(content).toContain('Cierre de sprint — Equipo Ñandú — 2026-09-01..2026-09-14');
      expect(el.textContent).toContain('Informe guardado.');
    });

    it('stays silent when the dialog is canceled and shows the message on error', async () => {
      const saveHtml = jasmine.createSpy('saveHtml').and.resolveTo({ ok: true, canceled: true });
      (window as { leadershipPanel?: unknown }).leadershipPanel = { saveHtml };
      const { el, settle } = await render({ datasets });
      exportButton(el).click();
      await settle();
      expect(el.textContent).not.toContain('Informe guardado.');
      expect(el.querySelector('[role="alert"]')).toBeNull();

      saveHtml.and.resolveTo({ ok: false, error: 'Disco lleno' });
      exportButton(el).click();
      await settle();
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('Disco lleno');
    });
  });

  describe('AI narrative', () => {
    const button = (el: HTMLElement, selector: string) => el.querySelector<HTMLButtonElement>(selector);
    const answer = (text: string) => ({ text, demo: false });
    const good = JSON.stringify({ titulares: ['Se movió 1 ítem'], lectura: 'Sprint tranquilo.' });
    const type = (el: HTMLElement, selector: string, value: string) => {
      const field = el.querySelector<HTMLTextAreaElement>(selector)!;
      field.value = value;
      field.dispatchEvent(new Event('input'));
    };

    it('shows the button only when AI is enabled AND the key is stored', async () => {
      for (const [aiEnabled, aiKeyStored, visible] of [
        [false, false, false],
        [true, false, false],
        [false, true, false],
        [true, true, true],
      ] as const) {
        TestBed.resetTestingModule();
        const { el } = await render({ datasets, aiEnabled, aiKeyStored });
        expect(!!button(el, 'button.ai-draft')).withContext(`${aiEnabled}/${aiKeyStored}`).toBe(visible);
      }
    });

    it('asks for confirmation listing what is sent, and sends nothing until confirmed', async () => {
      const { el, post, fixture, settle } = await render({ datasets, aiEnabled: true, aiKeyStored: true, aiAnswer: answer(good) });
      button(el, 'button.ai-draft')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.ai-confirm')?.textContent).toContain('No se envían personas');
      expect(el.querySelector('.ai-confirm')?.textContent).toContain('claves y títulos de ítems cerrados y bloqueados');
      expect(post.calls.allArgs().some(([p]) => p === '/api/reports/ai')).toBeFalse();
      button(el, 'button.ai-cancel')!.click();
      fixture.detectChanges();
      expect(el.querySelector('.ai-confirm')).toBeNull();
      expect(post.calls.allArgs().some(([p]) => p === '/api/reports/ai')).toBeFalse();
      button(el, 'button.ai-draft')!.click();
      fixture.detectChanges();
      button(el, 'button.ai-send')!.click();
      await settle();
      const call = post.calls.allArgs().find(([p]) => p === '/api/reports/ai')!;
      const input = (call[1] as { input: Record<string, unknown> }).input;
      expect(Object.keys(input)).toContain('kpis');
      expect(JSON.stringify(input)).not.toContain('Ana');
    });

    it('shows editable headlines and reading, includes them in the preview and the export, and discards', async () => {
      const saveHtml = jasmine.createSpy('saveHtml').and.resolveTo({ ok: true });
      (window as { leadershipPanel?: unknown }).leadershipPanel = { saveHtml };
      const { el, fixture, settle } = await render({ datasets, aiEnabled: true, aiKeyStored: true, aiAnswer: answer(good) });
      button(el, 'button.ai-draft')!.click();
      fixture.detectChanges();
      button(el, 'button.ai-send')!.click();
      await settle();
      expect(el.querySelector<HTMLTextAreaElement>('.ai-headlines')!.value).toBe('Se movió 1 ítem');
      expect(el.querySelector<HTMLTextAreaElement>('.ai-reading')!.value).toBe('Sprint tranquilo.');
      expect(el.querySelector('.ai-warning')).toBeNull();
      type(el, '.ai-reading', 'Lectura editada');
      await settle();
      expect(el.querySelector('iframe')!.srcdoc).toContain('Lectura editada');
      expect(el.querySelector('iframe')!.srcdoc).toContain('Redactado con IA y revisado por el equipo');
      button(el, 'button.export')!.click();
      await settle();
      expect(saveHtml.calls.mostRecent().args[1]).toContain('Lectura editada');
      button(el, 'button.ai-discard')!.click();
      await settle();
      expect(el.querySelector('.ai-narrative')).toBeNull();
      expect(el.querySelector('iframe')!.srcdoc).not.toContain('Lectura editada');
    });

    it('warns about numbers that are not in the report', async () => {
      const bad = JSON.stringify({ titulares: ['Se cerraron 77 ítems'], lectura: 'Nada más.' });
      const { el, fixture, settle } = await render({ datasets, aiEnabled: true, aiKeyStored: true, aiAnswer: answer(bad) });
      button(el, 'button.ai-draft')!.click();
      fixture.detectChanges();
      button(el, 'button.ai-send')!.click();
      await settle();
      expect(el.querySelector('.ai-warning')?.textContent).toContain('77');
    });

    it('shows a readable message for an unusable answer and for a failed call', async () => {
      const garbage = await render({ datasets, aiEnabled: true, aiKeyStored: true, aiAnswer: answer('no es json') });
      button(garbage.el, 'button.ai-draft')!.click();
      garbage.fixture.detectChanges();
      button(garbage.el, 'button.ai-send')!.click();
      await garbage.settle();
      expect(garbage.el.querySelector('.ai-error')?.textContent).toContain('no se pudo leer');
      expect(garbage.el.querySelector('.ai-narrative')).toBeNull();
      TestBed.resetTestingModule();
      const failing = await render({ datasets, aiEnabled: true, aiKeyStored: true, aiFails: true });
      button(failing.el, 'button.ai-draft')!.click();
      failing.fixture.detectChanges();
      button(failing.el, 'button.ai-send')!.click();
      await failing.settle();
      expect(failing.el.querySelector('.ai-error')?.textContent).toContain('desactivada');
    });
  });
});
