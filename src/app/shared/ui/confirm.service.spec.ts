import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfirmHost } from './confirm-host';
import { ConfirmService } from './confirm.service';

describe('ConfirmService', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(ConfirmService);
  }

  it('resolves true when the user accepts', async () => {
    const confirm = setup();
    const answer = confirm.ask({ title: 'Mover épica', message: '¿Mover ABC-1?' });
    expect(confirm.pending()?.title).toBe('Mover épica');
    confirm.answer(true);
    expect(await answer).toBeTrue();
    expect(confirm.pending()).toBeNull();
  });

  it('resolves false for a previous request replaced by a new one', async () => {
    const confirm = setup();
    const first = confirm.ask({ title: 'A', message: 'a' });
    const second = confirm.ask({ title: 'B', message: 'b' });
    expect(await first).toBeFalse();
    confirm.answer(true);
    expect(await second).toBeTrue();
  });
});

describe('ConfirmHost', () => {
  async function render() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(ConfirmHost);
    const confirm = TestBed.inject(ConfirmService);
    return { fixture, confirm, el: fixture.nativeElement as HTMLElement };
  }

  it('renders nothing without a pending request', async () => {
    const { fixture, el } = await render();
    await fixture.whenStable();
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders an accessible dialog and answers from its buttons', async () => {
    const { fixture, confirm, el } = await render();
    const answer = confirm.ask({ title: 'Eliminar equipo', message: 'No se puede deshacer.', confirmLabel: 'Eliminar' });
    await fixture.whenStable();
    const dialog = el.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain('No se puede deshacer.');
    const buttons = Array.from(dialog.querySelectorAll('button')).filter((b) => b.textContent?.trim() === 'Eliminar');
    buttons[0].click();
    expect(await answer).toBeTrue();
  });

  it('answers false on Escape', async () => {
    const { fixture, confirm, el } = await render();
    const answer = confirm.ask({ title: 'T', message: 'm' });
    await fixture.whenStable();
    const dialog = el.querySelector('[role="dialog"]') as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await answer).toBeFalse();
  });
});
