import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { TeamDetailPage } from './team-detail.page';

const member = (accountId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  accountId,
  displayName,
  emailAddress: `${accountId}@acme.com`,
  jiraActive: true,
  active: true,
  refreshedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});

const seed = () => ({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
  teams: [
    {
      id: 't1',
      name: 'Alfa',
      description: 'Equipo de plataforma',
      members: [
        member('a1', 'Ana Pérez'),
        member('a2', 'Bruno Díaz', { active: false, emailAddress: null, jiraActive: false }),
      ],
    },
    { id: 't2', name: 'Beta', members: [member('a1', 'Ana Pérez')] },
  ],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      name: 'Portal',
      workUnit: 'task',
      measure: { kind: 'count' },
      epics: [{ key: 'PRT-1', issueTypeId: '10000', summary: 'Uno', active: true }],
    },
  ],
});

describe('TeamDetailPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(id = 't1') {
    let stored = normalizeConfig(seed());
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(stored);
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored: true });
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      put: jasmine.createSpy('put').and.callFake((_path: string, body: unknown) => {
        stored = normalizeConfig(body);
        return Promise.resolve({ config: stored, movedKeys: [] });
      }),
    };
    const ask = jasmine.createSpy('ask').and.callFake(() => Promise.resolve(true));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ProxyClient, useValue: proxy },
        { provide: ConfirmService, useValue: { ask } },
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id })) } },
      ],
    });
    const fixture = TestBed.createComponent(TeamDetailPage);
    const el = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await flush();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
    };
    const button = (text: string, root: ParentNode = el) =>
      Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement;
    const rows = () => Array.from(el.querySelectorAll('tbody tr')) as HTMLElement[];
    return { fixture, el, ask, render, button, rows, stored: () => stored };
  }

  it('renders the members with chips and the other-team note', async () => {
    const { el, render, rows } = setup();
    await render();
    expect(el.querySelector('h1')?.textContent).toContain('Alfa');
    expect(el.textContent).toContain('Equipo de plataforma');
    expect(rows().length).toBe(2);
    expect(rows()[0].textContent).toContain('AP');
    expect(rows()[0].textContent).toContain('a1@acme.com');
    expect(rows()[0].textContent).toContain('También en: Beta');
    expect(rows()[1].textContent).toContain('—');
    expect(rows()[1].querySelector('.state-pending')?.textContent).toContain('Inactivo');
    expect(rows()[1].querySelector('.state-blocked')?.textContent).toContain('Desactivado en Jira');
    expect(el.querySelector('#member-search')).not.toBeNull();
  });

  it('deactivates and reactivates a member', async () => {
    const { render, button, rows, stored } = setup();
    await render();
    button('Desactivar', rows()[0]).click();
    await render();
    expect(stored().teams[0].members[0].active).toBeFalse();
    button('Activar', rows()[0]).click();
    await render();
    expect(stored().teams[0].members[0].active).toBeTrue();
  });

  it('removes a member after confirmation', async () => {
    const { render, button, rows, stored, ask } = setup();
    await render();
    button('Quitar', rows()[1]).click();
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored().teams[0].members.map((m) => m.accountId)).toEqual(['a1']);
  });

  it('shows a message for an unknown team', async () => {
    const { el, render } = setup('nope');
    await render();
    expect(el.textContent).toContain('El equipo no existe.');
    expect(el.querySelector('a[href="/teams"]')).not.toBeNull();
  });

  it('switches between members and projects', async () => {
    const { el, render, fixture } = setup();
    await render();
    const tabs = Array.from(el.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Integrantes (2)', 'Proyectos (1)']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    tabs[1].click();
    fixture.detectChanges();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('#member-search')).toBeNull();
    const row = el.querySelector('tbody tr') as HTMLElement;
    expect(row.textContent).toContain('Portal');
    expect(row.textContent).toContain('1');
  });
});
