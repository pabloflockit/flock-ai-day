import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
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

describe('ConnectionPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(options: { jira?: Record<string, unknown>; tokenStored?: boolean } = {}) {
    let stored = normalizeConfig({ jira: options.jira ?? {} });
    const calls: string[] = [];
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        calls.push(`GET ${path}`);
        if (path === '/api/config') return Promise.resolve(stored);
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored: options.tokenStored ?? false });
        if (path === '/api/jira/statuses') return Promise.resolve(statuses);
        if (path === '/api/jira/fields') return Promise.resolve(fields);
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
});
