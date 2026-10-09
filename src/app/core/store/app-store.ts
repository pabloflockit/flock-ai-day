import { Injectable, computed, inject, signal } from '@angular/core';
import type { IssueRow } from '../../../../shared/contracts.mjs';
import { memberIssuesParams, projectIssuesParams, resolveTarget, type Scope } from '../../../../shared/cache-key.mjs';
import type { AppConfig } from '../../../../proxy/config/normalize.mjs';
import { ProxyClient, ProxyError, TRANSPORT_ERROR } from '../proxy-client';

export type ProxyHealthStatus = 'unknown' | 'checking' | 'ok' | 'error';

export interface ProxyHealthState {
  status: ProxyHealthStatus;
  version: string | null;
  errorMessage: string | null;
}

export type DatasetSource = 'projectIssues' | 'epicIssues' | 'memberIssues';
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

/** Presence of the Jira token and the AI key (`GET /api/connection/status`); `null` until known. */
export interface ConnectionState {
  tokenStored: boolean | null;
  aiKeyStored: boolean | null;
}

export interface AppState {
  proxyHealth: ProxyHealthState;
  config: ConfigState;
  connection: ConnectionState;
  datasets: Record<string, DatasetState>;
  sync: SyncState;
  view: ViewState;
}

/** True when `candidate` is strictly newer than `held`; a null `candidate` never is. */
function isNewer(candidate: string | null, held: string): boolean {
  if (candidate === null) return false;
  return Date.parse(candidate) > Date.parse(held);
}

type DatasetView = Pick<DatasetState, 'rows' | 'fetchedAt' | 'isCurrent' | 'shardsMeta'>;

const initialState: AppState = {
  proxyHealth: { status: 'unknown', version: null, errorMessage: null },
  config: { status: 'idle', config: null, error: null },
  connection: { tokenStored: null, aiKeyStored: null },
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

/** `memberIssues` also needs the period start (`since`), which is part of its params. */
const sinceQuery = (source: DatasetSource, params: unknown): string =>
  source === 'memberIssues' ? `&since=${encodeURIComponent((params as { since: string }).since)}` : '';

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
  readonly tokenStored = computed(() => this.#state().connection.tokenStored);
  readonly aiKeyStored = computed(() => this.#state().connection.aiKeyStored);
  /** URL, email and token are saved: Jira calls can be made (or tested). */
  readonly jiraReady = computed(() => {
    const jira = this.config()?.jira;
    return Boolean(jira?.baseUrl && jira.email && this.tokenStored());
  });
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

  /**
   * Always re-reads `GET /api/config` (a sync run merges Jira-maintained fields into it). The
   * current config stays visible while it loads; a failure keeps it and never throws, and only
   * shows as an error when there was nothing to keep.
   */
  async reloadConfig(): Promise<void> {
    const previous = this.#state().config;
    if (previous.status === 'loading') return;
    if (previous.status !== 'ready') this.#setConfig({ status: 'loading', config: null, error: null });
    try {
      const config = await this.#proxy.get<AppConfig>('/api/config');
      this.#setConfig({ status: 'ready', config, error: null });
    } catch (error) {
      if (previous.status !== 'ready') this.#setConfig({ status: 'error', config: null, error: toStoreError(error) });
    }
  }

  /** Reads whether a Jira token and an AI key are stored. On failure the presence stays unknown (`null`). */
  async loadConnectionStatus(): Promise<void> {
    try {
      const { tokenStored, aiKeyStored } = await this.#proxy.get<{ tokenStored: boolean; aiKeyStored: boolean }>(
        '/api/connection/status',
      );
      this.#state.update((s) => ({ ...s, connection: { tokenStored, aiKeyStored } }));
    } catch {
      this.#state.update((s) => ({ ...s, connection: { tokenStored: null, aiKeyStored: null } }));
    }
  }

  /** `PUT /api/connection/token` (write-only); the value is never kept in the renderer. */
  async saveJiraToken(token: string): Promise<void> {
    await this.#proxy.put('/api/connection/token', { token });
    this.#state.update((s) => ({ ...s, connection: { ...s.connection, tokenStored: true } }));
  }

  /** `PUT /api/ai/key` (write-only); the value is never kept in the renderer. */
  async saveAiKey(key: string): Promise<void> {
    await this.#proxy.put('/api/ai/key', { key });
    this.#state.update((s) => ({ ...s, connection: { ...s.connection, aiKeyStored: true } }));
  }

  /**
   * Data-key recovery: the proxy renames the unreadable database and opens a new one. Everything
   * held in memory belonged to the old database, so hydration and the configuration start over.
   */
  async resetStorage(): Promise<{ backupFile: string | null }> {
    const result = await this.#proxy.post<{ backupFile: string | null }>('/api/storage/reset', {
      confirm: 'RESET',
    });
    this.#hydratedKeys.clear();
    this.#state.update((s) => ({
      ...s,
      config: { status: 'idle', config: null, error: null },
      datasets: {},
    }));
    await this.loadConfig();
    return result;
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
   * the proxy answered with keeps it, so a failing key is not hammered. A read only replaces rows
   * already held when its `fetchedAt` is newer (see `invalidateDatasets`).
   */
  ensureHydrated(source: DatasetSource, scope: Scope, params: unknown): void {
    const cacheKey = this.cacheKeyFor(source, scope, params);
    if (this.#hydratedKeys.has(cacheKey)) return;
    this.#hydratedKeys.add(cacheKey);
    this.#patchDataset(cacheKey, { status: 'loading', error: null });

    const path = `/api/datasets/${source}?scopeId=${encodeURIComponent(scopeIdParam(scope))}${sinceQuery(source, params)}`;
    this.#proxy
      .get<DatasetView>(path)
      .then((view) => {
        // A refresh that finished first holds newer rows: never let an older or equal read land on top.
        const current = this.#state().datasets[cacheKey];
        if (current?.fetchedAt != null && !isNewer(view.fetchedAt, current.fetchedAt)) {
          if (!this.#refreshing.has(cacheKey) && current.status === 'loading') {
            this.#patchDataset(cacheKey, { status: 'ready' });
          }
          return;
        }
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
   * Marks every loaded dataset as stale after a sync run: `#hydratedKeys` is cleared (keys that are
   * refreshing right now are kept, their refresh still lands), so the next `ensureHydrated` per key
   * reads the proxy again. Rows stay visible (stale, not empty) until a read with a newer
   * `fetchedAt` replaces them.
   */
  invalidateDatasets(): void {
    for (const key of [...this.#hydratedKeys]) {
      if (!this.#refreshing.has(key)) this.#hydratedKeys.delete(key);
    }
  }

  /**
   * The `projectIssues` dataset of a configured project: what the proxy holds, never a Jira call.
   * Reactive (reads the config and the datasets). `EMPTY_DATASET` until `ensureProjectIssues` ran;
   * afterwards `status: 'ready'` with `fetchedAt: null` means the project was never synced.
   */
  projectIssues(projectId: string): DatasetState {
    const key = this.#projectIssuesKey(projectId);
    return (key && this.datasets()[key]) || EMPTY_DATASET;
  }

  /** Hydrates the `projectIssues` dataset of a configured project (no-op for an unknown project). */
  ensureProjectIssues(projectId: string): void {
    const config = this.config();
    const project = config?.projects.find((p) => p.id === projectId);
    if (!config || !project) return;
    this.ensureHydrated('projectIssues', project.id, projectIssuesParams(project, config));
  }

  /**
   * Delta refresh of a project's `projectIssues` (no-op for an unknown project). The proxy upgrades
   * it to a full load by itself when the stored payload version is outdated.
   */
  async refreshProjectIssues(projectId: string): Promise<void> {
    const config = this.config();
    const project = config?.projects.find((p) => p.id === projectId);
    if (!config || !project) return;
    await this.refreshDataset('projectIssues', project.id, projectIssuesParams(project, config));
  }

  /** The `memberIssues` dataset of an active team for a period start (`YYYY-MM-DD`), as held. */
  memberIssues(teamId: string, since: string): DatasetState {
    const key = this.#memberIssuesKey(teamId, since);
    return (key && this.datasets()[key]) || EMPTY_DATASET;
  }

  /** Hydrates the team's `memberIssues` for `since` (no-op for an unknown team). */
  ensureMemberIssues(teamId: string, since: string): void {
    const config = this.config();
    const team = config?.teams.find((t) => t.id === teamId);
    if (!config || !team) return;
    this.ensureHydrated('memberIssues', { type: 'team', id: team.id }, memberIssuesParams(team, since, config));
  }

  /** Delta refresh of the team's `memberIssues` for `since` (no-op for an unknown team). */
  async refreshMemberIssues(teamId: string, since: string): Promise<void> {
    const config = this.config();
    const team = config?.teams.find((t) => t.id === teamId);
    if (!config || !team) return;
    await this.refreshDataset('memberIssues', { type: 'team', id: team.id }, memberIssuesParams(team, since, config));
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
      .post<DatasetView>(`/api/datasets/${source}/refresh?scopeId=${scopeId}${sinceQuery(source, params)}&mode=${mode}`)
      .then((view) => this.#patchDataset(cacheKey, { ...view, status: 'ready', error: null }))
      .catch((error: unknown) =>
        this.#patchDataset(cacheKey, { status: 'error', error: toStoreError(error) }),
      )
      .finally(() => this.#refreshing.delete(cacheKey));
    this.#refreshing.set(cacheKey, run);
    return run;
  }

  #projectIssuesKey(projectId: string): string | null {
    const config = this.config();
    const project = config?.projects.find((p) => p.id === projectId);
    return config && project
      ? this.cacheKeyFor('projectIssues', project.id, projectIssuesParams(project, config))
      : null;
  }

  #memberIssuesKey(teamId: string, since: string): string | null {
    const config = this.config();
    const team = config?.teams.find((t) => t.id === teamId);
    return config && team
      ? this.cacheKeyFor('memberIssues', { type: 'team', id: team.id }, memberIssuesParams(team, since, config))
      : null;
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
