import { formatMeasure, groupTitle, measureLabel, percentOf, unitCount } from './measure-format';

const count = { kind: 'count' } as const;
const points = { kind: 'field', fieldId: 'cf1', fieldName: 'Story points', valueType: 'number' } as const;
const hours = { kind: 'field', fieldId: 'cf2', fieldName: 'Estimación', valueType: 'time_seconds' } as const;

describe('measure-format', () => {
  it('formats values per measure kind', () => {
    expect(formatMeasure(12, count)).toBe('12');
    expect(formatMeasure(8.5, points)).toBe('8,5');
    expect(formatMeasure(1.25, hours)).toBe('1,3 h');
    expect(formatMeasure(0, hours)).toBe('0 h');
  });

  it('labels measures and group titles', () => {
    expect(measureLabel(count)).toBe('Cantidad');
    expect(measureLabel(hours)).toBe('Estimación (h)');
    expect(groupTitle('task', count)).toBe('Tareas · Cantidad');
    expect(groupTitle('subtask', points)).toBe('Subtareas · Story points');
    expect(groupTitle('task', hours)).toBe('Tareas · Estimación (h)');
  });

  it('pluralizes unit counts', () => {
    expect(unitCount('task', 1)).toBe('1 tarea');
    expect(unitCount('subtask', 3)).toBe('3 subtareas');
  });

  it('never returns a percentage for a zero total', () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(0, 0)).toBeNull();
  });
});
