import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
