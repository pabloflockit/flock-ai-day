import { Injectable, computed, inject, signal } from '@angular/core';
import type { IssueRow } from '../../../../shared/contracts.mjs';
import { resolveTarget, type Scope } from '../../../../shared/cache-key.mjs';
import type { AppConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError, TRANSPORT_ERROR } from '../proxy-client';

export type ProxyHealthStatus = 'unknown' | 'checking' | 'ok' | 'error';

export interface ProxyHealthState {
  status: ProxyHealthStatus;
  version: string | null;
  errorMessage: string | null;
}

export type DatasetSource = 'projectIssues' | 'epicIssues';
export type DatasetStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ShardMeta {
  key: string;
  status: 'ok' | 'failed';
  lastOkAt: string | null;
  errorCode?: string | null;
}

export interface StoreError {
  code: string;
  message: string;
}

/** One cached dataset as the proxy serves it, plus the load state of the renderer. */
export interface DatasetState {
  rows: IssueRow[];
  fetchedAt: string | null;
  isCurrent: boolean;
  shardsMeta: ShardMeta[];
  status: DatasetStatus;
  error: StoreError | null;
}

export type ConfigState =
  | { status: 'idle' | 'loading'; config: null; error: null }
  | { status: 'ready'; config: AppConfig; error: null }
  | { status: 'error'; config: null; error: StoreError };

/** Placeholders for the next flows (sync progress, view filters); nothing writes them yet. */
export interface SyncState {
  status: 'idle';
}
export interface ViewState {
  scopeId: string | null;
}

export interface AppState {
  proxyHealth: ProxyHealthState;
  config: ConfigState;
  datasets: Record<string, DatasetState>;
  sync: SyncState;
  view: ViewState;
}

type DatasetView = Pick<DatasetState, 'rows' | 'fetchedAt' | 'isCurrent' | 'shardsMeta'>;

const initialState: AppState = {
  proxyHealth: { status: 'unknown', version: null, errorMessage: null },
  config: { status: 'idle', config: null, error: null },
  datasets: {},
  sync: { status: 'idle' },
  view: { scopeId: null },
};

/** What a dataset looks like before anything was asked for. */
export const EMPTY_DATASET: DatasetState = {
  rows: [],
  fetchedAt: null,
  isCurrent: false,
  shardsMeta: [],
  status: 'idle',
  error: null,
};

const toStoreError = (error: unknown): StoreError =>
  error instanceof ProxyError
    ? { code: error.code, message: error.message }
    : { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };

/** The `scopeId` query parameter is the raw id (a project id, an epic key), not the cache scope. */
const scopeIdParam = (scope: Scope): string => (typeof scope === 'string' ? scope : scope.id);

/** Single source of truth for the renderer (architecture §8.1). */
@Injectable({ providedIn: 'root' })
export class AppStore {
  readonly #proxy = inject(ProxyClient);
  readonly #state = signal<AppState>(initialState);
  /** Cache keys that are loaded or in flight. A transport error removes the key again. */
  readonly #hydratedKeys = new Set<string>();
  readonly #refreshing = new Map<string, Promise<void>>();

  readonly proxyHealth = computed(() => this.#state().proxyHealth);
  readonly configState = computed(() => this.#state().config);
  /** The current normalized configuration, or `null` until `GET /api/config` answered. */
  readonly config = computed(() => this.#state().config.config);
  readonly datasets = computed(() => this.#state().datasets);
  readonly sync = computed(() => this.#state().sync);
  readonly view = computed(() => this.#state().view);

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

  /** Loads the configuration once; a failed load can be retried by calling it again. */
  async loadConfig(): Promise<void> {
    const { status } = this.#state().config;
    if (status === 'loading' || status === 'ready') return;
    this.#setConfig({ status: 'loading', config: null, error: null });
    try {
      const config = await this.#proxy.get<AppConfig>('/api/config');
      this.#setConfig({ status: 'ready', config, error: null });
    } catch (error) {
      this.#setConfig({ status: 'error', config: null, error: toStoreError(error) });
    }
  }

  /** `PUT /api/config`; the store keeps the normalized document the proxy returns. */
  async saveConfig(config: AppConfig): Promise<{ movedKeys: string[] }> {
    const saved = await this.#proxy.put<{ config: AppConfig; movedKeys: string[] }>(
      '/api/config',
      config,
    );
    this.#setConfig({ status: 'ready', config: saved.config, error: null });
    return { movedKeys: saved.movedKeys };
  }

  /** The only way a page derives a dataset key: `resolveTarget`, never by hand (architecture §8.3). */
  cacheKeyFor(source: DatasetSource, scope: Scope, params: unknown): string {
    return resolveTarget(scope, source, params).cacheKey;
  }

  /**
   * Publishes what the proxy already holds for this (source, scope, params): a local read, no
   * Jira call. Pages call it from an `effect()` in their constructor that tracks the active
   * scope, NOT from `ngOnInit`: the scope can change while the page stays mounted.
   *
   * Idempotent per cache key (`Set<string>` of keys loaded or in flight). A TRANSPORT error
   * (the proxy may still be starting) removes the key again so the next call retries; an error
   * the proxy answered with keeps it, so a failing key is not hammered.
   */
  ensureHydrated(source: DatasetSource, scope: Scope, params: unknown): void {
    const cacheKey = this.cacheKeyFor(source, scope, params);
    if (this.#hydratedKeys.has(cacheKey)) return;
    this.#hydratedKeys.add(cacheKey);
    this.#patchDataset(cacheKey, { status: 'loading', error: null });

    const path = `/api/datasets/${source}?scopeId=${encodeURIComponent(scopeIdParam(scope))}`;
    this.#proxy
      .get<DatasetView>(path)
      .then((view) => {
        // A refresh that finished first holds newer rows: never let this read land on top.
        const current = this.#state().datasets[cacheKey];
        if (current?.status === 'ready' && current.fetchedAt !== null) return;
        this.#patchDataset(cacheKey, {
          ...view,
          status: this.#refreshing.has(cacheKey) ? 'loading' : 'ready',
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ProxyError && error.code === TRANSPORT_ERROR) {
          this.#hydratedKeys.delete(cacheKey);
        }
        this.#patchDataset(cacheKey, { status: 'error', error: toStoreError(error) });
      });
  }

  /**
   * `POST /api/datasets/:source/refresh`. On failure the previous rows stay (stale, not empty).
   * Calls for a key that is already refreshing share the same promise.
   */
  refreshDataset(
    source: DatasetSource,
    scope: Scope,
    params: unknown,
    mode: 'delta' | 'full' = 'delta',
  ): Promise<void> {
    const cacheKey = this.cacheKeyFor(source, scope, params);
    const running = this.#refreshing.get(cacheKey);
    if (running) return running;

    this.#hydratedKeys.add(cacheKey);
    this.#patchDataset(cacheKey, { status: 'loading', error: null });
    const scopeId = encodeURIComponent(scopeIdParam(scope));
    const run = this.#proxy
      .post<DatasetView>(`/api/datasets/${source}/refresh?scopeId=${scopeId}&mode=${mode}`)
      .then((view) => this.#patchDataset(cacheKey, { ...view, status: 'ready', error: null }))
      .catch((error: unknown) =>
        this.#patchDataset(cacheKey, { status: 'error', error: toStoreError(error) }),
      )
      .finally(() => this.#refreshing.delete(cacheKey));
    this.#refreshing.set(cacheKey, run);
    return run;
  }

  #setConfig(config: ConfigState): void {
    this.#state.update((s) => ({ ...s, config }));
  }

  #patchDataset(cacheKey: string, patch: Partial<DatasetState>): void {
    this.#state.update((s) => ({
      ...s,
      datasets: {
        ...s.datasets,
        [cacheKey]: { ...(s.datasets[cacheKey] ?? EMPTY_DATASET), ...patch },
      },
    }));
  }
}
