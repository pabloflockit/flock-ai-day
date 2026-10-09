import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { errorMessageEs } from '../../core/error-messages';
import { idle, toOpError, track, type Op } from '../../core/op';
import { ProxyClient, ProxyError } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';
import { ConfirmService } from '../../shared/ui/confirm.service';

/** How often `GET /api/sync/status` is read while a run is in progress. */
export const SYNC_POLL_MS = 1000;

type SyncMode = 'delta' | 'full';

interface Counter {
  total: number;
  done: number;
  failed: number;
}

export interface SyncStatus {
  runId: string | null;
  state: 'idle' | 'running' | 'done' | 'error';
  mode: SyncMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  projects: Counter;
  members: Counter;
  failedEpics: { projectId: string; key: string; errorCode: string }[];
  error: { code: string; message: string } | null;
}

interface ProjectMeta {
  fetchedAt: string | null;
  isCurrent: boolean;
  shardsMeta: { key: string; status: 'ok' | 'failed'; lastOkAt: string | null; errorCode?: string | null }[];
}

const MODE_LABEL: Record<SyncMode, string> = { delta: 'Incremental', full: 'Carga completa' };

/**
 * Sync (plan §6.1.7): start a delta or full run, follow it by polling `/api/sync/status` while it
 * runs, and see per project when its data is from and which epics failed.
 */
@Component({
  selector: 'app-sync-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './sync.page.html',
  styleUrl: './sync.page.scss',
})
export class SyncPage {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);
  readonly #confirm = inject(ConfirmService);
  #destroyed = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #metaRun = 0;

  readonly configState = this.#store.configState;
  readonly jiraReady = this.#store.jiraReady;

  readonly status = signal<SyncStatus | null>(null);
  readonly statusError = signal<string | null>(null);
  readonly startError = signal<string | null>(null);
  readonly starting = signal(false);
  readonly running = computed(() => this.status()?.state === 'running');
  readonly canStart = computed(() => this.jiraReady() && !this.running() && !this.starting());

  /** Active projects of active teams, the ones a sync covers. */
  readonly projects = computed(() => {
    const config = this.#store.config();
    if (!config) return [];
    return config.projects
      .filter((p) => p.active)
      .flatMap((p) => {
        const team = config.teams.find((t) => t.id === p.teamId && t.active);
        return team ? [{ id: p.id, name: p.name, teamName: team.name }] : [];
      });
  });
  readonly #projectIds = computed(() => this.projects().map((p) => p.id).join('\n'));
  readonly metas = signal<Record<string, Op<ProjectMeta>>>({});

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.#destroyed = true;
      this.#stopPolling();
    });
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
    void this.#loadStatus();

    // Reload the per-project data only when the set of projects changes (not on every config save).
    effect(() => {
      this.#projectIds();
      untracked(() => void this.#loadMetas());
    });
  }

  modeLabel(mode: SyncMode | null): string {
    return mode ? MODE_LABEL[mode] : '—';
  }

  formatDate(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  errorMessage(code: string | null): string {
    return errorMessageEs(code ?? 'UNKNOWN');
  }

  /** Processed units (done or failed) over the total, for the bar. */
  processed(counter: Counter): number {
    return counter.done + counter.failed;
  }

  percent(counter: Counter): number {
    return counter.total > 0 ? Math.min(100, Math.round((this.processed(counter) / counter.total) * 100)) : 0;
  }

  projectName(projectId: string): string {
    return this.#store.config()?.projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  failedShards(meta: ProjectMeta | null): ProjectMeta['shardsMeta'] {
    return meta?.shardsMeta.filter((s) => s.status === 'failed') ?? [];
  }

  async start(mode: SyncMode): Promise<void> {
    if (!this.canStart()) return;
    if (mode === 'full') {
      const accepted = await this.#confirm.ask({
        title: 'Carga completa',
        message:
          'La carga completa vuelve a descargar todos los datos de Jira y puede tardar bastante. ¿Querés continuar?',
        confirmLabel: 'Cargar todo',
      });
      if (!accepted || this.#destroyed || !this.canStart()) return;
    }
    this.starting.set(true);
    this.startError.set(null);
    try {
      const status = await this.#proxy.post<SyncStatus>('/api/sync', { mode });
      if (!this.#destroyed) this.#apply(status);
    } catch (error) {
      if (!this.#destroyed) this.startError.set(errorMessageEs(toOpError(error).code));
    } finally {
      this.starting.set(false);
    }
  }

  async #loadStatus(): Promise<void> {
    try {
      const status = await this.#proxy.get<SyncStatus>('/api/sync/status');
      if (!this.#destroyed) this.#apply(status);
    } catch (error) {
      if (!this.#destroyed) this.statusError.set(errorMessageEs(toOpError(error).code));
    }
  }

  /** Publishes a status, keeps the timer in step with `running`, and refreshes the data when a run ends. */
  #apply(status: SyncStatus): void {
    const wasRunning = this.running();
    this.status.set(status);
    this.statusError.set(null);
    if (status.state === 'running') this.#startPolling();
    else {
      this.#stopPolling();
      if (wasRunning) {
        void this.#store.reloadConfig();
        void this.#loadMetas();
      }
    }
  }

  #startPolling(): void {
    if (this.#timer !== null || this.#destroyed) return;
    this.#timer = setInterval(() => void this.#poll(), SYNC_POLL_MS);
  }

  #stopPolling(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One poll at a time; a transient failure keeps the timer so the next tick retries. */
  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const status = await this.#proxy.get<SyncStatus>('/api/sync/status');
      if (!this.#destroyed) this.#apply(status);
    } catch (error) {
      if (!(error instanceof ProxyError) && !this.#destroyed) this.statusError.set(errorMessageEs('UNKNOWN'));
    } finally {
      this.#polling = false;
    }
  }

  /** Reads the data date and shard state of every listed project; each one fails on its own. */
  async #loadMetas(): Promise<void> {
    const run = ++this.#metaRun;
    const ids = this.projects().map((p) => p.id);
    this.metas.set(Object.fromEntries(ids.map((id) => [id, { status: 'loading', data: null, error: null } as Op<ProjectMeta>])));
    await Promise.all(
      ids.map(async (id) => {
        const target = signal<Op<ProjectMeta>>(idle());
        await track(target, () =>
          this.#proxy.get<ProjectMeta>(`/api/datasets/projectIssues/meta?scopeId=${encodeURIComponent(id)}`),
        );
        // A newer load or a destroyed page makes this answer stale.
        if (run === this.#metaRun && !this.#destroyed) this.metas.update((all) => ({ ...all, [id]: target() }));
      }),
    );
  }
}
