import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { normalizeConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyError } from '../../core/proxy-client';
import { ProxyClient } from '../../core/proxy-client';
import { SettingsPage } from './settings.page';

const KEY = 'sk-ant-super-secret';

describe('SettingsPage', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

  function setup(options: { aiKeyStored?: boolean; settings?: Record<string, unknown>; overrides?: Record<string, string>; putKey?: () => Promise<unknown> } = {}) {
    let stored = normalizeConfig({
      jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', statusCategoryOverrides: options.overrides ?? {} },
      settings: options.settings ?? {},
    });
    const proxy = {
      health: () => Promise.resolve({ status: 'ok', version: '1.0.0' }),
      get: jasmine.createSpy('get').and.callFake((path: string) => {
        if (path === '/api/config') return Promise.resolve(stored);
        if (path === '/api/connection/status') {
          return Promise.resolve({ tokenStored: true, aiKeyStored: options.aiKeyStored ?? false });
        }
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
      put: jasmine.createSpy('put').and.callFake((path: string, body: unknown) => {
        if (path === '/api/config') {
          stored = normalizeConfig(body);
          return Promise.resolve({ config: stored, movedKeys: [] });
        }
        if (path === '/api/ai/key') return (options.putKey ?? (() => Promise.resolve({ stored: true })))();
        return Promise.reject(new Error(`unexpected ${path}`));
      }),
    };
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: ProxyClient, useValue: proxy }],
    });
    const fixture = TestBed.createComponent(SettingsPage);
    const el = fixture.nativeElement as HTMLElement;
    const render = async () => {
      await flush();
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
    };
    const type = (selector: string, value: string) => {
      const input = el.querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const button = (text: string) =>
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
    return { fixture, el, proxy, render, type, button, stored: () => stored };
  }

  it('shows the saved business days and saves them through the settings op', async () => {
    const { el, render, type, button, proxy, stored, fixture } = setup({ settings: { staleBusinessDays: 4, agingBusinessDays: 9 } });
    await render();
    expect(el.querySelector('h1')?.textContent).toContain('Configuración general');
    expect((el.querySelector('#stale-days') as HTMLInputElement).value).toBe('4');
    expect((el.querySelector('#aging-days') as HTMLInputElement).value).toBe('9');

    type('#stale-days', '6');
    type('#aging-days', '12');
    button('Guardar días').click();
    await render();
    expect(proxy.put).toHaveBeenCalledWith('/api/config', jasmine.anything());
    expect(stored().settings.staleBusinessDays).toBe(6);
    expect(stored().settings.agingBusinessDays).toBe(12);
    fixture.detectChanges();
    expect(el.querySelector('.field-error')).toBeNull();
  });

  it('shows an inline error per invalid days field and does not save', async () => {
    const { el, render, type, button, proxy } = setup();
    await render();
    type('#stale-days', '0');
    type('#aging-days', '400');
    button('Guardar días').click();
    await render();
    expect(proxy.put).not.toHaveBeenCalled();
    const errors = Array.from(el.querySelectorAll('.field-error')).map((e) => e.textContent);
    expect(errors.length).toBe(2);
    expect(el.querySelector('#stale-days')?.closest('.field')?.querySelector('.field-error')).not.toBeNull();
    expect(el.querySelector('#aging-days')?.closest('.field')?.querySelector('.field-error')).not.toBeNull();
  });

  it('treats an empty days field as invalid', async () => {
    const { el, render, type, button, proxy } = setup();
    await render();
    type('#stale-days', '');
    button('Guardar días').click();
    await render();
    expect(proxy.put).not.toHaveBeenCalled();
    expect(el.querySelector('#stale-days')?.closest('.field')?.querySelector('.field-error')).not.toBeNull();
  });

  it('explains the status mapping lives in Conexión and counts the overrides', async () => {
    const { el, render } = setup({ overrides: { '3': 'doing', '5': 'done' } });
    await render();
    const card = Array.from(el.querySelectorAll('section.card')).find((c) => c.textContent?.includes('Mapeo de estados'))!;
    expect(card.textContent).toContain('2');
    expect(card.querySelector('a[href="/connection"]')).not.toBeNull();
  });

  it('enabling AI saves with the saved days, not unsaved drafts', async () => {
    const { el, render, type, proxy, stored } = setup({ settings: { staleBusinessDays: 4, agingBusinessDays: 9 } });
    await render();
    type('#stale-days', '30');
    const toggle = el.querySelector('#ai-enabled') as HTMLInputElement;
    toggle.click();
    await render();
    expect(proxy.put).toHaveBeenCalledTimes(1);
    expect(stored().settings.ai.enabled).toBeTrue();
    expect(stored().settings.staleBusinessDays).toBe(4);
  });

  it('API key is write-only: sent once, cleared, never rendered', async () => {
    const { el, render, type, button, proxy, fixture } = setup({ aiKeyStored: false });
    await render();
    expect(el.textContent).toContain('Cargá la API key');
    type('#ai-key', KEY);
    button('Guardar API key').click();
    await render();
    expect(proxy.put).toHaveBeenCalledWith('/api/ai/key', { key: KEY });
    expect((el.querySelector('#ai-key') as HTMLInputElement).value).toBe('');
    expect(el.textContent).toContain('Reemplazar API key');
    expect(el.innerHTML).not.toContain(KEY);
    fixture.detectChanges();
  });

  it('with a stored key the label asks to replace it and never shows it', async () => {
    const { el, render } = setup({ aiKeyStored: true });
    await render();
    expect(el.textContent).toContain('Reemplazar API key');
    expect((el.querySelector('#ai-key') as HTMLInputElement).value).toBe('');
  });

  it('hints that reports need a key when AI is on without one', async () => {
    const { el, render } = setup({ aiKeyStored: false, settings: { ai: { enabled: true } } });
    await render();
    expect(el.textContent).toContain('necesitan la API key');
    TestBed.resetTestingModule();

    const withKey = setup({ aiKeyStored: true, settings: { ai: { enabled: true } } });
    await withKey.render();
    expect(withKey.el.textContent).not.toContain('necesitan la API key');
  });

  it('keeps the typed key and shows a Spanish message when saving the key fails', async () => {
    const { el, render, type, button } = setup({
      putKey: () => Promise.reject(new ProxyError('VALIDATION_ERROR', 'raw')),
    });
    await render();
    type('#ai-key', KEY);
    button('Guardar API key').click();
    await render();
    expect(el.textContent).toContain('Los datos enviados no son válidos.');
    expect(el.textContent).not.toContain('VALIDATION_ERROR');
    expect(el.textContent).toContain('Cargá la API key');
  });
});
