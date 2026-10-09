import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ProxyClient } from '../../core/proxy-client';
import { DiagnosticsPage } from './diagnostics.page';

const config = {
  jira: {
    baseUrl: 'https://acme.atlassian.net',
    email: 'a@b.c',
    epicLinkMode: 'parent',
    epicLinkFieldId: null,
    statusCategoryOverrides: {},
  },
};

const row = {
  key: 'A-1',
  summary: '<b>bold</b> <img src=x onerror=alert(1)>',
  issueTypeName: 'Task',
  statusId: '1',
  statusName: 'To Do',
  statusCategory: 'todo',
  statusSince: '2026-03-01T13:00:00.000Z',
  dueDate: '2026-03-05',
  assigneeName: 'Ana',
  measures: { customfield_1: 3, customfield_2: null },
};

const dataset = {
  rows: [row],
  fetchedAt: '2026-03-01T13:00:00.000Z',
  isCurrent: false,
  shardsMeta: [{ key: 'X-9', status: 'failed', lastOkAt: null, errorCode: 'TIMEOUT' }],
};

describe('DiagnosticsPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup() {
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(config);
        if (path.startsWith('/api/jira/epics/')) {
          return Promise.resolve({ key: 'X-9', summary: 'Épica de prueba' });
        }
        return Promise.resolve(dataset);
      }),
      post: jasmine.createSpy('post').and.callFake(() => Promise.resolve(dataset)),
      put: jasmine.createSpy('put').and.callFake(() => Promise.resolve({ stored: true })),
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: ProxyClient, useValue: proxy }],
    });
    const fixture = TestBed.createComponent(DiagnosticsPage);
    return { fixture, proxy, page: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  }

  async function showRows(page: DiagnosticsPage, fixture: { detectChanges(): void }) {
    await flush();
    page.epicKey.set('X-9');
    await page.validateEpic();
    await flush();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
  }

  afterEach(() => {
    delete window.leadershipPanel;
  });

  it('renders Jira text as text, never as markup', async () => {
    const { fixture, page, el } = setup();
    await showRows(page, fixture);

    const summaryCell = el.querySelectorAll('tbody tr td')[1];
    expect(summaryCell.textContent).toBe(row.summary);
    expect(el.querySelector('tbody b')).toBeNull();
    expect(el.querySelector('tbody img')).toBeNull();
    expect(el.querySelector('tbody')!.innerHTML).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('shows the row fields, fetchedAt, the stale badge and the failed shards', async () => {
    const { fixture, page, el } = setup();
    await showRows(page, fixture);

    const cells = Array.from(el.querySelectorAll('tbody tr td')).map((c) => c.textContent?.trim());
    expect(cells[0]).toBe('A-1');
    expect(cells[3]).toBe('To Do (Por hacer)');
    expect(cells[4]).toBe('Ana');
    expect(cells[6]).toBe('5/3/2026'); // calendar date: no timezone shift
    expect(cells[7]).toContain('customfield_1: 3');
    expect(cells[7]).toContain('customfield_2: —');
    expect(el.querySelector('.badge')!.textContent).toContain('Desactualizado');
    expect(el.textContent).toContain('Última actualización:');
    expect(el.textContent).toContain('Falló la carga de la épica X-9');
    expect(el.textContent).toContain('código: TIMEOUT');
  });

  it('hides "Abrir en Jira" without the preload bridge and shows it with it', async () => {
    const without = setup();
    await showRows(without.page, without.fixture);
    expect(without.el.textContent).not.toContain('Abrir en Jira');

    TestBed.resetTestingModule();
    window.leadershipPanel = {
      openInJira: jasmine.createSpy('openInJira').and.resolveTo({ ok: true }),
    } as never;
    const withBridge = setup();
    await showRows(withBridge.page, withBridge.fixture);
    expect(withBridge.el.textContent).toContain('Abrir en Jira');
  });

  it('clears the token input after saving and never renders it', async () => {
    const { fixture, page, proxy, el } = setup();
    await flush();
    page.token.set('super-secret-token');
    await page.saveJiraToken();
    fixture.detectChanges();

    expect(proxy.put).toHaveBeenCalledWith('/api/connection/token', { token: 'super-secret-token' });
    expect(page.token()).toBe('');
    expect((el.querySelector('#jira-token') as HTMLInputElement).value).toBe('');
    expect(el.innerHTML).not.toContain('super-secret-token');
  });

  it('only allows saving the connection after the URL was verified', async () => {
    const { page, proxy } = setup();
    await flush();
    expect(page.canSaveConnection()).toBeFalse();

    proxy.post.and.resolveTo({ deploymentType: 'Cloud', baseUrl: 'https://acme.atlassian.net' });
    await page.verifyUrl();
    expect(page.canSaveConnection()).toBeTrue();

    page.baseUrl.set('https://other.atlassian.net');
    expect(page.canSaveConnection()).toBeFalse();
  });
});
