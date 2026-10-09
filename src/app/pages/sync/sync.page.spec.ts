import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { SyncPage } from './sync.page';

const IDLE = {
  runId: null,
  state: 'idle',
  mode: null,
  startedAt: null,
  finishedAt: null,
  projects: { total: 0, done: 0, failed: 0 },
  members: { total: 0, done: 0, failed: 0 },
  failedEpics: [],
  error: null,
};
const running = (done = 1) => ({
  ...IDLE,
  runId: 'r1',
  state: 'running',
  mode: 'delta',
  startedAt: '2026-03-02T15:00:00.000Z',
  projects: { total: 4, done, failed: 0 },
  members: { total: 10, done: 3, failed: 1 },
});
const finished = () => ({
  ...running(4),
  state: 'done',
  finishedAt: '2026-03-02T15:05:00.000Z',
  failedEpics: [{ projectId: 'p1', key: 'PRT-2', errorCode: 'FORBIDDEN' }],
});

const META_OK = {
  fetchedAt: '2026-03-02T15:30:00.000Z',
  isCurrent: true,
  shardsMeta: [
    { key: 'PRT-1', status: 'ok', lastOkAt: '2026-03-02T15:30:00.000Z' },
    { key: 'PRT-2', status: 'failed', lastOkAt: null, errorCode: 'FORBIDDEN' },
  ],
};

const seed = () => ({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
  teams: [
    { id: 't1', name: 'Alfa', active: true, members: [] },
    { id: 't2', name: 'Beta', active: false, members: [] },
  ],
  projects: [
    { id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] },
    { id: 'p2', teamId: 't1', name: 'Backoffice', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] },
    { id: 'p3', teamId: 't1', name: 'Viejo', active: false, workUnit: 'task', measure: { kind: 'count' }, epics: [] },
    { id: 'p4', teamId: 't2', name: 'Otro', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] },
  ],
});

describe('SyncPage', () => {
  /** Promises only: the fake clock is installed for the whole test, so no `setTimeout` here. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  beforeEach(() => jasmine.clock().install());
  afterEach(() => jasmine.clock().uninstall());

  interface Options {
    statuses?: unknown[];
    tokenStored?: boolean;
    confirm?: boolean;
    meta?: (projectId: string) => Promise<unknown>;
    post?: (body: { mode: string }) => Promise<unknown>;
  }

  function setup(options: Options = {}) {
    const queue = [...(options.statuses ?? [IDLE])];
    const statusGet = jasmine
      .createSpy('status')
      .and.callFake(() => Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]));
    const metaGet = jasmine
      .createSpy('meta')
      .and.callFake((projectId: string) => (options.meta ?? (() => Promise.resolve(META_OK)))(projectId));
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(normalizeConfig(seed()));
        if (path === '/api/connection/status') {
          return Promise.resolve({ tokenStored: options.tokenStored ?? true, aiKeyStored: false });
        }
        if (path === '/api/sync/status') return statusGet();
        if (path.startsWith('/api/datasets/projectIssues/meta?scopeId=')) {
          return metaGet(decodeURIComponent(path.split('scopeId=')[1]));
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      post: jasmine.createSpy('post').and.callFake((path: string, body: { mode: string }) => {
        if (path === '/api/sync') return (options.post ?? (() => Promise.resolve(running(0))))(body);
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
    };
    const ask = jasmine.createSpy('ask').and.callFake(() => Promise.resolve(options.confirm ?? true));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ProxyClient, useValue: proxy },
        { provide: ConfirmService, useValue: { ask } },
      ],
    });
    const fixture = TestBed.createComponent(SyncPage);
    const el = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await settle();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
    };
    const tick = async (ms = 1000) => {
      jasmine.clock().tick(ms);
      await render();
    };
    const button = (text: string) =>
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
    const rows = () => Array.from(el.querySelectorAll('tbody tr')) as HTMLElement[];
    return { fixture, el, proxy, statusGet, metaGet, ask, render, tick, button, rows };
  }

  it('lists the active projects of active teams with data date, state chip and failed epics', async () => {
    const { el, render, rows, metaGet } = setup();
    await render();
    expect(el.querySelector('h1')?.textContent).toContain('Sincronización');
    expect(rows().length).toBe(2);
    expect(metaGet.calls.allArgs().flat().sort()).toEqual(['p1', 'p2']);
    expect(rows()[0].textContent).toContain('Alfa');
    expect(rows()[0].textContent).toContain('Portal');
    expect(rows()[0].textContent).toContain('/26');
    expect(rows()[0].querySelector('.state-done')?.textContent?.trim()).toBe('Al día');
    expect(rows()[0].textContent).toContain('PRT-2: Tu usuario no tiene permiso');
    expect(rows()[0].textContent).toContain('Tu usuario no tiene permiso para ver este recurso en Jira.');
    expect(rows()[0].textContent).not.toContain('FORBIDDEN');
  });

  it('shows Desactualizado and "Sin datos" for a project never synced', async () => {
    const { render, rows } = setup({
      meta: () => Promise.resolve({ fetchedAt: null, isCurrent: false, shardsMeta: [] }),
    });
    await render();
    expect(rows()[0].textContent).toContain('Sin datos');
    expect(rows()[0].querySelector('.status-chip')?.textContent?.trim()).toBe('Desactualizado');
  });

  it('a failed meta load only affects its own row', async () => {
    const { render, rows } = setup({
      meta: (id) => (id === 'p2' ? Promise.reject(new ProxyError('NOT_FOUND', 'x')) : Promise.resolve(META_OK)),
    });
    await render();
    expect(rows()[0].textContent).toContain('Al día');
    expect(rows()[1].textContent).toContain('Sin datos de sincronización');
    expect(rows()[1].querySelector('.status-chip')).toBeNull();
  });

  it('"Sincronizar ahora" starts a delta run', async () => {
    const { render, button, proxy } = setup();
    await render();
    button('Sincronizar ahora').click();
    await render();
    expect(proxy.post).toHaveBeenCalledOnceWith('/api/sync', { mode: 'delta' });
  });

  it('"Carga completa" asks first and only then starts a full run', async () => {
    const declined = setup({ confirm: false });
    await declined.render();
    declined.button('Carga completa').click();
    await declined.render();
    expect(declined.ask).toHaveBeenCalledTimes(1);
    expect(declined.proxy.post).not.toHaveBeenCalled();
    TestBed.resetTestingModule();

    const accepted = setup({ confirm: true });
    await accepted.render();
    accepted.button('Carga completa').click();
    await accepted.render();
    expect(accepted.proxy.post).toHaveBeenCalledOnceWith('/api/sync', { mode: 'full' });
  });

  it('shows the Spanish message when the run cannot start', async () => {
    const { el, render, button } = setup({ post: () => Promise.reject(new ProxyError('JIRA_NOT_CONFIGURED', 'raw')) });
    await render();
    button('Sincronizar ahora').click();
    await render();
    expect(el.textContent).toContain('Todavía no hay una URL de Jira configurada.');
    expect(el.textContent).not.toContain('JIRA_NOT_CONFIGURED');
  });

  it('disables both buttons and links to Conexión when Jira is not ready', async () => {
    const { el, render, button } = setup({ tokenStored: false });
    await render();
    expect(button('Sincronizar ahora').disabled).toBeTrue();
    expect(button('Carga completa').disabled).toBeTrue();
    expect(el.querySelector('a[href="/connection"]')).not.toBeNull();
  });

  it('shows progress and disables the buttons while running', async () => {
    const { el, render, button } = setup({ statuses: [running(1)] });
    await render();
    expect(button('Sincronizar ahora').disabled).toBeTrue();
    expect(button('Carga completa').disabled).toBeTrue();
    const bars = el.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(2);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('1');
    expect(bars[0].getAttribute('aria-valuemax')).toBe('4');
    expect(el.textContent).toContain('1 de 4');
    // Text and bar count the same thing: processed (done + failed) over the total.
    expect(bars[1].getAttribute('aria-valuenow')).toBe('4');
    expect(el.textContent).toContain('4 de 10 (1 con error)');
  });

  it('polls every second while running, reloads the project meta once it is done, then stops', async () => {
    const { render, tick, statusGet, metaGet, rows } = setup({ statuses: [running(1), running(2), finished()] });
    await render();
    expect(statusGet).toHaveBeenCalledTimes(1);
    expect(metaGet).toHaveBeenCalledTimes(2);

    await tick();
    expect(statusGet).toHaveBeenCalledTimes(2);
    expect(metaGet).toHaveBeenCalledTimes(2);

    await tick();
    expect(statusGet).toHaveBeenCalledTimes(3);
    expect(metaGet).toHaveBeenCalledTimes(4);

    await tick(5000);
    expect(statusGet).toHaveBeenCalledTimes(3);
    expect(metaGet).toHaveBeenCalledTimes(4);
    expect(rows().length).toBe(2);
  });

  it('reloads the config when a run ends, so synced fields are not overwritten later', async () => {
    const { render, tick, proxy } = setup({ statuses: [running(1), finished()] });
    await render();
    const configReads = () => proxy.get.calls.allArgs().filter(([p]: string[]) => p === '/api/config').length;
    expect(configReads()).toBe(1);
    await tick();
    expect(configReads()).toBe(2);
    await tick(5000);
    expect(configReads()).toBe(2);
  });

  it('starting a run polls until it finishes, with the last run failed epics listed', async () => {
    const { el, render, tick, button, statusGet } = setup({ statuses: [IDLE, finished()] });
    await render();
    button('Sincronizar ahora').click();
    await render();
    await tick();
    expect(statusGet).toHaveBeenCalledTimes(2);
    expect(el.textContent).toContain('Última sincronización');
    expect(el.textContent).toContain('Tu usuario no tiene permiso para ver este recurso en Jira.');
    await tick(5000);
    expect(statusGet).toHaveBeenCalledTimes(2);
  });

  it('shows the run error through the Spanish message', async () => {
    const failed = { ...finished(), state: 'error', failedEpics: [], error: { code: 'AUTH', message: 'raw' } };
    const { el, render } = setup({ statuses: [failed] });
    await render();
    expect(el.textContent).toContain('Jira rechazó las credenciales (email o token).');
    expect(el.textContent).not.toContain('raw');
  });

  it('clears the timer on destroy and drops late answers', async () => {
    let resolveStatus!: (v: unknown) => void;
    const { render, tick, statusGet, fixture } = setup({ statuses: [running(1)] });
    await render();
    statusGet.and.callFake(() => new Promise((r) => (resolveStatus = r)));
    await tick();
    expect(statusGet).toHaveBeenCalledTimes(2);

    fixture.destroy();
    resolveStatus(finished());
    await settle();
    jasmine.clock().tick(10_000);
    await settle();
    expect(statusGet).toHaveBeenCalledTimes(2);
  });
});
