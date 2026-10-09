import { ChangeDetectionStrategy, Component, computed, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { checkNarrativeFigures, narrativeInput, parseNarrative } from '../../../../shared/domain/ai-narrative.mjs';
import { defaultPeriod } from '../../../../shared/domain/reports.mjs';
import { buildSprintClose } from '../../../../shared/domain/sprint-close.mjs';
import { renderSprintCloseHtml } from '../../../../shared/domain/sprint-close-html.mjs';
import { ProxyClient } from '../../core/proxy-client';
import { AppStore, EMPTY_DATASET } from '../../core/store/app-store';
import { InstantPipe } from '../../shared/pipes/instant.pipe';
import { ToastService } from '../../shared/ui/toast.service';

type StatusInfo = { id: string; name: string; statusCategory: 'todo' | 'doing' | 'done' | null };

/** Lowercase ASCII slug for file names ("Equipo Nandu" style, accents stripped). */
function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'equipo'
  );
}

/**
 * Sprint close (odd/tasks/sprint-report.md, task 5b): the layered close report of the selected team
 * for a free date range. Reads what the proxy holds (team projects + `memberIssues` since `from`),
 * builds the model with the pure domain, previews the standalone HTML and exports it.
 */
@Component({
  selector: 'app-sprint-close-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InstantPipe],
  templateUrl: './sprint-close.page.html',
  styleUrl: './sprint-close.page.scss',
})
export class SprintClosePage {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);
  readonly #toast = inject(ToastService);
  readonly #sanitizer = inject(DomSanitizer);

  /** Local calendar of the app, same source as the dashboard and the Markdown reports. */
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly #now = new Date().toISOString();

  readonly configState = this.#store.configState;
  readonly config = this.#store.config;
  readonly teams = computed(() => this.config()?.teams.filter((t) => t.active) ?? []);
  readonly teamId = linkedSignal<ReturnType<typeof this.teams>, string | null>({
    source: this.teams,
    computation: (teams, previous) =>
      teams.some((t) => t.id === previous?.value) ? previous!.value : (teams[0]?.id ?? null),
  });
  readonly team = computed(() => this.teams().find((t) => t.id === this.teamId()) ?? null);
  readonly projects = computed(
    () => this.config()?.projects.filter((p) => p.active && p.teamId === this.teamId()) ?? [],
  );

  readonly #defaults = defaultPeriod({ now: this.#now, timeZone: this.timeZone });
  readonly from = signal(this.#defaults.from);
  readonly to = signal(this.#defaults.to);
  readonly periodError = computed(() => {
    const from = this.from();
    const to = this.to();
    if (!from || !to) return 'Completá las dos fechas del período.';
    return from > to ? 'La fecha «Desde» no puede ser posterior a «Hasta».' : null;
  });

  readonly statuses = signal<StatusInfo[]>([]);
  readonly statusesError = signal<string | null>(null);

  /** Export needs the Electron bridge (absent in a plain browser). */
  readonly canExport = typeof window.leadershipPanel?.saveHtml === 'function';
  readonly feedback = signal<{ ok: boolean; message: string } | null>(null);

  readonly #projectDatasets = computed(() =>
    this.projects().map((project) => ({ project, dataset: this.#store.projectIssues(project.id) })),
  );
  readonly memberDataset = computed(() => {
    const teamId = this.teamId();
    return teamId && !this.periodError() ? this.#store.memberIssues(teamId, this.from()) : EMPTY_DATASET;
  });
  readonly #allDatasets = computed(() => [...this.#projectDatasets().map((d) => d.dataset), this.memberDataset()]);

  readonly loading = computed(() => this.#allDatasets().some((d) => d.status === 'loading'));
  readonly refreshing = signal(false);
  readonly missingProjects = computed(() =>
    this.#projectDatasets()
      .filter(({ dataset }) => dataset.status === 'ready' && dataset.fetchedAt === null)
      .map(({ project }) => project),
  );
  readonly datasetErrors = computed(() => [
    ...this.#projectDatasets().flatMap(({ project, dataset }) =>
      dataset.error ? [{ name: project.name, message: dataset.error.message }] : [],
    ),
    ...(this.memberDataset().error ? [{ name: 'Trabajo del equipo', message: this.memberDataset().error!.message }] : []),
  ]);
  /** Oldest `fetchedAt` among the datasets with data. */
  readonly dataAsOf = computed<string | null>(() => {
    const dates = this.#allDatasets().flatMap((d) => (d.fetchedAt ? [d.fetchedAt] : []));
    return dates.length ? dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
  });
  readonly notCurrent = computed(() => this.#allDatasets().some((d) => d.fetchedAt !== null && !d.isCurrent));
  readonly memberNeverSynced = computed(
    () => !this.periodError() && this.memberDataset().status === 'ready' && this.memberDataset().fetchedAt === null,
  );

  /** Rows cached by an older app version (no `statusChanges`): the report cannot see their movement. */
  readonly legacyRows = computed(() =>
    [...this.#projectDatasets().flatMap((d) => d.dataset.rows), ...this.memberDataset().rows].some(
      (row) => !Array.isArray((row as { statusChanges?: unknown }).statusChanges),
    ),
  );

  readonly noLayerMapping = computed(() => (this.config()?.jira.componentLayers.length ?? 0) === 0);

  readonly report = computed(() => {
    const config = this.config();
    const team = this.team();
    if (!config || !team || this.periodError()) return null;
    return buildSprintClose({
      teamId: team.id,
      config,
      period: { from: this.from(), to: this.to() },
      timeZone: this.timeZone,
      statuses: this.statuses(),
      blockedStatusIds: config.jira.blockedStatusIds,
      epicRows: this.#projectDatasets().flatMap((d) => d.dataset.rows),
      memberRows: this.memberDataset().rows,
    });
  });

  /** AI draft: only when AI is enabled in the settings AND the key is stored (the key itself never reaches the renderer). */
  readonly aiAvailable = computed(() => this.config()?.settings.ai.enabled === true && this.#store.aiKeyStored() === true);
  readonly aiConfirming = signal(false);
  readonly aiBusy = signal(false);
  readonly aiError = signal<string | null>(null);
  readonly aiDemo = signal(false);
  /** Editable draft: one headline per line plus the reading; `null` until the model answers. */
  readonly draftHeadlines = signal<string | null>(null);
  readonly draftReading = signal('');
  readonly narrative = computed<{ headlines: string[]; reading: string } | null>(() => {
    const headlines = this.draftHeadlines();
    if (headlines === null) return null;
    return {
      headlines: headlines.split('\n').map((h) => h.trim()).filter((h) => h !== ''),
      reading: this.draftReading().trim(),
    };
  });
  /** Figures in the text that are not in the report (plan 8.2); empty when all match. */
  readonly unknownNumbers = computed(() => {
    const narrative = this.narrative();
    const report = this.report();
    return narrative && report ? checkNarrativeFigures(narrative, report).unknownNumbers : [];
  });

  readonly title = computed(() => `Cierre de sprint — ${this.team()?.name ?? ''} — ${this.from()}..${this.to()}`);

  readonly html = computed(() => {
    const report = this.report();
    const config = this.config();
    if (!report || !config) return '';
    return renderSprintCloseHtml(report, {
      title: this.title(),
      teamName: this.team()?.name ?? '',
      generatedAt: this.#now,
      timeZone: this.timeZone,
      jiraBaseUrl: config.jira.baseUrl,
      narrative: this.narrative(),
    });
  });

  /**
   * Trusted ONLY for the preview iframe's `srcdoc`: `renderSprintCloseHtml` escapes every interpolated
   * value and emits no `<script>`, and the iframe is sandboxed with no permissions (no scripts, no
   * same-origin), so the document can neither run code nor reach the app. Angular's sanitizer would
   * strip the document's `<style>`, which is why it is bypassed here.
   */
  readonly previewDoc = computed(() => this.#sanitizer.bypassSecurityTrustHtml(this.html()));

  readonly fileName = computed(
    () => `cierre-${slugify(this.team()?.name ?? '')}-${this.from()}-${this.to()}.html`,
  );

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
    void this.#loadStatuses();
    // A draft belongs to one team and period: changing either discards it.
    effect(() => {
      this.teamId();
      this.from();
      this.to();
      untracked(() => this.discardNarrative());
    });
    // Reads what the proxy holds; never refreshes from Jira (the user asks with "Actualizar datos").
    effect(() => {
      const ids = this.projects().map((p) => p.id);
      untracked(() => ids.forEach((id) => this.#store.ensureProjectIssues(id)));
    });
    effect(() => {
      const teamId = this.teamId();
      const from = this.from();
      const valid = !this.periodError();
      // `config` is tracked: members and link settings are part of the dataset's cache key.
      this.config();
      if (teamId && valid) untracked(() => this.#store.ensureMemberIssues(teamId, from));
    });
  }

  async #loadStatuses(): Promise<void> {
    try {
      this.statuses.set(await this.#proxy.get<StatusInfo[]>('/api/jira/statuses'));
      this.statusesError.set(null);
    } catch (error) {
      this.statusesError.set(error instanceof Error ? error.message : String(error));
    }
  }

  selectTeam(id: string): void {
    this.teamId.set(id);
  }

  async refresh(): Promise<void> {
    const teamId = this.teamId();
    if (!teamId || this.periodError()) return;
    this.refreshing.set(true);
    try {
      await Promise.all([
        this.#store.refreshMemberIssues(teamId, this.from()),
        ...this.projects().map((p) => this.#store.refreshProjectIssues(p.id)),
      ]);
    } finally {
      this.refreshing.set(false);
    }
  }

  askAi(): void {
    this.aiError.set(null);
    this.aiConfirming.set(true);
  }

  cancelAi(): void {
    this.aiConfirming.set(false);
  }

  discardNarrative(): void {
    this.draftHeadlines.set(null);
    this.draftReading.set('');
    this.aiDemo.set(false);
    this.aiError.set(null);
    this.aiConfirming.set(false);
  }

  /** Sends ONLY the `narrativeInput` figures/titles to the proxy; the proxy holds the key. */
  async draftWithAi(): Promise<void> {
    const report = this.report();
    if (!report || !this.aiAvailable() || this.aiBusy()) return;
    this.aiConfirming.set(false);
    this.aiBusy.set(true);
    this.aiError.set(null);
    try {
      const input = narrativeInput(report, { teamName: this.team()?.name ?? '' });
      const answer = await this.#proxy.post<{ text: string; demo?: boolean }>('/api/reports/ai', { input });
      const parsed = parseNarrative(answer.text);
      if (!parsed) {
        this.aiError.set('La IA devolvió una respuesta que no se pudo leer. Probá de nuevo.');
        return;
      }
      this.draftHeadlines.set(parsed.headlines.join('\n'));
      this.draftReading.set(parsed.reading);
      this.aiDemo.set(answer.demo === true);
    } catch (error) {
      this.aiError.set(error instanceof Error && error.message ? error.message : 'No se pudo redactar con IA.');
    } finally {
      this.aiBusy.set(false);
    }
  }

  async exportHtml(): Promise<void> {
    if (!this.canExport || !this.html()) return;
    this.feedback.set(null);
    const failure = 'No se pudo guardar el informe.';
    try {
      const result = await window.leadershipPanel!.saveHtml(this.fileName(), this.html());
      if (result.ok && result.canceled) return; // a dismissed save dialog is not an error
      if (result.ok) {
        this.feedback.set({ ok: true, message: 'Informe guardado.' });
        this.#toast.success('Informe guardado.');
      } else this.feedback.set({ ok: false, message: result.error || failure });
    } catch (error) {
      this.feedback.set({ ok: false, message: error instanceof Error && error.message ? error.message : failure });
    }
  }
}
