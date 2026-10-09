import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { AppConfig } from '../../../proxy/config/normalize.mjs';
import { normalizeConfig } from '../../../proxy/config/normalize.mjs';
import { addTeam } from '../../../shared/config-edit.mjs';
import { ToastService } from '../shared/ui/toast.service';
import { ConfigEditor } from './config-editor';
import { ProxyError } from './proxy-client';
import { AppStore } from './store/app-store';

describe('ConfigEditor', () => {
  const initial = normalizeConfig({ teams: [{ id: 't1', name: 'Equipo Norte' }] }) as AppConfig;

  function setup(saveConfig: (c: AppConfig) => Promise<{ movedKeys: string[] }>) {
    const config = signal<AppConfig | null>(initial);
    const toasts = jasmine.createSpyObj<ToastService>('ToastService', ['success', 'error']);
    const save = jasmine.createSpy('saveConfig').and.callFake(saveConfig);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AppStore, useValue: { config, saveConfig: save } },
        { provide: ToastService, useValue: toasts },
      ],
    });
    return { editor: TestBed.inject(ConfigEditor), save, toasts };
  }

  it('saves the edited config and confirms with a toast', async () => {
    const { editor, save, toasts } = setup(async () => ({ movedKeys: [] }));
    const result = await editor.apply((c) => addTeam(c, { id: 't2', name: 'Pagos' }), 'Equipo creado.');
    expect(result.ok).toBeTrue();
    expect((save.calls.mostRecent().args[0] as AppConfig).teams.map((t) => t.name)).toEqual(['Equipo Norte', 'Pagos']);
    expect(toasts.success).toHaveBeenCalledWith('Equipo creado.');
  });

  it('does not save when the edit is rejected locally', async () => {
    const { editor, save, toasts } = setup(async () => ({ movedKeys: [] }));
    const result = await editor.apply((c) => addTeam(c, { id: 't2', name: 'equipo norte' }));
    expect(result).toEqual({ ok: false, issues: [jasmine.objectContaining({ code: 'TEAM_NAME_DUPLICATE' })] });
    expect(save).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith('Ya existe un equipo llamado "equipo norte".');
  });

  it('returns the proxy validation issues', async () => {
    const issues = [{ code: 'EPIC_DUPLICATE', path: 'projects[0].epics[1].key', message: 'dup' }];
    const { editor, toasts } = setup(() =>
      Promise.reject(new ProxyError('VALIDATION_FAILED', 'invalid', { issues })),
    );
    const result = await editor.apply((c) => addTeam(c, { id: 't2', name: 'Pagos' }));
    expect(result).toEqual({ ok: false, issues });
    expect(toasts.error).toHaveBeenCalledWith('dup');
  });

  it('maps any other failure to a single issue', async () => {
    const { editor, toasts } = setup(() => Promise.reject(new ProxyError('TRANSPORT_ERROR', 'down')));
    const result = await editor.apply((c) => addTeam(c, { id: 't2', name: 'Pagos' }));
    expect(result).toEqual({ ok: false, issues: [{ code: 'TRANSPORT_ERROR', path: '', message: 'down' }] });
    expect(toasts.error).toHaveBeenCalledWith('down');
  });
});
