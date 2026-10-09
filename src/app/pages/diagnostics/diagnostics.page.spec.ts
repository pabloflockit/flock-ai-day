import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
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

  function setup(configGet?: () => Promise<unknown>, tokenStored = true) {
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return configGet ? configGet() : Promise.resolve(config);
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored });
        if (path.startsWith('/api/jira/epics/')) {
          return Promise.resolve({ key: 'X-9', summary: 'Épica de prueba' });
        }
        return Promise.resolve(dataset);
      }),
      post: jasmine.createSpy('post').and.callFake(() => Promise.resolve(dataset)),
      put: jasmine.createSpy('put').and.callFake(() => Promise.resolve({ stored: true })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ProxyClient, useValue: proxy },
      ],
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
    expect(el.querySelector('.status-chip.state-blocked')!.textContent).toContain('Desactualizado');
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

  it('shows the connection read-only and never renders a token field', async () => {
    const { fixture, el } = setup();
    await flush();
    fixture.detectChanges();
    expect(el.querySelector('#jira-token')).toBeNull();
    expect(el.textContent).toContain('https://acme.atlassian.net');
    expect(el.textContent).toContain('Guardado');
    expect(el.querySelector('a[href="/connection"]')).not.toBeNull();
  });

  describe('data key recovery', () => {
    const keyInvalid = () => Promise.reject(new ProxyError('DATA_KEY_INVALID', 'No se pudo descifrar la base local.'));
    const createButton = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Crear base nueva'));

    it('offers "Crear base nueva" only for DATA_KEY_INVALID', async () => {
      const ok = setup();
      await flush();
      ok.fixture.detectChanges();
      expect(createButton(ok.el)).toBeUndefined();

      TestBed.resetTestingModule();
      const otherError = setup(() => Promise.reject(new ProxyError('UNKNOWN', 'boom')));
      await flush();
      otherError.fixture.detectChanges();
      expect(otherError.el.textContent).toContain('código: UNKNOWN');
      expect(createButton(otherError.el)).toBeUndefined();

      TestBed.resetTestingModule();
      const bad = setup(keyInvalid);
      await flush();
      bad.fixture.detectChanges();
      expect(createButton(bad.el)).toBeDefined();
      expect(bad.el.textContent).toContain('se conserva');
    });

    it('asks for confirmation, then resets the storage and reloads the configuration', async () => {
      const { fixture, page, proxy, el } = setup(keyInvalid);
      await flush();
      fixture.detectChanges();

      const confirmSpy = spyOn(window, 'confirm').and.returnValue(false);
      createButton(el)!.click();
      await flush();
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(proxy.post).not.toHaveBeenCalledWith('/api/storage/reset', jasmine.anything());

      confirmSpy.and.returnValue(true);
      proxy.post.and.resolveTo({ backupFile: 'leadership-panel.db.bak-2026' });
      proxy.get.and.resolveTo(config);
      createButton(el)!.click();
      await flush();
      fixture.detectChanges();

      expect(proxy.post).toHaveBeenCalledWith('/api/storage/reset', { confirm: 'RESET' });
      expect(page.resetResult()?.backupFile).toBe('leadership-panel.db.bak-2026');
      expect(page.config()).not.toBeNull();
      expect(createButton(el)).toBeUndefined();
      expect(el.textContent).toContain('leadership-panel.db.bak-2026');
    });
  });

  it('only tests the connection or validates an epic once URL, email and token are saved', async () => {
    const button = (el: HTMLElement, label: string) =>
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(label))!;

    const missing = setup(undefined, false);
    await flush();
    missing.fixture.detectChanges();
    expect(missing.page.jiraReady()).toBeFalse();
    expect(button(missing.el, 'Probar conexión').disabled).toBeTrue();
    expect(button(missing.el, 'Validar').disabled).toBeTrue();
    expect(missing.el.textContent).toContain('Guardá URL, email y token');

    TestBed.resetTestingModule();
    const ready = setup();
    await flush();
    ready.fixture.detectChanges();
    expect(button(ready.el, 'Probar conexión').disabled).toBeFalse();
    expect(button(ready.el, 'Validar').disabled).toBeFalse();
  });
});
