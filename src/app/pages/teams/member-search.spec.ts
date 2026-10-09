import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';
import { MEMBER_SEARCH_DEBOUNCE_MS, MemberSearch } from './member-search';

const config = {
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
  teams: [
    { id: 't1', name: 'Alfa', members: [{ accountId: 'u1', displayName: 'Ana Pérez' }] },
    { id: 't2', name: 'Beta', members: [{ accountId: 'u2', displayName: 'Bruno Díaz' }] },
  ],
};
const users = [
  { accountId: 'u1', displayName: 'Ana Pérez', emailAddress: 'ana@acme.com', active: true },
  { accountId: 'u2', displayName: 'Bruno Díaz', emailAddress: null, active: true },
  { accountId: 'u3', displayName: 'Carla Gómez', emailAddress: 'carla@acme.com', active: true },
];

describe('MemberSearch', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
  afterEach(() => jasmine.clock().uninstall());

  function setup(tokenStored = true) {
    const searchGet = jasmine.createSpy('search').and.callFake(() => Promise.resolve(users));
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(normalizeConfig(config));
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored });
        return searchGet(path);
      }),
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: proxy }],
    });
    const fixture = TestBed.createComponent(MemberSearch);
    fixture.componentRef.setInput('teamId', 't1');
    const el = fixture.nativeElement as HTMLElement;
    const added: unknown[] = [];
    fixture.componentInstance.add.subscribe((u) => added.push(u));
    const load = async () => {
      const store = TestBed.inject(AppStore);
      await store.loadConfig();
      await store.loadConnectionStatus();
      fixture.detectChanges();
    };
    const type = (value: string) => {
      const input = el.querySelector('#member-search') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const settle = async () => {
      await flush();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
    };
    return { fixture, el, searchGet, load, type, settle, added };
  }

  it('does not search under two characters', async () => {
    const { load, type, settle, searchGet } = setup();
    await load();
    type(' a ');
    await settle();
    await new Promise((r) => setTimeout(r, MEMBER_SEARCH_DEBOUNCE_MS + 50));
    expect(searchGet).not.toHaveBeenCalled();
  });

  it('debounces typing into a single request', async () => {
    const { load, type, settle, searchGet } = setup();
    await load();
    jasmine.clock().install();
    type('an');
    jasmine.clock().tick(200);
    type('ana');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS - 1);
    expect(searchGet).not.toHaveBeenCalled();
    jasmine.clock().tick(1);
    jasmine.clock().uninstall();
    await settle();
    expect(searchGet).toHaveBeenCalledTimes(1);
    expect(searchGet).toHaveBeenCalledWith('/api/jira/users?query=ana');
  });

  it('encodes the query', async () => {
    const { load, type, settle, searchGet } = setup();
    await load();
    jasmine.clock().install();
    type('a b&');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    jasmine.clock().uninstall();
    await settle();
    expect(searchGet).toHaveBeenCalledWith('/api/jira/users?query=a%20b%26');
  });

  it('ignores a stale response', async () => {
    const { load, type, settle, searchGet, el } = setup();
    await load();
    let resolveFirst!: (v: unknown) => void;
    searchGet.and.callFake((path: string) =>
      path.endsWith('=ana') ? new Promise((r) => (resolveFirst = r)) : Promise.resolve([users[2]]),
    );
    jasmine.clock().install();
    type('ana');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    type('carla');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    jasmine.clock().uninstall();
    await settle();
    resolveFirst(users);
    await settle();
    expect(el.textContent).toContain('Carla Gómez');
    expect(el.textContent).not.toContain('Ana Pérez');
  });

  it('is disabled until Jira is configured', async () => {
    const { load, el } = setup(false);
    await load();
    expect((el.querySelector('#member-search') as HTMLInputElement).disabled).toBeTrue();
    expect(el.textContent).toContain('Configurá la conexión con Jira para buscar personas.');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/connection');
  });

  async function searched() {
    const ctx = setup();
    await ctx.load();
    jasmine.clock().install();
    ctx.type('an');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    jasmine.clock().uninstall();
    await ctx.settle();
    return ctx;
  }

  it('marks people already in the team and notes other teams', async () => {
    const { el } = await searched();
    const items = Array.from(el.querySelectorAll('li')) as HTMLElement[];
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain('Ya está en el equipo');
    expect((items[0].querySelector('button') as HTMLButtonElement).disabled).toBeTrue();
    expect(items[1].textContent).toContain('También en: Beta');
    expect((items[1].querySelector('button') as HTMLButtonElement).disabled).toBeFalse();
    expect(items[2].textContent).toContain('carla@acme.com');
  });

  it('emits the Jira user on Agregar', async () => {
    const { el, added, fixture } = await searched();
    ((el.querySelectorAll('li')[2] as HTMLElement).querySelector('button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(added).toEqual([users[2]]);
  });

  it('shows errors and the empty result', async () => {
    const { load, type, settle, searchGet, el } = setup();
    await load();
    searchGet.and.callFake(() => Promise.reject(new ProxyError('JIRA_AUTH', 'Credenciales inválidas')));
    jasmine.clock().install();
    type('zz');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    jasmine.clock().uninstall();
    await settle();
    expect(el.querySelector('.field-error')?.textContent).toContain('JIRA_AUTH');

    searchGet.and.callFake(() => Promise.resolve([]));
    jasmine.clock().install();
    type('zzz');
    jasmine.clock().tick(MEMBER_SEARCH_DEBOUNCE_MS);
    jasmine.clock().uninstall();
    await settle();
    expect(el.textContent).toContain('Sin resultados.');
  });
});
