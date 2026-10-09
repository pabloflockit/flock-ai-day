import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface Pending extends Required<ConfirmRequest> {
  resolve: (accepted: boolean) => void;
}

/**
 * Confirmation dialogs (delete, move epic, reassign project), rendered by `ConfirmHost`.
 * Only one request is open at a time; a new request cancels the previous one.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly #pending = signal<Pending | null>(null);
  readonly pending = this.#pending.asReadonly();

  ask(request: ConfirmRequest): Promise<boolean> {
    this.#pending()?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.#pending.set({
        confirmLabel: 'Confirmar',
        cancelLabel: 'Cancelar',
        ...request,
        resolve,
      });
    });
  }

  answer(accepted: boolean): void {
    const pending = this.#pending();
    if (!pending) return;
    this.#pending.set(null);
    pending.resolve(accepted);
  }
}
