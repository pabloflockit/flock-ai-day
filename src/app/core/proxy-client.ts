import { Injectable } from '@angular/core';
import type { ApiEnvelope, HealthData } from '../../../shared/contracts.mjs';

declare global {
  interface Window {
    /** Exposed by electron/preload.cjs. Absent in a plain browser. */
    leadershipPanel?: {
      proxyBaseUrl?: string;
      proxySecret?: string;
      openInJira(issueKey: string): Promise<{ ok: boolean; error?: string }>;
      copyText(text: string): Promise<{ ok: boolean; error?: string }>;
      saveMarkdown(
        suggestedName: string,
        content: string,
      ): Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
    };
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
  readonly #secret = window.leadershipPanel?.proxySecret;

  health(): Promise<HealthData> {
    return this.get<HealthData>('/api/health');
  }

  /** Unwraps the `{ ok, data | error }` envelope; transport failures become `TRANSPORT_ERROR`. */
  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  /** Write-only secret endpoints answer `{ stored: true }`; the value is never read back. */
  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  /** Every request carries the per-launch session secret. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let envelope: ApiEnvelope;
    try {
      const headers: Record<string, string> = {};
      if (this.#secret) headers['X-Proxy-Secret'] = this.#secret;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      envelope = (await response.json()) as ApiEnvelope;
    } catch (error) {
      throw new ProxyError(
        'TRANSPORT_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!envelope.ok) {
      throw new ProxyError(envelope.error.code, envelope.error.message);
    }
    return envelope.data as T;
  }
}
