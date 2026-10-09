import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { resolveTarget } from '../../../../shared/cache-key.mjs';
import { ProxyClient, ProxyError } from '../proxy-client';
import { AppStore } from './app-store';

describe('AppStore', () => {
  function setup(health: () => Promise<{ status: 'ok'; version: string }>) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: { health } }],
    });
    return TestBed.inject(AppStore);
  }

  it('starts with unknown proxy health', () => {
    const store = setup(() => Promise.resolve({ status: 'ok', version: '1' }));
    expect(store.proxyHealth().status).toBe('unknown');
  });

  it('records a healthy proxy', async () => {
    const store = setup(() => Promise.resolve({ status: 'ok', version: '1.2.3' }));
    await store.checkProxyHealth();
    expect(store.proxyHealth()).toEqual({ status: 'ok', version: '1.2.3', errorMessage: null });
  });

  it('records a transport error', async () => {
    const store = setup(() => Promise.reject(new ProxyError('TRANSPORT_ERROR', 'down')));
    await store.checkProxyHealth();
    expect(store.proxyHealth().status).toBe('error');
    expect(store.proxyHealth().errorMessage).toBe('down');
  });
});

describe('AppStore dataset hydration', () => {
  const view = (key: string) => ({
    rows: [{ key } as never],
    fetchedAt: '2026-03-01T10:00:00.000Z',
    isCurrent: true,
    shardsMeta: [],
  });
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
  const epic = { type: 'epic', id: 'X-9' };
  const params = { epicKeys: ['X-9'] };

  function setup(proxy: Partial<Record<'get' | 'post' | 'put' | 'health', jasmine.Spy>>) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: proxy }],
    });
    return TestBed.inject(AppStore);
  }

  it('hydrates once per cache key, keyed by resolveTarget', async () => {
    const get = jasmine.createSpy('get').and.callFake(() => Promise.resolve(view('A-1')));
    const store = setup({ get });

    store.ensureHydrated('epicIssues', epic, params);
    store.ensureHydrated('epicIssues', epic, params); // in flight
    await flush();
    store.ensureHydrated('epicIssues', epic, { epicKeys: ['X-9'] }); // already loaded

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/api/datasets/epicIssues?scopeId=X-9');
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;
    expect(store.datasets()[cacheKey].status).toBe('ready');
    expect(store.datasets()[cacheKey].rows.length).toBe(1);

    store.ensureHydrated('epicIssues', epic, { epicKeys: ['X-9'], epicLinkMode: 'auto' });
    expect(get).toHaveBeenCalledTimes(2); // another key is another hydration
  });

  it('re-arms the key after a transport error so the next call retries', async () => {
    const get = jasmine
      .createSpy('get')
      .and.returnValues(
        Promise.reject(new ProxyError('TRANSPORT_ERROR', 'starting')),
        Promise.resolve(view('A-1')),
      );
    const store = setup({ get });
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;

    store.ensureHydrated('epicIssues', epic, params);
    await flush();
    expect(store.datasets()[cacheKey].status).toBe('error');

    store.ensureHydrated('epicIssues', epic, params);
    await flush();
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.datasets()[cacheKey].status).toBe('ready');
  });

  it('does not retry an error the proxy answered with', async () => {
    const get = jasmine
      .createSpy('get')
      .and.callFake(() => Promise.reject(new ProxyError('DATA_KEY_INVALID', 'no')));
    const store = setup({ get });

    store.ensureHydrated('epicIssues', epic, params);
    await flush();
    store.ensureHydrated('epicIssues', epic, params);

    expect(get).toHaveBeenCalledTimes(1);
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;
    expect(store.datasets()[cacheKey].error).toEqual({ code: 'DATA_KEY_INVALID', message: 'no' });
  });

  it('invalidateDatasets makes the next ensureHydrated read again and a newer view replaces the rows', async () => {
    const older = { ...view('A-1'), fetchedAt: '2026-03-01T10:00:00.000Z' };
    const newer = { ...view('A-2'), fetchedAt: '2026-03-02T10:00:00.000Z' };
    const get = jasmine.createSpy('get').and.returnValues(Promise.resolve(older), Promise.resolve(newer));
    const store = setup({ get });
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;

    store.ensureHydrated('epicIssues', epic, params);
    await flush();
    store.ensureHydrated('epicIssues', epic, params);
    expect(get).toHaveBeenCalledTimes(1);

    store.invalidateDatasets();
    expect(store.datasets()[cacheKey].rows.length).toBe(1); // stale, not empty
    store.ensureHydrated('epicIssues', epic, params);
    await flush();

    expect(get).toHaveBeenCalledTimes(2);
    expect(store.datasets()[cacheKey].fetchedAt).toBe(newer.fetchedAt);
    expect((store.datasets()[cacheKey].rows[0] as unknown as { key: string }).key).toBe('A-2');
    expect(store.datasets()[cacheKey].status).toBe('ready');
  });

  it('a read older than the rows of a refresh that finished first never overwrites them', async () => {
    const stale = { ...view('OLD'), fetchedAt: '2026-03-01T10:00:00.000Z' };
    const fresh = { ...view('NEW'), fetchedAt: '2026-03-02T10:00:00.000Z' };
    let resolveGet!: (v: unknown) => void;
    const get = jasmine.createSpy('get').and.returnValue(new Promise((r) => (resolveGet = r)));
    const post = jasmine.createSpy('post').and.returnValue(Promise.resolve(fresh));
    const store = setup({ get, post });
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;

    store.ensureHydrated('epicIssues', epic, params);
    await store.refreshDataset('epicIssues', epic, params);
    resolveGet(stale);
    await flush();

    expect((store.datasets()[cacheKey].rows[0] as unknown as { key: string }).key).toBe('NEW');
    expect(store.datasets()[cacheKey].fetchedAt).toBe(fresh.fetchedAt);
  });

  it('a failed refresh keeps the previous rows and coalesces concurrent calls', async () => {
    const post = jasmine
      .createSpy('post')
      .and.returnValues(
        Promise.resolve(view('A-1')),
        Promise.reject(new ProxyError('TIMEOUT', 'lento')),
      );
    const store = setup({ get: jasmine.createSpy('get'), post });
    const cacheKey = resolveTarget(epic, 'epicIssues', params).cacheKey;

    const first = store.refreshDataset('epicIssues', epic, params, 'full');
    expect(store.refreshDataset('epicIssues', epic, params, 'full')).toBe(first);
    await first;
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/datasets/epicIssues/refresh?scopeId=X-9&mode=full');

    await store.refreshDataset('epicIssues', epic, params);
    expect(store.datasets()[cacheKey].status).toBe('error');
    expect(store.datasets()[cacheKey].rows.length).toBe(1);
  });
});

describe('AppStore connection status', () => {
  function setup(proxy: Partial<Record<'get' | 'put', jasmine.Spy>>) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: proxy }],
    });
    return TestBed.inject(AppStore);
  }

  it('keeps both the Jira token and the AI key presence, unknown until read', async () => {
    const get = jasmine.createSpy('get').and.resolveTo({ tokenStored: true, aiKeyStored: false });
    const store = setup({ get });
    expect(store.aiKeyStored()).toBeNull();

    await store.loadConnectionStatus();
    expect(store.tokenStored()).toBeTrue();
    expect(store.aiKeyStored()).toBeFalse();
  });

  it('falls back to unknown when the status cannot be read', async () => {
    const store = setup({ get: jasmine.createSpy('get').and.rejectWith(new ProxyError('TRANSPORT_ERROR', 'down')) });
    await store.loadConnectionStatus();
    expect(store.tokenStored()).toBeNull();
    expect(store.aiKeyStored()).toBeNull();
  });

  it('saveAiKey sends the key once and marks it stored without keeping it', async () => {
    const put = jasmine.createSpy('put').and.resolveTo({ stored: true });
    const get = jasmine.createSpy('get').and.resolveTo({ tokenStored: true, aiKeyStored: false });
    const store = setup({ get, put });
    await store.loadConnectionStatus();

    await store.saveAiKey('sk-secret');
    expect(put).toHaveBeenCalledWith('/api/ai/key', { key: 'sk-secret' });
    expect(store.aiKeyStored()).toBeTrue();
    expect(store.tokenStored()).toBeTrue();
    expect(JSON.stringify(store.configState())).not.toContain('sk-secret');
  });

  it('a failed saveAiKey rejects and leaves the presence untouched', async () => {
    const put = jasmine.createSpy('put').and.rejectWith(new ProxyError('VALIDATION_ERROR', 'no'));
    const get = jasmine.createSpy('get').and.resolveTo({ tokenStored: false, aiKeyStored: false });
    const store = setup({ get, put });
    await store.loadConnectionStatus();
    await expectAsync(store.saveAiKey('x')).toBeRejected();
    expect(store.aiKeyStored()).toBeFalse();
  });

  it('saveJiraToken keeps the AI key presence', async () => {
    const put = jasmine.createSpy('put').and.resolveTo({ stored: true });
    const get = jasmine.createSpy('get').and.resolveTo({ tokenStored: false, aiKeyStored: true });
    const store = setup({ get, put });
    await store.loadConnectionStatus();
    await store.saveJiraToken('t');
    expect(store.tokenStored()).toBeTrue();
    expect(store.aiKeyStored()).toBeTrue();
  });
});

describe('AppStore reloadConfig', () => {
  const cfg = (name: string) => normalizeConfig({ teams: [{ id: 't1', name, active: true, members: [] }] });
  function setup(get: jasmine.Spy) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: { get } }],
    });
    return TestBed.inject(AppStore);
  }

  it('re-reads the config, keeping the current one visible while it loads', async () => {
    let resolveSecond!: (v: unknown) => void;
    const get = jasmine
      .createSpy('get')
      .and.returnValues(Promise.resolve(cfg('Old')), new Promise((r) => (resolveSecond = r)));
    const store = setup(get);
    await store.loadConfig();

    const reload = store.reloadConfig();
    expect(store.config()?.teams[0].name).toBe('Old');
    expect(store.configState().status).toBe('ready');
    resolveSecond(cfg('New'));
    await reload;
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.config()?.teams[0].name).toBe('New');
  });

  it('keeps the previous config and does not throw when the reload fails', async () => {
    const get = jasmine
      .createSpy('get')
      .and.returnValues(Promise.resolve(cfg('Old')), Promise.reject(new ProxyError('TRANSPORT_ERROR', 'down')));
    const store = setup(get);
    await store.loadConfig();
    await expectAsync(store.reloadConfig()).toBeResolved();
    expect(store.configState().status).toBe('ready');
    expect(store.config()?.teams[0].name).toBe('Old');
  });

  it('surfaces the error only when there was no previous config', async () => {
    const store = setup(jasmine.createSpy('get').and.rejectWith(new ProxyError('TRANSPORT_ERROR', 'down')));
    await store.reloadConfig();
    expect(store.configState().status).toBe('error');
  });
});

describe('AppStore projectIssues', () => {
  const config = normalizeConfig({
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
    teams: [{ id: 't1', name: 'Alfa', active: true, members: [] }],
    projects: [
      { id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] },
    ],
  });
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(get: jasmine.Spy) {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: { get } }],
    });
    return TestBed.inject(AppStore);
  }

  it('reads the dataset of a project once, without refreshing, and exposes the empty state before and after', async () => {
    const get = jasmine.createSpy('get').and.callFake((path: string) =>
      Promise.resolve(
        path === '/api/config'
          ? config
          : { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] },
      ),
    );
    const store = setup(get);
    await store.loadConfig();

    expect(store.projectIssues('p1').status).toBe('idle');
    store.ensureProjectIssues('p1');
    store.ensureProjectIssues('p1');
    await flush();

    expect(get).toHaveBeenCalledWith('/api/datasets/projectIssues?scopeId=p1');
    expect(get.calls.allArgs().filter(([p]) => String(p).includes('/api/datasets')).length).toBe(1);
    expect(store.projectIssues('p1')).toEqual(jasmine.objectContaining({ status: 'ready', fetchedAt: null, rows: [] }));
  });

  it('ignores an unknown project and does not call the proxy', async () => {
    const get = jasmine.createSpy('get').and.resolveTo(config);
    const store = setup(get);
    await store.loadConfig();
    store.ensureProjectIssues('nope');
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.projectIssues('nope').status).toBe('idle');
  });
});
