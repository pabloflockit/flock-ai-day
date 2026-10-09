import { Injectable, computed, inject, signal } from '@angular/core';
import { ProxyClient } from '../proxy-client';

export type ProxyHealthStatus = 'unknown' | 'checking' | 'ok' | 'error';

export interface ProxyHealthState {
  status: ProxyHealthStatus;
  version: string | null;
  errorMessage: string | null;
}

export interface AppState {
  proxyHealth: ProxyHealthState;
}

const initialState: AppState = {
  proxyHealth: { status: 'unknown', version: null, errorMessage: null },
};

/** Single source of truth for the renderer (architecture §8.1). */
@Injectable({ providedIn: 'root' })
export class AppStore {
  readonly #proxy = inject(ProxyClient);
  readonly #state = signal<AppState>(initialState);

  readonly proxyHealth = computed(() => this.#state().proxyHealth);

  async checkProxyHealth(): Promise<void> {
    this.#state.update((s) => ({ ...s, proxyHealth: { ...s.proxyHealth, status: 'checking' } }));
    try {
      const data = await this.#proxy.health();
      this.#state.update((s) => ({
        ...s,
        proxyHealth: { status: 'ok', version: data.version, errorMessage: null },
      }));
    } catch (error) {
      this.#state.update((s) => ({
        ...s,
        proxyHealth: {
          status: 'error',
          version: null,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }
}
