import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { Measure, WorkUnit } from '../../../../shared/domain/work-units.mjs';
import { formatMeasure } from './measure-format';
import { Modal } from './modal';
import { CATEGORY_STATE } from './state';

/** What a drill-down shows: the units behind a number. */
export interface Drill {
  title: string;
  units: WorkUnit[];
  /** Measure of the units; `count` hides the measure column. */
  measure: Measure;
}

/**
 * Reusable drill-down: lists the units behind a number (key opens the issue in Jira through the
 * Electron bridge, summary, status with its category color, assignee, measure).
 */
@Component({
  selector: 'app-unit-list-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    <app-modal [title]="title() + ' (' + units().length + ')'" [wide]="true" (closed)="closed.emit()">
      @if (openError()) {
        <p class="field-error" role="alert">{{ openError() }}</p>
      }
      @if (units().length === 0) {
        <p>No hay unidades para mostrar.</p>
      } @else {
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Clave</th>
                <th>Resumen</th>
                <th>Estado</th>
                <th>Responsable</th>
                @if (showMeasure()) {
                  <th class="num">Medida</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (unit of units(); track unit.key) {
                <tr>
                  <td class="text-mono">
                    @if (canOpenInJira) {
                      <button type="button" class="num-link" (click)="openInJira(unit.key)">{{ unit.key }}</button>
                    } @else {
                      {{ unit.key }}
                    }
                  </td>
                  <td>{{ unit.summary }}</td>
                  <td>
                    <span class="status-chip" [class]="'status-chip ' + stateClass(unit)">{{ unit.statusName }}</span>
                  </td>
                  <td>{{ unit.assigneeName ?? 'Sin asignar' }}</td>
                  @if (showMeasure()) {
                    <td class="num text-mono">{{ measureText(unit) }}</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      <button modal-actions type="button" (click)="closed.emit()">Cerrar</button>
    </app-modal>
  `,
})
export class UnitListModal {
  readonly title = input.required<string>();
  readonly units = input.required<WorkUnit[]>();
  readonly measure = input<Measure>({ kind: 'count' });
  readonly closed = output<void>();

  protected readonly openError = signal<string | null>(null);
  /** `openInJira` exists only behind the Electron preload bridge; the key is plain text in a browser. */
  protected readonly canOpenInJira = typeof window.leadershipPanel?.openInJira === 'function';
  protected readonly showMeasure = computed(() => this.measure().kind !== 'count');

  protected stateClass(unit: WorkUnit): string {
    return CATEGORY_STATE[unit.statusCategory];
  }

  protected measureText(unit: WorkUnit): string {
    return unit.measureValue === null ? 'Sin dato' : formatMeasure(unit.measureValue, this.measure());
  }

  protected async openInJira(issueKey: string): Promise<void> {
    this.openError.set(null);
    const result = await window.leadershipPanel?.openInJira(issueKey);
    if (result && !result.ok) this.openError.set('No se pudo abrir la issue en Jira.');
  }
}
