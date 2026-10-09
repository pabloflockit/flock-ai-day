import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TOAST_DURATION_MS, TOAST_ERROR_DURATION_MS, ToastService } from './toast.service';

describe('ToastService', () => {
  let toasts: ToastService;

  beforeEach(() => {
    jasmine.clock().install();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => jasmine.clock().uninstall());

  it('shows a toast and hides it after the reference duration', () => {
    toasts.show('Guardado');
    expect(toasts.toasts().map((t) => t.message)).toEqual(['Guardado']);
    jasmine.clock().tick(TOAST_DURATION_MS - 1);
    expect(toasts.toasts().length).toBe(1);
    jasmine.clock().tick(1);
    expect(toasts.toasts().length).toBe(0);
  });

  it('keeps error toasts longer so they can be read', () => {
    toasts.error('Falló la conexión');
    jasmine.clock().tick(TOAST_DURATION_MS);
    expect(toasts.toasts()[0]).toEqual(jasmine.objectContaining({ kind: 'error' }));
    jasmine.clock().tick(TOAST_ERROR_DURATION_MS - TOAST_DURATION_MS);
    expect(toasts.toasts().length).toBe(0);
  });

  it('dismisses a toast by id', () => {
    const id = toasts.success('Listo');
    toasts.dismiss(id);
    expect(toasts.toasts().length).toBe(0);
  });
});
