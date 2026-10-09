import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
  type WritableSignal,
} from '@angular/core';
import { epicIssuesParams } from '../../../../shared/cache-key.mjs';
import { effectiveCategory } from '../../../../shared/domain/status.mjs';
import { errorMessageEs } from '../../core/error-messages';
import { ProxyClient, ProxyError, TRANSPORT_ERROR } from '../../core/proxy-client';
import { AppStore, EMPTY_DATASET, type StoreError } from '../../core/store/app-store';
import { CalendarDatePipe } from '../../shared/pipes/calendar-date.pipe';
import { InstantPipe } from '../../shared/pipes/instant.pipe';

/** State of one user-triggered call. */
interface Op<T> {
  status: 'idle' | 'loading' | 'ok' | 'error';
  data: T | null;
  error: StoreError | null;
}

const idle = <T>(): Op<T> => ({ status: 'idle', data: null, error: null });

const CATEGORY_LABEL = { todo: 'Por hacer', doing: 'En curso', done: 'Hecho' } as const;

/** Runs `call`, publishing its progress in `target`. Never throws. */
async function track<T>(target: WritableSignal<Op<T>>, call: () => Promise<T>): Promise<boolean> {
  target.set({ status: 'loading', data: null, error: null });
  try {
    target.set({ status: 'ok', data: await call(), error: null });
    return true;
  } catch (error) {
    const code = error instanceof ProxyError ? error.code : 'UNKNOWN';
    const message = error instanceof ProxyError ? error.message : errorMessageEs(code);
    target.set({
      status: 'error',
      data: null,
      error: { code, message: code === TRANSPORT_ERROR ? errorMessageEs(code) : message },
    });
    return false;
  }
}

/**
 * Diagnostics: proxy health, Jira connection and the rows of a test epic. All Jira text is
 * rendered through Angular interpolation (escaped); there are no raw-HTML bindings or sanitizer bypasses.
 */
@Component({
  selector: 'app-diagnostics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InstantPipe, CalendarDatePipe],
  templateUrl: './diagnostics.page.html',
  styleUrl: './diagnostics.page.scss',
})
export class DiagnosticsPage {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);

  readonly health = this.#store.proxyHealth;
  readonly config = this.#store.config;
  readonly configState = this.#store.configState;

  // Connection block.
  readonly baseUrl = linkedSignal(() => this.config()?.jira.baseUrl ?? '');
  readonly email = linkedSignal(() => this.config()?.jira.email ?? '');
  /** Write-only: cleared after saving and never rendered anywhere. */
  readonly token = signal('');
  readonly verify = signal<Op<{ deploymentType: string; baseUrl: string }>>(idle());
  readonly saveConnection = signal<Op<true>>(idle());
  readonly saveToken = signal<Op<true>>(idle());
  readonly testConnection = signal<Op<{ displayName: string }>>(idle());
  readonly canSaveConnection = computed(
    () =>
      this.config() !== null &&
      this.verify().status === 'ok' &&
      this.verify().data?.baseUrl === this.baseUrl().trim(),
  );

  // Test epic block.
  readonly epicKey = signal('');
  readonly epicCheck = signal<Op<{ key: string; summary: string }>>(idle());
  readonly mode = signal<'delta' | 'full'>('delta');
  /** The epic whose rows are shown. Hydration follows it (see the constructor effect). */
  readonly activeEpicKey = signal<string | null>(null);
  readonly canFetchRows = computed(
    () =>
      this.config() !== null &&
      this.epicCheck().status === 'ok' &&
      this.epicCheck().data?.key === this.epicKey().trim(),
  );

  readonly epicDataset = computed(() => {
    const key = this.activeEpicKey();
    const config = this.config();
    if (!key || !config) return EMPTY_DATASET;
    const cacheKey = this.#store.cacheKeyFor(
      'epicIssues',
      { type: 'epic', id: key },
      epicIssuesParams(key, config),
    );
    return this.#store.datasets()[cacheKey] ?? EMPTY_DATASET;
  });

  readonly rows = computed(() => {
    const config = this.config();
    return this.epicDataset().rows.map((row) => ({
      row,
      category: config ? CATEGORY_LABEL[effectiveCategory(row, config)] : '',
      measures: Object.entries(row.measures),
    }));
  });

  readonly failedShards = computed(() =>
    this.epicDataset()
      .shardsMeta.filter((shard) => shard.status === 'failed')
      .map((shard) => {
        const code = shard.errorCode ?? 'UNKNOWN';
        return { key: shard.key, code, message: errorMessageEs(code) };
      }),
  );

  readonly datasetError = computed(() => {
    const error = this.epicDataset().error;
    if (!error) return null;
    return {
      code: error.code,
      message: error.code === TRANSPORT_ERROR ? errorMessageEs(error.code) : error.message,
    };
  });

  /** `openInJira` exists only behind the Electron preload bridge; hidden in a plain browser. */
  readonly canOpenInJira = typeof window.leadershipPanel?.openInJira === 'function';
  readonly openError = signal<string | null>(null);

  constructor() {
    void this.#store.checkProxyHealth();
    void this.#store.loadConfig();

    // The active epic is the scope: hydration must follow it (and the config that is part of the
    // key), so it lives in an effect and not in ngOnInit.
    effect(() => {
      const key = this.activeEpicKey();
      const config = this.config();
      if (!key || !config) return;
      untracked(() =>
        this.#store.ensureHydrated('epicIssues', { type: 'epic', id: key }, epicIssuesParams(key, config)),
      );
    });
  }

  recheck(): void {
    void this.#store.checkProxyHealth();
  }

  async verifyUrl(): Promise<void> {
    const ok = await track(this.verify, () =>
      this.#proxy.post<{ deploymentType: string; baseUrl: string }>('/api/connection/verify', {
        baseUrl: this.baseUrl().trim(),
      }),
    );
    // The input shows the normalized origin the proxy verified, so "verified" is exactly what is saved.
    const verified = this.verify().data;
    if (ok && verified) this.baseUrl.set(verified.baseUrl);
  }

  async saveJiraConnection(): Promise<void> {
    const config = this.config();
    const verified = this.verify().data;
    if (!config || !verified || !this.canSaveConnection()) return;
    await track(this.saveConnection, async () => {
      await this.#store.saveConfig({
        ...config,
        jira: { ...config.jira, baseUrl: verified.baseUrl, email: this.email().trim() },
      });
      return true as const;
    });
  }

  async saveJiraToken(): Promise<void> {
    const value = this.token();
    if (!value.trim()) return;
    const saved = await track(this.saveToken, async () => {
      await this.#proxy.put('/api/connection/token', { token: value });
      return true as const;
    });
    if (saved) this.token.set('');
  }

  async testJiraConnection(): Promise<void> {
    await track(this.testConnection, async () => {
      const me = await this.#proxy.post<{ displayName: string }>('/api/connection/test');
      return { displayName: me.displayName };
    });
  }

  async validateEpic(): Promise<void> {
    const key = this.epicKey().trim();
    const ok = await track(this.epicCheck, () =>
      this.#proxy.get<{ key: string; summary: string }>(
        `/api/jira/epics/${encodeURIComponent(key)}`,
      ),
    );
    if (ok) this.activeEpicKey.set(key);
  }

  async fetchRows(): Promise<void> {
    const key = this.epicCheck().data?.key;
    const config = this.config();
    if (!key || !config) return;
    this.activeEpicKey.set(key);
    await this.#store.refreshDataset(
      'epicIssues',
      { type: 'epic', id: key },
      epicIssuesParams(key, config),
      this.mode(),
    );
  }

  async openInJira(issueKey: string): Promise<void> {
    this.openError.set(null);
    const result = await window.leadershipPanel?.openInJira(issueKey);
    if (result && !result.ok) this.openError.set('No se pudo abrir la issue en Jira.');
  }
}
