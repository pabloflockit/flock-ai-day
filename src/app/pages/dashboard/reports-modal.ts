import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { measurementGroups } from '../../../../shared/domain/metrics.mjs';
import { buildClientReport, buildSprintReport, defaultPeriod } from '../../../../shared/domain/reports.mjs';
import { Modal } from '../../shared/ui/modal';
import { ToastService } from '../../shared/ui/toast.service';
import { DashboardState } from './dashboard.state';

export type ReportKind = 'sprint' | 'client';

const TITLES: Record<ReportKind, string> = { sprint: 'Informe de sprint', client: 'Informe para cliente' };
const FILE_PREFIX: Record<ReportKind, string> = { sprint: 'informe-sprint', client: 'informe-cliente' };

/** Lowercase ASCII slug for file names ("Equipo Ñandú" -> "equipo-nandu"). */
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
 * Report preview over the dashboard selection (plan §8.1): the same scoped units and filters as the
 * page, a date range, the Markdown as plain preformatted text, copy and save through the Electron bridge.
 */
@Component({
  selector: 'app-reports-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  styleUrl: './reports-modal.scss',
  template: `
    <app-modal [title]="title()" [wide]="true" (closed)="closed.emit()">
      <div class="reports-period">
        <label class="field">
          Desde
          <input type="date" [value]="from()" (input)="from.set($any($event.target).value)" />
        </label>
        <label class="field">
          Hasta
          <input type="date" [value]="to()" (input)="to.set($any($event.target).value)" />
        </label>
      </div>
      <p class="field-hint">Alcance: {{ state.team()?.name }} · {{ scopeLabel() }}</p>
      @if (periodError()) {
        <p class="field-error" role="alert">{{ periodError() }}</p>
      } @else {
        <pre class="reports-preview" aria-label="Vista previa del informe">{{ markdown() }}</pre>
      }
      @if (!canExport) {
        <p class="field-hint">Copiar y guardar solo están disponibles en la app de escritorio.</p>
      }
      @if (feedback(); as f) {
        <p [class]="f.ok ? 'field-hint' : 'field-error'" [attr.role]="f.ok ? 'status' : 'alert'">{{ f.message }}</p>
      }
      <ng-container modal-actions>
        <button type="button" class="btn-ghost" (click)="closed.emit()">Cerrar</button>
        <button type="button" class="copy" [disabled]="!canExport || !markdown()" (click)="copy()">Copiar</button>
        <button type="button" class="save" [disabled]="!canExport || !markdown()" (click)="save()">Guardar .md</button>
      </ng-container>
    </app-modal>
  `,
})
export class ReportsModal {
  protected readonly state = inject(DashboardState);
  readonly #toast = inject(ToastService);

  readonly kind = input.required<ReportKind>();
  readonly closed = output<void>();

  /** The clipboard and the save dialog exist only behind the Electron preload bridge. */
  protected readonly canExport =
    typeof window.leadershipPanel?.copyText === 'function' && typeof window.leadershipPanel?.saveMarkdown === 'function';

  readonly #defaults = defaultPeriod({ now: this.state.now(), timeZone: this.state.timeZone });
  protected readonly from = signal(this.#defaults.from);
  protected readonly to = signal(this.#defaults.to);
  protected readonly feedback = signal<{ ok: boolean; message: string } | null>(null);

  protected readonly title = computed(() => TITLES[this.kind()]);

  protected readonly periodError = computed(() => {
    const from = this.from();
    const to = this.to();
    if (!from || !to) return 'Completá las dos fechas del período.';
    return from > to ? 'La fecha «Desde» no puede ser posterior a «Hasta».' : null;
  });

  /** Current project/epic filter, as the dashboard selectors show it. */
  protected readonly scopeLabel = computed(() => {
    const project = this.state.projects().find((p) => p.id === this.state.projectId());
    const epic = this.state.epics().find((e) => e.key === this.state.epicKey());
    const parts = [project?.name ?? 'Todos los proyectos'];
    if (epic) parts.push(`${epic.key} · ${epic.summary}`);
    return parts.join(' · ');
  });

  protected readonly markdown = computed(() => {
    const team = this.state.team();
    const config = this.state.config();
    if (this.periodError() || !team || !config) return '';
    const projects = this.state.projects();
    // Open unassigned outside units, grouped like the dashboard (same project/epic filters).
    const unassigned = new Map(
      measurementGroups(this.state.outside().unassigned, projects).map((g) => [`${g.unitType}|${g.measureKey}`, g.units]),
    );
    const input = {
      teamName: team.name,
      scopeLabel: this.scopeLabel(),
      groups: this.state.groups().map((g) => ({
        unitType: g.unitType,
        measure: g.measure,
        units: g.units,
        unassignedOpen: (unassigned.get(`${g.unitType}|${g.measureKey}`) ?? []).filter((u) => u.statusCategory !== 'done'),
      })),
      projects,
      members: team.members.filter((m) => m.active),
      staleBusinessDays: config.settings.staleBusinessDays,
      period: { from: this.from(), to: this.to() },
      now: this.state.now(),
      timeZone: this.state.timeZone,
      generatedAt: this.state.now(),
    };
    return this.kind() === 'client' ? buildClientReport(input) : buildSprintReport(input);
  });

  protected readonly fileName = computed(
    () => `${FILE_PREFIX[this.kind()]}-${slugify(this.state.team()?.name ?? '')}-${this.from()}_${this.to()}.md`,
  );

  protected async copy(): Promise<void> {
    await this.#run(() => window.leadershipPanel!.copyText(this.markdown()), 'Informe copiado al portapapeles.', 'No se pudo copiar el informe.');
  }

  protected async save(): Promise<void> {
    await this.#run(
      () => window.leadershipPanel!.saveMarkdown(this.fileName(), this.markdown()),
      'Informe guardado.',
      'No se pudo guardar el informe.',
    );
  }

  async #run(
    action: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>,
    success: string,
    failure: string,
  ): Promise<void> {
    this.feedback.set(null);
    try {
      const result = await action();
      if (result.ok && result.canceled) return; // a dismissed save dialog is not an error
      if (result.ok) {
        this.feedback.set({ ok: true, message: success });
        this.#toast.success(success);
      } else this.feedback.set({ ok: false, message: failure });
    } catch {
      this.feedback.set({ ok: false, message: failure });
    }
  }
}
