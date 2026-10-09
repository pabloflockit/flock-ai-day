import type { Measure } from '../../../../shared/domain/work-units.mjs';

export type UnitType = 'task' | 'subtask';

const numberFormat = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

/** Display text of a measure value; `time_seconds` measures are already hours in the domain. */
export function formatMeasure(value: number, measure: Measure): string {
  const text = numberFormat.format(value);
  return measure.kind === 'field' && measure.valueType === 'time_seconds' ? `${text} h` : text;
}

/** Name of the measure: "Cantidad", the field name, or the field name with "(h)" for time. */
export function measureLabel(measure: Measure): string {
  if (measure.kind === 'count') return 'Cantidad';
  return measure.valueType === 'time_seconds' ? `${measure.fieldName} (h)` : measure.fieldName;
}

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
