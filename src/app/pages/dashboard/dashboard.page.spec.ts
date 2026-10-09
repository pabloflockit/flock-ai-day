import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { DashboardPage } from './dashboard.page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

async function render(config: unknown) {
  const get = jasmine.createSpy('get').and.callFake((path: string) =>
    Promise.resolve(path === '/api/config' ? normalizeConfig(config) : { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] }),
  );
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: { get } }],
  });
  const fixture = TestBed.createComponent(DashboardPage);
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('DashboardPage', () => {
  it('shows an empty state when there is no active team', async () => {
    const el = await render({ jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' }, teams: [], projects: [] });
    expect(el.textContent).toContain('Todavía no hay equipos activos');
  });

  it('asks to sync when a project of the team has no data yet', async () => {
    const el = await render({
      jira: { baseUrl: 'https://a.atlassian.net', email: 'a@b.c' },
      teams: [{ id: 't1', name: 'Alfa', active: true, members: [] }],
      projects: [{ id: 'p1', teamId: 't1', name: 'Portal', active: true, workUnit: 'task', measure: { kind: 'count' }, epics: [] }],
    });
    expect(el.textContent).toContain('Faltan datos: sincronizá desde');
    expect(el.querySelector('a[href="/sync"]')).not.toBeNull();
  });
});
