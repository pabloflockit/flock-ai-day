import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { ProjectDetailPage } from './project-detail.page';

const epic = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  issueTypeId: '10000',
  summary: `Resumen ${key}`,
  active: true,
  ...extra,
});

const seed = () => ({
  jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c' },
  teams: [
    { id: 't1', name: 'Alfa', members: [] },
    { id: 't2', name: 'Beta', members: [] },
  ],
  projects: [
    {
      id: 'p1',
      teamId: 't1',
      name: 'Portal',
      description: 'El portal',
      workUnit: 'task',
      measure: { kind: 'count' },
      epics: [epic('PRT-1', { linkMethodUsed: 'parent' }), epic('PRT-2', { active: false }), epic('PRT-3')],
    },
    { id: 'p2', teamId: 't1', name: 'Vacío', workUnit: 'task', measure: { kind: 'count' }, epics: [] },
    { id: 'p3', teamId: 't2', name: 'Otro', workUnit: 'task', measure: { kind: 'count' }, epics: [epic('OTH-1')] },
  ],
});

const FIELDS = [
  { id: 'customfield_10016', name: 'Story points', custom: true, schema: { type: 'number' } },
  { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string' } },
  { id: 'customfield_10020', name: 'Esfuerzo', custom: true, schema: { type: 'number' } },
];

const SHARDS = {
  fetchedAt: '2026-03-02T15:30:00.000Z',
  isCurrent: true,
  shardsMeta: [
    { key: 'PRT-1', status: 'ok', lastOkAt: '2026-03-02T15:30:00.000Z' },
    { key: 'PRT-2', status: 'failed', lastOkAt: null, errorCode: 'FORBIDDEN' },
  ],
};

describe('ProjectDetailPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  interface Options {
    id?: string;
    confirm?: boolean;
    tokenStored?: boolean;
    datasets?: () => Promise<unknown>;
    epicInfo?: (key: string) => Promise<unknown>;
  }

  function setup(options: Options = {}) {
    const { id = 'p1', confirm = true, tokenStored = true } = options;
    let stored = normalizeConfig(seed());
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(stored);
        if (path === '/api/connection/status') return Promise.resolve({ tokenStored });
        if (path === '/api/jira/fields') return Promise.resolve(FIELDS);
        if (path.startsWith('/api/datasets/projectIssues/meta?scopeId=')) return (options.datasets ?? (() => Promise.resolve(SHARDS)))();
        if (path.startsWith('/api/jira/epics/')) {
          const key = decodeURIComponent(path.slice('/api/jira/epics/'.length));
          return (options.epicInfo ?? ((k: string) => Promise.resolve({ key: k, summary: `Nueva ${k}`, issueTypeId: '10001' })))(key);
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      put: jasmine.createSpy('put').and.callFake((_path: string, body: unknown) => {
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
        { provide: ActivatedRoute, useValue: { paramMap: new BehaviorSubject(convertToParamMap({ id })) } },
      ],
    });
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.returnValue(Promise.resolve(true));
    const fixture = TestBed.createComponent(ProjectDetailPage);
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
    const choose = (selector: string, value: string) => {
      const select = el.querySelector(selector) as HTMLSelectElement;
      select.value = value;
      select.dispatchEvent(new Event('change'));
    };
    const click = (selector: string) => (el.querySelector(selector) as HTMLElement).click();
    return { fixture, el, proxy, ask, navigate, render, button, rows, type, choose, click, stored: () => stored };
  }

  it('renders the header, team link and epics with their sync state', async () => {
    const { el, render, rows } = setup();
    await render();
    expect(el.querySelector('h1')?.textContent).toContain('Portal');
    expect(el.querySelector('h1 .state-done')?.textContent).toContain('Activo');
    expect(el.querySelector('a[href="/teams/t1"]')?.textContent).toContain('Alfa');
    expect(rows().length).toBe(3);

    expect(rows()[0].textContent).toContain('PRT-1');
    expect(rows()[0].textContent).toContain('Resumen PRT-1');
    expect(rows()[0].querySelector('.text-mono')).not.toBeNull();
    expect(rows()[0].textContent).toContain('/26');
    expect(rows()[0].textContent).toContain('Parent');
    expect(rows()[1].querySelector('.state-pending')?.textContent).toContain('Inactiva');
    expect(rows()[1].querySelector('.state-blocked')?.textContent?.trim()).toBe('Falló');
    expect(rows()[1].textContent).toContain('Tu usuario no tiene permiso para ver este recurso en Jira.');
    expect(rows()[1].textContent).not.toContain('FORBIDDEN');
    expect(rows()[2].textContent).toContain('Sin sincronizar');
    expect(rows()[2].textContent).toContain('Sin detectar');
  });

  it('survives a failed dataset load', async () => {
    const { el, render, rows } = setup({ datasets: () => Promise.reject(new ProxyError('CACHE_MISS', 'x')) });
    await render();
    expect(rows().length).toBe(3);
    expect(el.textContent).toContain('Sin datos de sincronización');
    expect(rows()[0].textContent).toContain('Sin sincronizar');
  });

  it('shows a message for an unknown project', async () => {
    const { el, render } = setup({ id: 'nope' });
    await render();
    expect(el.textContent).toContain('El proyecto no existe.');
  });

  it('edits name and description from the modal', async () => {
    const { el, render, button, type, fixture, stored } = setup();
    await render();
    button('Editar').click();
    fixture.detectChanges();
    expect((el.querySelector('#project-name') as HTMLInputElement).value).toBe('Portal');
    type('#project-name', 'Portal 2');
    type('#project-description', 'Nueva');
    button('Guardar', el.querySelector('[role="dialog"]')!).click();
    await render();
    expect(stored().projects[0].name).toBe('Portal 2');
    expect(stored().projects[0].description).toBe('Nueva');
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the modal open with the field error on a duplicate name', async () => {
    const { el, render, button, type, fixture, proxy } = setup();
    await render();
    button('Editar').click();
    fixture.detectChanges();
    type('#project-name', 'Vacío');
    button('Guardar', el.querySelector('[role="dialog"]')!).click();
    await render();
    expect(proxy.put).not.toHaveBeenCalled();
    expect(el.querySelector('[role="dialog"] .field-error')).not.toBeNull();
  });

  it('deactivates and reactivates the project', async () => {
    const { el, render, button, stored } = setup();
    await render();
    button('Desactivar').click();
    await render();
    expect(stored().projects[0].active).toBeFalse();
    expect(el.querySelector('h1 .state-pending')?.textContent).toContain('Inactivo');
    button('Activar').click();
    await render();
    expect(stored().projects[0].active).toBeTrue();
  });

  it('reassigns the project to another team after confirmation', async () => {
    const { render, button, choose, ask, stored } = setup();
    await render();
    expect(button('Cambiar de equipo').disabled).toBeTrue();
    choose('#reassign-team', 't2');
    await render();
    button('Cambiar de equipo').click();
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored().projects[0].teamId).toBe('t2');
  });

  it('does not reassign when the confirmation is declined', async () => {
    const { render, button, choose, stored } = setup({ confirm: false });
    await render();
    choose('#reassign-team', 't2');
    await render();
    button('Cambiar de equipo').click();
    await render();
    expect(stored().projects[0].teamId).toBe('t1');
  });

  it('blocks deleting a project that has epics and shows the guard message', async () => {
    const { el, render, button, ask, proxy, navigate } = setup();
    await render();
    button('Eliminar proyecto').click();
    await render();
    expect(ask).not.toHaveBeenCalled();
    expect(proxy.put).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(el.querySelector('.delete-error')?.textContent).toContain('épica');
  });

  it('deletes an empty project after confirmation and goes back to the team', async () => {
    const { render, button, ask, stored, navigate } = setup({ id: 'p2' });
    await render();
    button('Eliminar proyecto').click();
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored().projects.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(navigate).toHaveBeenCalledWith(['/teams', 't1']);
  });

  it('saves the measurement as count with a different unit', async () => {
    const { render, button, click, stored } = setup();
    await render();
    click('#unit-both');
    await render();
    button('Guardar medición').click();
    await render();
    expect(stored().projects[0].workUnit).toBe('both');
    expect(stored().projects[0].measure).toEqual({ kind: 'count' });
  });

  it('loads numeric fields lazily and saves a field measure', async () => {
    const { el, render, button, click, choose, proxy, stored } = setup();
    await render();
    expect(proxy.get).not.toHaveBeenCalledWith('/api/jira/fields');
    click('#measure-field');
    await render();
    expect(proxy.get).toHaveBeenCalledWith('/api/jira/fields');
    const options = Array.from(el.querySelectorAll('#measure-field-select option')).map((o) => o.textContent?.trim());
    expect(options).toContain('Story points');
    expect(options).not.toContain('Summary');
    expect(button('Guardar medición').disabled).toBeTrue();

    choose('#measure-field-select', 'customfield_10016');
    await render();
    button('Guardar medición').click();
    await render();
    expect(stored().projects[0].measure).toEqual({
      kind: 'field',
      fieldId: 'customfield_10016',
      fieldName: 'Story points',
      valueType: 'number',
    });
  });

  it('hints at the connection instead of loading fields when Jira is not ready', async () => {
    const { el, render, click, proxy } = setup({ tokenStored: false });
    await render();
    click('#measure-field');
    await render();
    expect(proxy.get).not.toHaveBeenCalledWith('/api/jira/fields');
    expect(el.querySelector('a[href="/connection"]')).not.toBeNull();
  });

  it('adds an epic validated against Jira', async () => {
    const { el, fixture, render, button, type, proxy, stored } = setup();
    await render();
    type('#epic-key', '  prt-9 ');
    fixture.detectChanges();
    button('Agregar').click();
    await render();
    expect(proxy.get).toHaveBeenCalledWith('/api/jira/epics/PRT-9');
    const added = stored().projects[0].epics.at(-1);
    expect(added).toEqual(jasmine.objectContaining({ key: 'PRT-9', issueTypeId: '10001', summary: 'Nueva PRT-9' }));
    expect((el.querySelector('#epic-key') as HTMLInputElement).value).toBe('');
  });

  it('shows the endpoint error inline when the key is not an epic', async () => {
    const { el, render, button, type, proxy } = setup({
      epicInfo: () => Promise.reject(new ProxyError('NOT_AN_EPIC', 'PRT-9 no es una épica.')),
    });
    await render();
    type('#epic-key', 'PRT-9');
    button('Agregar').click();
    await render();
    expect(proxy.put).not.toHaveBeenCalled();
    expect(el.querySelector('.epic-error')?.textContent).toContain('PRT-9 no es una épica.');
  });

  it('asks to move an epic owned by another project and moves it', async () => {
    const { render, button, type, ask, stored } = setup();
    await render();
    type('#epic-key', 'oth-1');
    button('Agregar').click();
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.calls.mostRecent().args[0].message).toContain('Otro');
    expect(stored().projects[2].epics).toEqual([]);
    expect(stored().projects[0].epics.map((e) => e.key)).toContain('OTH-1');
  });

  it('leaves the epic where it is when the move is declined', async () => {
    const { render, button, type, stored } = setup({ confirm: false });
    await render();
    type('#epic-key', 'OTH-1');
    button('Agregar').click();
    await render();
    expect(stored().projects[2].epics.map((e) => e.key)).toEqual(['OTH-1']);
  });

  it('drops a stale validation when the key changed meanwhile', async () => {
    let resolve!: (value: unknown) => void;
    const { render, button, type, proxy, stored } = setup({ epicInfo: () => new Promise((r) => (resolve = r)) });
    await render();
    type('#epic-key', 'PRT-8');
    button('Agregar').click();
    await flush();
    type('#epic-key', 'PRT-7');
    resolve({ key: 'PRT-8', summary: 'x', issueTypeId: '1' });
    await render();
    expect(proxy.put).not.toHaveBeenCalled();
    expect(stored().projects[0].epics.length).toBe(3);
  });

  it('toggles an epic', async () => {
    const { render, button, rows, stored } = setup();
    await render();
    button('Desactivar', rows()[0]).click();
    await render();
    expect(stored().projects[0].epics[0].active).toBeFalse();
    button('Activar', rows()[0]).click();
    await render();
    expect(stored().projects[0].epics[0].active).toBeTrue();
  });

  it('moves an epic to another project', async () => {
    const { render, button, rows, choose, stored } = setup();
    await render();
    choose('select.move-select', 'p2');
    await render();
    button('Mover', rows()[0]).click();
    await render();
    expect(stored().projects[1].epics.map((e) => e.key)).toEqual(['PRT-1']);
    expect(stored().projects[0].epics.map((e) => e.key)).toEqual(['PRT-2', 'PRT-3']);
  });

  it('removes an epic after confirmation', async () => {
    const { render, button, rows, ask, stored } = setup();
    await render();
    button('Quitar', rows()[0]).click();
    await render();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stored().projects[0].epics.map((e) => e.key)).toEqual(['PRT-2', 'PRT-3']);
  });
});
