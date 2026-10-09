import { effectiveCategory, effectiveDoneAt } from './status.mjs';

/**
 * Work units (plan §3): the countable items of a project, derived from its issue rows.
 * Pure: no clock, no I/O, inputs are not mutated.
 *
 * @typedef {import('../contracts.mjs').IssueRow} IssueRow
 * @typedef {import('./status.mjs').StatusCategory} StatusCategory
 * @typedef {{ kind: 'count' } | { kind: 'field', fieldId: string, fieldName: string, valueType: 'number' | 'time_seconds' }} Measure
 * @typedef {{ id: string, teamId: string, workUnit: 'task' | 'subtask' | 'both', measure: Measure }} UnitProject
 * @typedef {{ jira: { statusCategoryOverrides: Record<string, StatusCategory> } }} UnitConfig
 * @typedef {{
 *   key: string,
 *   unitType: 'task' | 'subtask',
 *   projectId: string,
 *   teamId: string,
 *   epicKey: string | null,
 *   parentKey: string | null,
 *   summary: string,
 *   issueTypeName: string,
 *   statusId: string,
 *   statusName: string,
 *   statusCategory: StatusCategory,
 *   statusSince: string | null,
 *   createdAt: string,
 *   firstDoingAt: string | null,
 *   doneAt: string | null,
 *   assigneeAccountId: string | null,
 *   assigneeName: string | null,
 *   dueDate: string | null,
 *   measureValue: number | null,
 * }} WorkUnit
 */

/** @param {IssueRow} row */
const isTask = (row) => !row.isSubtask && (row.hierarchyLevel ?? 0) === 0;

/**
 * Measured value of one row. Missing key or `null` stays `null` (consumers report it);
 * `time_seconds` is converted to hours keeping the fraction.
 *
 * @param {IssueRow} row
 * @param {Measure} measure
 * @returns {number | null}
 */
function measureValueOf(row, measure) {
  if (measure.kind === 'count') return 1;
  const raw = row.measures?.[measure.fieldId];
  if (raw === undefined || raw === null) return null;
  return measure.valueType === 'time_seconds' ? raw / 3600 : raw;
}

/**
 * @param {IssueRow} row
 * @param {'task' | 'subtask'} unitType
 * @param {UnitProject} project
 * @param {UnitConfig} config
 * @returns {WorkUnit}
 */
function toUnit(row, unitType, project, config) {
  return {
    key: row.key,
    unitType,
    projectId: project.id,
    teamId: project.teamId,
    epicKey: row.epicKey,
    parentKey: row.parentKey,
    summary: row.summary,
    issueTypeName: row.issueTypeName,
    statusId: row.statusId,
    statusName: row.statusName,
    statusCategory: effectiveCategory(row, config),
    statusSince: row.statusSince,
    createdAt: row.createdAt,
    firstDoingAt: row.firstDoingAt,
    doneAt: effectiveDoneAt(row, config),
    assigneeAccountId: row.assigneeAccountId,
    assigneeName: row.assigneeName,
    dueDate: row.dueDate,
    measureValue: measureValueOf(row, project.measure),
  };
}

/**
 * @param {IssueRow[]} rows rows of one project dataset
 * @param {UnitProject} project
 * @param {UnitConfig} config
 * @returns {{ units: WorkUnit[], tasksWithoutSubtasks: WorkUnit[] }}
 */
export function buildWorkUnits(rows, project, config) {
  const wantTasks = project.workUnit !== 'subtask';
  const wantSubtasks = project.workUnit !== 'task';
  /** @type {WorkUnit[]} */
  const units = [];
  /** @type {WorkUnit[]} */
  const tasksWithoutSubtasks = [];
  const parentsWithSubtasks = new Set();
  if (wantSubtasks) {
    for (const row of rows) if (row.isSubtask && row.parentKey) parentsWithSubtasks.add(row.parentKey);
  }
  for (const row of rows) {
    if (isTask(row)) {
      const unit = toUnit(row, 'task', project, config);
      if (wantTasks) units.push(unit);
      if (wantSubtasks && !parentsWithSubtasks.has(row.key)) tasksWithoutSubtasks.push(unit);
    } else if (row.isSubtask && wantSubtasks) {
      units.push(toUnit(row, 'subtask', project, config));
    }
  }
  return { units, tasksWithoutSubtasks };
}
