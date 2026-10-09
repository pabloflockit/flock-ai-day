import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { epicIssuesParams } from '../../../../shared/cache-key.mjs';
import { effectiveCategory } from '../../../../shared/domain/status.mjs';
import { errorMessageEs } from '../../core/error-messages';
import { idle, track, type Op } from '../../core/op';
import { ProxyClient, TRANSPORT_ERROR } from '../../core/proxy-client';
import { AppStore, EMPTY_DATASET, type StoreError } from '../../core/store/app-store';
import { CalendarDatePipe } from '../../shared/pipes/calendar-date.pipe';
import { InstantPipe } from '../../shared/pipes/instant.pipe';
import { CATEGORY_STATE } from '../../shared/ui/state';

const DATA_KEY_INVALID = 'DATA_KEY_INVALID';
const CATEGORY_LABEL = { todo: 'Por hacer', doing: 'En curso', done: 'Hecho' } as const;

/**
 * Diagnostics: proxy health, a Jira connection test and the rows of a test epic. All Jira text is
 * rendered through Angular interpolation (escaped); there are no raw-HTML bindings or sanitizer bypasses.
 */
@Component({
  selector: 'app-diagnostics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InstantPipe, CalendarDatePipe, RouterLink],
  templateUrl: './diagnostics.page.html',
  styleUrl: './diagnostics.page.scss',
})
export class DiagnosticsPage {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);

  readonly health = this.#store.proxyHealth;
  readonly config = this.#store.config;
  readonly configState = this.#store.configState;

  // Connection block: read-only here; it is edited on the connection screen.
  readonly tokenStored = this.#store.tokenStored;
  /** URL, email and token are saved; before that, Jira calls would only answer "not configured". */
  readonly jiraReady = this.#store.jiraReady;
  readonly testConnection = signal<Op<{ displayName: string }>>(idle());

  // Data-key recovery (architecture 4.5).
  readonly reset = signal<Op<{ backupFile: string | null }>>(idle());
  readonly resetResult = computed(() => this.reset().data);
  /** The "Crear base nueva" action is offered only while a visible error says the key cannot decrypt. */
  readonly dataKeyInvalid = computed(() => {
    const errors = [
      this.configState().error,
      this.testConnection().error,
      this.epicCheck().error,
      this.datasetError(),
    ];
    return (
      errors.some((e) => e?.code === DATA_KEY_INVALID) ||
      this.failedShards().some((s) => s.code === DATA_KEY_INVALID)
    );
  });

  // Test epic block.
  readonly epicKey = signal('');
  readonly epicCheck = signal<Op<{ key: string; summary: string }>>(idle());
  readonly mode = signal<'delta' | 'full'>('delta');
  /** The epic whose rows are shown. Hydration follows it (see the constructor effect). */
  readonly activeEpicKey = signal<string | null>(null);
  readonly canFetchRows = computed(
    () =>
      this.jiraReady() &&
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
    return this.epicDataset().rows.map((row) => {
      const categoryKey = config ? effectiveCategory(row, config) : null;
      return {
        row,
        categoryKey,
        category: categoryKey ? CATEGORY_LABEL[categoryKey] : '',
        stateClass: categoryKey ? CATEGORY_STATE[categoryKey] : '',
        measures: Object.entries(row.measures),
      };
    });
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
    void this.#store.loadConnectionStatus();

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

  async resetStorage(): Promise<void> {
    // A plain confirm() for now; the design system modal arrives with flow 2.
    const accepted = window.confirm(
      'Se va a crear una base de datos nueva y vacía. La base actual no se borra: queda guardada con otro nombre (.bak) en la misma carpeta. ¿Continuar?',
    );
    if (!accepted) return;
    const ok = await track(this.reset, () => this.#store.resetStorage());
    if (ok) {
      for (const op of [this.testConnection, this.epicCheck]) {
        op.set(idle());
      }
      this.activeEpicKey.set(null);
    }
  }

  async openInJira(issueKey: string): Promise<void> {
    this.openError.set(null);
    const result = await window.leadershipPanel?.openInJira(issueKey);
    if (result && !result.ok) this.openError.set('No se pudo abrir la issue en Jira.');
  }
}
