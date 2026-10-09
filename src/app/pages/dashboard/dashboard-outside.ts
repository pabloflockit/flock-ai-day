import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { Measure, WorkUnit } from '../../../../shared/domain/work-units.mjs';
import { formatMeasure, groupTitle, unitCount } from '../../shared/ui/measure-format';
import type { Drill } from '../../shared/ui/unit-list-modal';
import type { OutsideGroup } from './dashboard.state';

/** A person with open work outside the team, as the "Agregar al equipo" and "Reactivar" actions need it. */
export interface OutsidePerson {
  accountId: string;
  displayName: string;
}

/**
 * "Fuera del equipo" (plan §4, §6.3): per measurement group, F1 open unassigned work and F2 open work
 * assigned to people outside the team (alphabetical, no ranking). Every number emits a `drill`.
 */
@Component({
  selector: 'app-dashboard-outside',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard-outside.html',
  styleUrl: './dashboard-outside.scss',
})
export class DashboardOutside {
  readonly groups = input.required<OutsideGroup[]>();
  readonly drill = output<Drill>();
  readonly addToTeam = output<OutsidePerson>();
  readonly reactivate = output<OutsidePerson>();

  protected title(group: OutsideGroup): string {
    return groupTitle(group.unitType, group.measure);
  }

  protected show(group: OutsideGroup, label: string, units: WorkUnit[]): void {
    this.drill.emit({ title: `${label} · ${this.title(group)}`, units, measure: group.measure });
  }

  /** "12 (5 tareas)" for field measures, "5 tareas" for quantity. */
  protected amount(group: OutsideGroup, b: { count: number; measure: number }): string {
    const quantity = unitCount(group.unitType, b.count);
    const measure: Measure = group.measure;
    return measure.kind === 'count' ? quantity : `${formatMeasure(b.measure, measure)} (${quantity})`;
  }

  protected missingText(group: OutsideGroup, n: number): string {
    const name = group.measure.kind === 'field' ? group.measure.fieldName : '';
    return `${unitCount(group.unitType, n)} sin ${name}`;
  }
}
