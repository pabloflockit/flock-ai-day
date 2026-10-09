import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { WorkUnit } from '../../../../shared/domain/work-units.mjs';
import { formatMeasure, groupTitle, measureLabel, percentOf, unitCount } from '../../shared/ui/measure-format';
import { CATEGORY_STATE } from '../../shared/ui/state';
import type { Drill } from '../../shared/ui/unit-list-modal';
import type { DashboardGroup } from './dashboard.state';

interface BucketLike {
  count: number;
  measure: number;
  missingMeasure: WorkUnit[];
  units: WorkUnit[];
}

const CATEGORY_LABEL = { todo: 'Por hacer', doing: 'En curso', done: 'Hecho' } as const;

/** One measurement group (unit type + measure) with its metrics M1–M6. Every number emits a `drill`. */
@Component({
  selector: 'app-dashboard-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './dashboard-group.html',
  styleUrl: './dashboard-group.scss',
})
export class DashboardGroupView {
  readonly group = input.required<DashboardGroup>();
  readonly drill = output<Drill>();

  protected readonly title = computed(() => groupTitle(this.group().unitType, this.group().measure));
  protected readonly isField = computed(() => this.group().measure.kind === 'field');
  protected readonly fieldName = computed(() => {
    const measure = this.group().measure;
    return measure.kind === 'field' ? measure.fieldName : '';
  });
  protected readonly staleUnits = computed(() => this.group().stale.map((s) => s.unit));
  protected readonly categories = ['todo', 'doing', 'done'] as const;
  protected readonly categoryLabel = CATEGORY_LABEL;
  protected readonly stateClass = (unit: WorkUnit): string => CATEGORY_STATE[unit.statusCategory];

  /** Epic summaries for M2, which only carries the key. */
  protected readonly epicSummaries = computed(
    () => new Map(this.group().progress.flatMap((p) => p.epics.map((e) => [e.epicKey, e.epicSummary] as const))),
  );

  /** Bar scale for M4: the largest open load of a member, by measure when it has any value, else by count. */
  protected readonly loadMax = computed(() => {
    const load = this.group().load;
    const byMeasure = Math.max(0, ...load.map((m) => m.open.measure));
    return byMeasure > 0 ? { useMeasure: true, max: byMeasure } : { useMeasure: false, max: Math.max(0, ...load.map((m) => m.open.count)) };
  });
  /** Bar scale for M6, same rule as M4. */
  protected readonly weekMax = computed(() => {
    const weeks = this.group().throughput.weeks;
    const byMeasure = Math.max(0, ...weeks.map((w) => w.measure));
    return byMeasure > 0 ? { useMeasure: true, max: byMeasure } : { useMeasure: false, max: Math.max(0, ...weeks.map((w) => w.count)) };
  });

  protected show(label: string, units: WorkUnit[]): void {
    this.drill.emit({ title: `${label} · ${this.title()}`, units, measure: this.group().measure });
  }

  protected showTasksWithoutSubtasks(): void {
    this.drill.emit({
      title: `Tareas sin subtareas · ${this.title()}`,
      units: this.group().tasksWithoutSubtasks,
      measure: { kind: 'count' },
    });
  }

  /** "12 (5 tareas)" for field measures, "5 tareas" for quantity. */
  protected amount(b: { count: number; measure: number }): string {
    const quantity = unitCount(this.group().unitType, b.count);
    const measure = this.group().measure;
    return measure.kind === 'count' ? quantity : `${formatMeasure(b.measure, measure)} (${quantity})`;
  }

  /** Compact figure for narrow places (week bars): the measure for field measures, else the count. */
  protected shortAmount(b: { count: number; measure: number }): string {
    return this.isField() ? this.measureText(b.measure) : String(b.count);
  }

  protected measureText(value: number): string {
    return formatMeasure(value, this.group().measure);
  }

  protected percent(done: BucketLike, total: BucketLike): number | null {
    return percentOf(done.measure, total.measure);
  }

  protected missingText(n: number): string {
    return `${unitCount(this.group().unitType, n)} sin ${this.fieldName()}`;
  }

  protected measureName(): string {
    return measureLabel(this.group().measure);
  }

  protected barPercent(value: BucketLike, scale: { useMeasure: boolean; max: number }): number {
    const v = scale.useMeasure ? value.measure : value.count;
    return scale.max > 0 ? (v / scale.max) * 100 : 0;
  }

  protected barValue(value: BucketLike, scale: { useMeasure: boolean }): number {
    return scale.useMeasure ? value.measure : value.count;
  }

  protected weekLabel(weekStart: string): string {
    const [, month, day] = weekStart.split('-');
    return `${day}/${month}`;
  }

  protected tasksWithoutSubtasksText(n: number): string {
    return n === 1
      ? '1 tarea no tiene subtareas y no está incluida en la medición por subtareas'
      : `${n} tareas no tienen subtareas y no están incluidas en la medición por subtareas`;
  }
}
