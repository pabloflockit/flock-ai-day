import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { TeamsPage } from './teams.page';

const member = (accountId: string, displayName: string, active = true) => ({
  accountId,
  displayName,
  emailAddress: `${accountId}@acme.com`,
  jiraActive: true,
  active,
  refreshedAt: '2026-01-01T00:00:00.000Z',
});

const seed = () => ({
  teams: [
    { id: 't1', name: 'Alfa', description: 'Equipo de plataforma', active: true, members: [member('a1', 'Ana Pérez'), member('a2', 'Bruno Díaz', false)] },
    { id: 't2', name: 'Beta', active: true, members: [] },
  ],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      name: 'Portal',
      active: true,
      workUnit: 'task',
      measure: { kind: 'count' },
      epics: [
        { key: 'PRT-1', issueTypeId: '10000', summary: 'Uno', active: true },
        { key: 'PRT-2', issueTypeId: '10000', summary: 'Dos', active: true },
      ],
    },
  ],
});

describe('TeamsPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(confirm = true, data: unknown = seed()) {
    let stored = normalizeConfig(data);
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) =>
        path === '/api/config' ? Promise.resolve(stored) : Promise.reject(new Error(`unexpected ${path}`)),
      ),
      post: jasmine.createSpy('post'),
      put: jasmine.createSpy('put').and.callFake((path: string, body: unknown) => {
        stored = normalizeConfig(body);
        return Promise.resolve({ config: stored, movedKeys: [] });
      }),
    };
    const ask = jasmine.createSpy('ask').and.callFake(() => Promise.resolve(confirm));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: ProxyClient, useValue: proxy },
        { provide: ConfirmService, useValue: { ask } },
      ],
    });
    const fixture = TestBed.createComponent(TeamsPage);
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
    const type = (selector: string, value: string) => {
      const input = el.querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    return { fixture, el, proxy, ask, render, button, rows, type, stored: () => stored };
  }

  it('lists the teams with their counts', async () => {
    const { el, render, rows } = setup();
    await render();
    expect(rows().length).toBe(2);
    const alfa = rows()[0];
    expect(alfa.querySelector('a')?.getAttribute('href')).toBe('/teams/t1');
    expect(alfa.textContent).toContain('Equipo de plataforma');
    expect(alfa.textContent).toContain('Activo');
    const nums = Array.from(alfa.querySelectorAll('.num')).map((n) => n.textContent?.trim());
    expect(nums).toEqual(['2', '1', '2']);
    expect(el.querySelector('h1')?.textContent).toContain('Equipos');
  });

  it('creates a team, saves it and closes the modal', async () => {
    const { el, render, button, type, fixture, proxy, stored } = setup();
    await render();
    button('Nuevo equipo').click();
    fixture.detectChanges();
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();

    type('#team-name', 'Gamma');
    type('#team-description', 'Nuevo');
    button('Crear', el.querySelector('[role="dialog"]')!).click();
    await render();

    expect(proxy.put).toHaveBeenCalled();
    expect(stored().teams.map((t) => t.name)).toEqual(['Alfa', 'Beta', 'Gamma']);
    expect(stored().teams[2].description).toBe('Nuevo');
    expect(el.querySelector('[role="dialog"]')).toBeNull();
    expect(el.textContent).toContain('Gamma');
  });

  it('keeps the modal open and shows the field error on a duplicate name', async () => {
    const { el, render, button, type, fixture, proxy } = setup();
    await render();
    button('Nuevo equipo').click();
    fixture.detectChanges();
    type('#team-name', 'alfa');
    button('Crear', el.querySelector('[role="dialog"]')!).click();
    await render();

    expect(proxy.put).not.toHaveBeenCalled();
    expect(el.querySelector('[role="dialog"]')).not.toBeNull();
    expect(el.querySelector('[role="dialog"] .field-error')?.textContent).toContain('Ya existe un equipo');
  });

  it('edits name and description from the prefilled modal', async () => {
    const { el, render, button, type, fixture, stored, rows } = setup();
    await render();
    button('Editar', rows()[1]).click();
    fixture.detectChanges();
    expect((el.querySelector('#team-name') as HTMLInputElement).value).toBe('Beta');
    type('#team-name', 'Beta 2');
    button('Guardar', el.querySelector('[role="dialog"]')!).click();
    await render();
    expect(stored().teams[1].name).toBe('Beta 2');
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('disables delete while the team has projects', async () => {
    const { render, button, rows, ask } = setup();
    await render();
    const del = button('Eliminar', rows()[0]);
    expect(del.disabled).toBeTrue();
    expect(del.title).toContain('proyectos');
    del.click();
    expect(ask).not.toHaveBeenCalled();
    expect(button('Eliminar', rows()[1]).disabled).toBeFalse();
  });

  it('asks for confirmation before removing a team', async () => {
    const { render, button, rows, ask, stored } = setup();
    await render();
    await Promise.resolve(button('Eliminar', rows()[1]).click());
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored().teams.map((t) => t.id)).toEqual(['t1']);
  });

  it('does not remove the team when the confirmation is declined', async () => {
    const { render, button, rows, stored } = setup(false);
    await render();
    button('Eliminar', rows()[1]).click();
    await render();
    expect(stored().teams.length).toBe(2);
  });

  it('toggles the active state of a team', async () => {
    const { render, button, rows, stored } = setup();
    await render();
    button('Desactivar', rows()[0]).click();
    await render();
    expect(stored().teams[0].active).toBeFalse();
    expect(rows()[0].textContent).toContain('Inactivo');
    button('Activar', rows()[0]).click();
    await render();
    expect(stored().teams[0].active).toBeTrue();
  });

  it('shows the empty state', async () => {
    const { el, render } = setup(true, {});
    await render();
    expect(el.textContent).toContain('Todavía no hay equipos.');
    expect(el.querySelector('table')).toBeNull();
  });
});
