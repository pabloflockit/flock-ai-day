import { Injectable, signal } from '@angular/core';

/** Reference §5 "Overlays": toasts auto-hide after ~1.9 s. */
export const TOAST_DURATION_MS = 1900;
/** Errors stay longer so the message can be read (app decision, docs/decisions.md). */
export const TOAST_ERROR_DURATION_MS = 6000;

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Transient success and error messages, rendered by `ToastHost`. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly #toasts = signal<readonly Toast[]>([]);
  readonly toasts = this.#toasts.asReadonly();
  #nextId = 1;

  show(message: string, kind: ToastKind = 'info'): number {
    const id = this.#nextId++;
    this.#toasts.update((list) => [...list, { id, kind, message }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? TOAST_ERROR_DURATION_MS : TOAST_DURATION_MS);
    return id;
  }

  success(message: string): number {
    return this.show(message, 'success');
  }

  error(message: string): number {
    return this.show(message, 'error');
  }

  dismiss(id: number): void {
    this.#toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
