import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
import { ConnectionPage } from './connection.page';

const SITE = 'https://acme.atlassian.net';
const TOKEN = 'ATATT-super-secret-token';

const statuses = [
  { id: '1', name: 'To Do', statusCategory: 'todo' },
  { id: '3', name: 'In Review', statusCategory: 'todo' },
  { id: '5', name: 'Done', statusCategory: 'done' },
];
const fields = [
  { id: 'customfield_10014', name: 'Epic Link', custom: true, schema: { type: 'any' } },
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
];

const components = [
  { id: '10', name: 'BACKEND' },
  { id: '11', name: 'FRONTEND' },
];

describe('ConnectionPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(
    options: { jira?: Record<string, unknown>; tokenStored?: boolean; epicKeys?: string[]; componentsFail?: boolean } = {},
  ) {
    let stored = normalizeConfig({
      jira: options.jira ?? {},
      teams: [{ id: 't1', name: 'Equipo' }],
      projects: options.epicKeys
        ? [{ id: 'p1', teamId: 't1', name: 'Proyecto', epics: options.epicKeys.map((key) => ({ key })) }]
        : [],
    });
    const calls: string[] = [];
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        calls.push(`GET ${path}`);
        if (path === '/api/config') return Promise.resolve(stored);
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored: options.tokenStored ?? false });
        if (path === '/api/jira/statuses') return Promise.resolve(statuses);
        if (path === '/api/jira/fields') return Promise.resolve(fields);
        if (path.startsWith('/api/jira/projects/')) {
          if (options.componentsFail) return Promise.reject(new ProxyError('UNREACHABLE', 'No se pudo llegar a Jira.'));
          return Promise.resolve(components);
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      post: jasmine.createSpy('post').and.callFake((path: string, body?: { baseUrl: string }) => {
        calls.push(`POST ${path}`);
        if (path === '/api/connection/verify') {
          return Promise.resolve({ deploymentType: 'Cloud', baseUrl: body!.baseUrl.replace(/\/+$/, '') });
        }
        if (path === '/api/connection/test') return Promise.resolve({ accountId: 'a1', displayName: 'Ana' });
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      put: jasmine.createSpy('put').and.callFake((path: string, body: unknown) => {
        calls.push(`PUT ${path}`);
        if (path === '/api/config') {
          stored = normalizeConfig(body);
          return Promise.resolve({ config: stored, movedKeys: [] });
        }
        return Promise.resolve({ stored: true });
      }),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ProxyClient, useValue: proxy },
      ],
    });
    const fixture = TestBed.createComponent(ConnectionPage);
    const render = async () => {
      await flush();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
    };
    return {
      fixture,
      proxy,
      calls,
      render,
      page: fixture.componentInstance,
      el: fixture.nativeElement as HTMLElement,
      stored: () => stored,
    };
  }

  const configured = { jira: { baseUrl: SITE, email: 'a@b.c' }, tokenStored: true };

  it('opens the wizard on first run and the editable screen once set up', async () => {
    const first = setup();
    await first.render();
    expect(first.page.mode()).toBe('wizard');
    expect(first.page.step()).toBe(1);
    TestBed.resetTestingModule();

    const later = setup(configured);
    await later.render();
    expect(later.page.mode()).toBe('edit');
  });

  it('also opens the wizard when the site is saved but no token is stored yet', async () => {
    const { page, render } = setup({ jira: configured.jira, tokenStored: false });
    await render();
    expect(page.mode()).toBe('wizard');
  });

  it('continues from the site step only with the verified URL', async () => {
    const { page, render } = setup();
    await render();
    page.baseUrl.set(`${SITE}/`);
    expect(page.siteVerified()).toBeFalse();

    await page.verifyUrl();
    expect(page.baseUrl()).toBe(SITE);
    expect(page.siteVerified()).toBeTrue();

    page.baseUrl.set('https://other.atlassian.net');
    expect(page.siteVerified()).toBeFalse();
  });

  it('"Probar" saves URL, email and token first, then tests, and never keeps the token', async () => {
    const { page, render, calls, el, fixture, stored } = setup();
    await render();
    page.baseUrl.set(SITE);
    await page.verifyUrl();
    page.next();
    expect(page.step()).toBe(2);
    expect(page.canTest()).toBeFalse();

    page.email.set(' a@b.c ');
    page.token.set(TOKEN);
    expect(page.canTest()).toBeTrue();
    calls.length = 0;
    await page.saveAndTest();
    fixture.detectChanges();

    expect(calls).toEqual(['PUT /api/config', 'PUT /api/connection/token', 'POST /api/connection/test']);
    expect(stored().jira.baseUrl).toBe(SITE);
    expect(stored().jira.email).toBe('a@b.c');
    expect(page.test().status).toBe('ok');
    expect(page.token()).toBe('');
    expect(el.innerHTML).not.toContain(TOKEN);
    expect(el.textContent).toContain('Conectado como Ana');
  });

  it('does not test when saving the connection fails', async () => {
    const { page, render, proxy, calls } = setup();
    await render();
    page.baseUrl.set(SITE);
    await page.verifyUrl();
    page.next();
    page.email.set('a@b.c');
    page.token.set(TOKEN);
    proxy.put.and.callFake((path: string) =>
      path === '/api/config'
        ? Promise.reject(Object.assign(new Error('no'), { code: 'URL_NOT_VERIFIED' }))
        : Promise.resolve({ stored: true }),
    );
    calls.length = 0;
    await page.saveAndTest();
    expect(calls).not.toContain('POST /api/connection/test');
    expect(page.test().status).toBe('error');
  });

  it('proposes "auto" and saves the particularities with the status overrides on finish', async () => {
    const { page, render, stored } = setup({ jira: configured.jira, tokenStored: false });
    await render();
    page.baseUrl.set(SITE);
    await page.verifyUrl();
    page.next();
    page.email.set('a@b.c');
    page.token.set(TOKEN);
    await page.saveAndTest();
    page.next();
    await render();

    expect(page.step()).toBe(3);
    expect(page.epicLinkMode()).toBe('auto');
    expect(page.statuses().map((s) => s.name)).toEqual(['To Do', 'In Review', 'Done']);
    expect(page.customFields().map((f) => f.id)).toEqual(['customfield_10014']);

    page.setOverride('3', 'doing');
    page.setOverride('5', '');
    await page.finish();

    expect(stored().jira.epicLinkMode).toBe('auto');
    expect(stored().jira.statusCategoryOverrides).toEqual({ '3': 'doing' });
    expect(page.mode()).toBe('edit');
  });

  it('edit screen: the token is only replaced, never shown', async () => {
    const { page, render, el, calls } = setup(configured);
    await render();
    expect(el.textContent).toContain('Hay un token guardado');
    expect((el.querySelector('#jira-token') as HTMLInputElement).value).toBe('');

    calls.length = 0;
    await page.saveAndTest();
    expect(calls).toEqual(['PUT /api/config', 'POST /api/connection/test']);
  });

  describe('Capas por componente', () => {
    const layered = { ...configured, epicKeys: ['zed-1', 'ABC-2', 'ABC-3'] };
    const section = (el: HTMLElement) => el.querySelector('[data-testid="component-layers"]') as HTMLElement;

    it('shows an empty state when there are no epics yet', async () => {
      const { render, el } = setup(configured);
      await render();
      expect(section(el).textContent).toContain('Capas por componente');
      expect(section(el).textContent).toContain('Todavía no hay épicas');
      expect(section(el).querySelectorAll('[data-testid="layer-project"]').length).toBe(0);
    });

    it('lists one block per Jira project key of the epics, sorted, without calling Jira', async () => {
      const { render, el, calls } = setup(layered);
      await render();
      const blocks = Array.from(section(el).querySelectorAll('[data-testid="layer-project"]'));
      expect(blocks.map((b) => b.querySelector('h4')?.textContent?.trim())).toEqual(['ABC', 'ZED']);
      expect(section(el).textContent).toContain("Sin capa");
      expect(calls.some((c) => c.includes('/api/jira/projects/'))).toBeFalse();
    });

    it('loads the components of a project on demand and shows them with their layer', async () => {
      const { page, render, el, calls } = setup({
        ...layered,
        jira: { ...configured.jira, componentLayers: [{ projectKey: 'ABC', componentId: '11', componentName: 'FRONTEND', layer: 'frontend' }] },
      });
      await render();
      await page.loadComponents('ABC');
      await render();

      expect(calls).toContain('GET /api/jira/projects/ABC/components');
      const selects = Array.from(section(el).querySelectorAll('select')) as HTMLSelectElement[];
      expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual([
        'Capa para BACKEND (ABC)',
        'Capa para FRONTEND (ABC)',
      ]);
      expect(selects.map((s) => s.value)).toEqual(['', 'frontend']);
    });

    it('saves the chosen layer through the editor (setComponentLayer) and removes it with "—"', async () => {
      const { page, render, stored } = setup(layered);
      await render();
      await page.loadComponents('ABC');
      await page.setComponentLayer('ABC', { id: '10', name: 'BACKEND' }, 'backend');
      expect(stored().jira.componentLayers).toEqual([
        { projectKey: 'ABC', componentId: '10', componentName: 'BACKEND', layer: 'backend' },
      ]);
      await page.setComponentLayer('ABC', { id: '10', name: 'BACKEND' }, '');
      expect(stored().jira.componentLayers).toEqual([]);
    });

    it('saving a layer keeps unsaved status-mapping edits on the same screen', async () => {
      const { page, render } = setup(layered);
      await render();
      page.overrides.set({ '3': 'done' });
      await page.setComponentLayer('ABC', { id: '10', name: 'BACKEND' }, 'backend');
      await render();
      expect(page.overrides()).toEqual({ '3': 'done' });
    });

    it('shows the load error in Spanish with its code', async () => {
      const { page, render, el } = setup({ ...layered, componentsFail: true });
      await render();
      await page.loadComponents('ABC');
      await render();
      expect(section(el).textContent).toContain('No se pudieron leer los componentes');
      expect(section(el).textContent).toContain('UNREACHABLE');
    });
  });

  describe('Estados bloqueados', () => {
    const section = (el: HTMLElement) => el.querySelector('[data-testid="blocked-statuses"]') as HTMLElement;
    const boxes = (el: HTMLElement) => Array.from(section(el).querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];

    it('lists every Jira status with a checkbox, checked for the saved blocked ones', async () => {
      const { render, el } = setup({ ...configured, jira: { ...configured.jira, blockedStatusIds: ['3'] } });
      await render();
      expect(section(el).textContent).toContain('Estados bloqueados');
      expect(section(el).textContent).toContain('Los ítems en estos estados cuentan como bloqueados en el informe de cierre.');
      expect(boxes(el).map((b) => b.getAttribute('aria-label'))).toEqual([
        'Bloqueado: To Do',
        'Bloqueado: In Review',
        'Bloqueado: Done',
      ]);
      expect(boxes(el).map((b) => b.checked)).toEqual([false, true, false]);
    });

    it('toggling a checkbox saves the list at once and unchecking removes it', async () => {
      const { page, render, el, stored } = setup(configured);
      await render();
      const box = boxes(el)[1];
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await render();
      expect(stored().jira.blockedStatusIds).toEqual(['3']);
      await page.setBlockedStatus('1', true);
      expect(stored().jira.blockedStatusIds).toEqual(['3', '1']);
      await page.setBlockedStatus('3', false);
      expect(stored().jira.blockedStatusIds).toEqual(['1']);
    });

    it('saving a blocked status keeps unsaved status-mapping edits', async () => {
      const { page, render } = setup(configured);
      await render();
      page.overrides.set({ '3': 'done' });
      await page.setBlockedStatus('5', true);
      await render();
      expect(page.overrides()).toEqual({ '3': 'done' });
    });
  });
});
