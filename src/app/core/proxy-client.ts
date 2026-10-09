import { Injectable } from '@angular/core';
import type { ApiEnvelope, HealthData } from '../../../shared/contracts.mjs';

declare global {
  interface Window {
    /** Exposed by electron/preload.cjs. Absent in a plain browser. */
    leadershipPanel?: { proxyBaseUrl?: string };
  }
}

/** Used when the preload bridge is absent (e.g. `ng serve` in a regular browser). */
export const DEV_PROXY_BASE_URL = 'http://127.0.0.1:3100';

export class ProxyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class ProxyClient {
  readonly baseUrl = window.leadershipPanel?.proxyBaseUrl ?? DEV_PROXY_BASE_URL;

  health(): Promise<HealthData> {
    return this.get<HealthData>('/api/health');
  }

  /** Unwraps the `{ ok, data | error }` envelope; transport failures become `TRANSPORT_ERROR`. */
  async get<T>(path: string): Promise<T> {
    let envelope: ApiEnvelope;
    try {
      const response = await fetch(`${this.baseUrl}${path}`);
      envelope = (await response.json()) as ApiEnvelope;
    } catch (error) {
      throw new ProxyError('TRANSPORT_ERROR', error instanceof Error ? error.message : String(error));
    }
    if (!envelope.ok) {
      throw new ProxyError(envelope.error.code, envelope.error.message);
    }
    return envelope.data as T;
  }
}
