import { measureLabel } from '../../../../shared/domain/reports.mjs';
import type { Measure } from '../../../../shared/domain/work-units.mjs';

export type UnitType = 'task' | 'subtask';

// One implementation of the measure wording, shared with the Markdown reports.
export { formatMeasureValue as formatMeasure, measureLabel } from '../../../../shared/domain/reports.mjs';

/** Section title of a measurement group, e.g. "Subtareas · Story points". */
export function groupTitle(unitType: UnitType, measure: Measure): string {
  return `${unitType === 'task' ? 'Tareas' : 'Subtareas'} · ${measureLabel(measure)}`;
}

/** "1 tarea" / "3 subtareas". */
export function unitCount(unitType: UnitType, n: number): string {
  const noun = unitType === 'task' ? 'tarea' : 'subtarea';
  return `${n} ${n === 1 ? noun : noun + 's'}`;
}

/** Whole percentage, or `null` when the total is 0 (a percentage would be misleading). */
export function percentOf(done: number, total: number): number | null {
  return total > 0 ? Math.round((done / total) * 100) : null;
}
