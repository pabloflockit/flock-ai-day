import type { AppConfig } from '../../../../proxy/config/normalize.mjs';

type Project = AppConfig['projects'][number];

export const WORK_UNIT_LABELS: Record<Project['workUnit'], string> = {
  task: 'Tareas',
  subtask: 'Subtareas',
  both: 'Tareas y subtareas',
};

/** One-line description of what a project counts and how, e.g. "Tareas · Story points". */
export function measureSummary(project: Pick<Project, 'workUnit' | 'measure'>): string {
  const measure = project.measure.kind === 'field' ? project.measure.fieldName : 'Cantidad';
  return `${WORK_UNIT_LABELS[project.workUnit]} · ${measure}`;
}
