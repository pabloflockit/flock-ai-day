import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
