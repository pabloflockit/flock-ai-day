import type { WritableSignal } from '@angular/core';
import { errorMessageEs } from './error-messages';
import { ProxyError, TRANSPORT_ERROR } from './proxy-client';
import type { StoreError } from './store/app-store';

/** State of one user-triggered call. */
export interface Op<T> {
  status: 'idle' | 'loading' | 'ok' | 'error';
  data: T | null;
  error: StoreError | null;
}

export const idle = <T>(): Op<T> => ({ status: 'idle', data: null, error: null });

/** A proxy error as the UI shows it; transport failures get the Spanish message. */
export function toOpError(error: unknown): StoreError {
  const code = error instanceof ProxyError ? error.code : 'UNKNOWN';
  const message = error instanceof ProxyError ? error.message : errorMessageEs(code);
  return { code, message: code === TRANSPORT_ERROR ? errorMessageEs(code) : message };
}

/** Runs `call`, publishing its progress in `target`. Never throws. */
export async function track<T>(target: WritableSignal<Op<T>>, call: () => Promise<T>): Promise<boolean> {
  target.set({ status: 'loading', data: null, error: null });
  try {
    target.set({ status: 'ok', data: await call(), error: null });
    return true;
  } catch (error) {
    target.set({ status: 'error', data: null, error: toOpError(error) });
    return false;
  }
}
