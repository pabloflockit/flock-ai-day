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
    { id: 'p2', teamId: 't1', name: 'Vacío', workUnit: 'both', measure: { kind: 'field', fieldId: 'customfield_1', fieldName: 'Puntos', valueType: 'number' }, epics: [] },
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
    return { fixture, el, proxy, ask, render, button, rows, stored: () => stored };
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
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['Integrantes (2)', 'Proyectos (2)']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    tabs[1].click();
    fixture.detectChanges();
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(el.querySelector('#member-search')).toBeNull();
    const row = el.querySelector('tbody tr') as HTMLElement;
    expect(row.textContent).toContain('Portal');
    expect(row.textContent).toContain('1');
    expect(row.textContent).toContain('Tareas · Cantidad');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/projects/p1');
    expect(el.querySelectorAll('tbody tr')[1].textContent).toContain('Tareas y subtareas · Puntos');
  });

  describe('projects tab', () => {
    async function openProjects() {
      const ctx = setup();
      await ctx.render();
      (ctx.el.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
      ctx.fixture.detectChanges();
      return ctx;
    }
    const type = (el: HTMLElement, selector: string, value: string) => {
      const input = el.querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };

    it('creates a project for the team', async () => {
      const { el, fixture, render, button, stored } = await openProjects();
      button('Nuevo proyecto').click();
      fixture.detectChanges();
      type(el, '#project-name', 'Nuevo');
      type(el, '#project-description', 'Desc');
      button('Crear', el.querySelector('[role="dialog"]')!).click();
      await render();
      const created = stored().projects.at(-1)!;
      expect(created).toEqual(jasmine.objectContaining({ name: 'Nuevo', teamId: 't1', description: 'Desc', active: true }));
      expect(el.querySelector('[role="dialog"]')).toBeNull();
      expect(el.textContent).toContain('Nuevo');
    });

    it('shows the name error and keeps the modal open on a duplicate', async () => {
      const { el, fixture, render, button, proxy } = await openProjects();
      proxy.put.calls.reset();
      button('Nuevo proyecto').click();
      fixture.detectChanges();
      type(el, '#project-name', 'portal');
      button('Crear', el.querySelector('[role="dialog"]')!).click();
      await render();
      expect(proxy.put).not.toHaveBeenCalled();
      expect(el.querySelector('[role="dialog"] .field-error')).not.toBeNull();
    });

    it('toggles a project', async () => {
      const { el, render, button, rows, stored } = await openProjects();
      button('Desactivar', rows()[0]).click();
      await render();
      expect(stored().projects[0].active).toBeFalse();
      expect(el.querySelectorAll('tbody tr')[0].textContent).toContain('Inactivo');
    });

    it('shows the guard message instead of deleting a project with epics', async () => {
      const { el, render, button, rows, ask, stored } = await openProjects();
      button('Eliminar', rows()[0]).click();
      await render();
      expect(ask).not.toHaveBeenCalled();
      expect(stored().projects.length).toBe(2);
      expect(el.querySelector('.delete-error')?.textContent).toContain('épica');
    });

    it('deletes an empty project after confirmation', async () => {
      const { render, button, rows, ask, stored } = await openProjects();
      button('Eliminar', rows()[1]).click();
      await render();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(stored().projects.map((p) => p.id)).toEqual(['p1']);
    });
  });
});
