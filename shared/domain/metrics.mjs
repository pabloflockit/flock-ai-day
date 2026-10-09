import { daysInStatus } from './status.mjs';
import { addDays, dayOfWeek, isoWeekKey, toCalendarDate } from './dates.mjs';

/**
 * Dashboard metrics (plan §4, §7) over WorkUnits. Inputs are HOMOGENEOUS (one unit type and one
 * measure per call); `measurementGroups` splits mixed input. Pure: no clock (`now` and `timeZone`
 * are parameters), no I/O, inputs are not mutated.
 *
 * @typedef {import('./work-units.mjs').WorkUnit} WorkUnit
 * @typedef {import('./work-units.mjs').Measure} Measure
 * @typedef {import('./work-units.mjs').UnitProject} UnitProject
 * @typedef {import('../../proxy/config/normalize.mjs').Project} Project
 * @typedef {import('../../proxy/config/normalize.mjs').Member} Member
 * @typedef {import('./scope.mjs').TeamOutside} TeamOutside
 * @typedef {{ count: number, measure: number, missingMeasure: WorkUnit[] }} Aggregate
 * @typedef {Aggregate & { units: WorkUnit[] }} Bucket
 * @typedef {{ now: string, timeZone: string }} Clock
 */

const isOpen = (/** @type {WorkUnit} */ u) => u.statusCategory !== 'done';
const byDisplayName = (/** @type {{ displayName: string }} */ a, /** @type {{ displayName: string }} */ b) => a.displayName.localeCompare(b.displayName, 'es');

/**
 * @param {WorkUnit[]} units
 * @returns {Aggregate}
 */
export function aggregate(units) {
  let measure = 0;
  /** @type {WorkUnit[]} */
  const missingMeasure = [];
  for (const u of units) {
    if (u.measureValue === null) missingMeasure.push(u);
    else measure += u.measureValue;
  }
  return { count: units.length, measure, missingMeasure };
}

/** @param {WorkUnit[]} units @returns {Bucket} */
const bucket = (units) => ({ ...aggregate(units), units });

/** Group key of a project measure: `count` or `field:<fieldId>`. @param {Measure} measure */
export const measureKeyOf = (measure) => (measure.kind === 'count' ? 'count' : `field:${measure.fieldId}`);

/**
 * Groups by unit type + project measure so 'both' projects and differently measured projects never mix.
 * Order: task before subtask, then measure key.
 *
 * @param {WorkUnit[]} units
 * @param {Pick<UnitProject, 'id' | 'measure'>[]} projects
 * @returns {{ unitType: 'task' | 'subtask', measureKey: string, measure: Measure, units: WorkUnit[] }[]}
 */
export function measurementGroups(units, projects) {
  const measures = new Map(projects.map((p) => [p.id, p.measure]));
  /** @type {Map<string, { unitType: 'task' | 'subtask', measureKey: string, measure: Measure, units: WorkUnit[] }>} */
  const groups = new Map();
  for (const u of units) {
    const measure = measures.get(u.projectId);
    if (!measure) continue;
    const measureKey = measureKeyOf(measure);
    const id = `${u.unitType}|${measureKey}`;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { unitType: u.unitType, measureKey, measure, units: [] }));
    group.units.push(u);
  }
  const typeRank = (/** @type {string} */ t) => (t === 'task' ? 0 : 1);
  return [...groups.values()].sort((a, b) => typeRank(a.unitType) - typeRank(b.unitType) || (a.measureKey < b.measureKey ? -1 : a.measureKey > b.measureKey ? 1 : 0));
}

/**
 * M1: progress per project (sum of its units, not an average of epic percentages) and per active epic.
 *
 * @param {WorkUnit[]} units
 * @param {Pick<Project, 'id' | 'name' | 'epics'>[]} projects
 */
export function progress(units, projects) {
  const isDone = (/** @type {WorkUnit} */ u) => u.statusCategory === 'done';
  const result = [];
  for (const p of projects) {
    const own = units.filter((u) => u.projectId === p.id);
    if (own.length === 0) continue;
    const epics = p.epics
      .filter((e) => e.active)
      .map((e) => {
        const inEpic = own.filter((u) => u.epicKey === e.key);
        return { epicKey: e.key, epicSummary: e.summary, total: bucket(inEpic), done: bucket(inEpic.filter(isDone)) };
      })
      .filter((e) => e.total.count > 0);
    result.push({ projectId: p.id, projectName: p.name, total: bucket(own), done: bucket(own.filter(isDone)), epics });
  }
  return result;
}

const CATEGORIES = /** @type {const} */ (['todo', 'doing', 'done']);

/**
 * M2: status distribution per epic (first-seen order), grouped by category then status.
 *
 * @param {WorkUnit[]} units
 */
export function statusDistribution(units) {
  /** @type {Map<string, WorkUnit[]>} */
  const byEpic = new Map();
  for (const u of units) {
    const key = /** @type {string} */ (u.epicKey);
    const list = byEpic.get(key);
    if (list) list.push(u);
    else byEpic.set(key, [u]);
  }
  return [...byEpic].map(([epicKey, list]) => ({
    epicKey,
    categories: CATEGORIES.flatMap((category) => {
      const inCategory = list.filter((u) => u.statusCategory === category);
      if (inCategory.length === 0) return [];
      /** @type {Map<string, WorkUnit[]>} */
      const byStatus = new Map();
      for (const u of inCategory) {
        const l = byStatus.get(u.statusId);
        if (l) l.push(u);
        else byStatus.set(u.statusId, [u]);
      }
      const statuses = [...byStatus].map(([statusId, l]) => ({ statusId, statusName: l[0].statusName, ...bucket(l) }));
      return [{ category, statuses }];
    }),
  }));
}

/**
 * M3: work in progress (category 'doing'), total and per member with doing work.
 *
 * @param {WorkUnit[]} units
 * @param {Pick<Member, 'accountId' | 'displayName'>[]} members
 */
export function workInProgress(units, members) {
  const doing = units.filter((u) => u.statusCategory === 'doing');
  const byMember = members
    .map((m) => ({ accountId: m.accountId, displayName: m.displayName, ...bucket(doing.filter((u) => u.assigneeAccountId === m.accountId)) }))
    .filter((m) => m.count > 0)
    .sort(byDisplayName);
  return { total: bucket(doing), byMember };
}

/**
 * M4: open load of every active member (alphabetical, no ranking by load).
 *
 * @param {WorkUnit[]} units
 * @param {Pick<Member, 'accountId' | 'displayName' | 'active'>[]} members
 */
export function loadByMember(units, members) {
  const open = units.filter(isOpen);
  return members
    .filter((m) => m.active)
    .map((m) => {
      const own = open.filter((u) => u.assigneeAccountId === m.accountId);
      return {
        accountId: m.accountId,
        displayName: m.displayName,
        open: bucket(own),
        todo: bucket(own.filter((u) => u.statusCategory === 'todo')),
        doing: bucket(own.filter((u) => u.statusCategory === 'doing')),
      };
    })
    .sort(byDisplayName);
}

/**
 * M5: open units strictly above the threshold of business days in their status.
 *
 * @param {WorkUnit[]} units
 * @param {number} staleBusinessDays
 * @param {Clock} clock
 * @returns {{ unit: WorkUnit, days: number }[]}
 */
export function staleUnits(units, staleBusinessDays, clock) {
  return units
    .filter(isOpen)
    .map((unit) => ({ unit, days: daysInStatus(unit, clock) }))
    .filter((r) => r.days > staleBusinessDays)
    .sort((a, b) => b.days - a.days || (a.unit.key < b.unit.key ? -1 : a.unit.key > b.unit.key ? 1 : 0));
}

/**
 * M6: units done per ISO week (local calendar of `timeZone`), exactly `weeks` entries oldest -> newest
 * ending with the week of `now`. `hasDoneData` tells whether any unit has a done date at all.
 *
 * @param {WorkUnit[]} units
 * @param {Clock & { weeks?: number }} options
 * @returns {{ weeks: ({ weekKey: string, weekStart: string } & Bucket)[], hasDoneData: boolean }}
 */
export function weeklyThroughput(units, { now, timeZone, weeks = 8 }) {
  const today = toCalendarDate(now, timeZone);
  const currentMonday = addDays(today, 1 - dayOfWeek(today));
  /** @type {Map<string, WorkUnit[]>} */
  const byWeek = new Map();
  let hasDoneData = false;
  for (const u of units) {
    if (u.doneAt === null) continue;
    hasDoneData = true;
    const key = isoWeekKey(toCalendarDate(u.doneAt, timeZone));
    const list = byWeek.get(key);
    if (list) list.push(u);
    else byWeek.set(key, [u]);
  }
  const result = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = addDays(currentMonday, -7 * i);
    const weekKey = isoWeekKey(weekStart);
    result.push({ weekKey, weekStart, ...bucket(byWeek.get(weekKey) ?? []) });
  }
  return { weeks: result, hasDoneData };
}

/**
 * F1: open unassigned work of the team's epics.
 *
 * @param {TeamOutside} outside
 * @returns {Bucket}
 */
export function unassignedOpen(outside) {
  return bucket(outside.unassigned.filter(isOpen));
}

/**
 * F2: open work of people outside the team, per person (alphabetical).
 *
 * @param {TeamOutside} outside
 * @returns {({ accountId: string, displayName: string } & Bucket)[]}
 */
export function othersOpenByPerson(outside) {
  /** @type {Map<string, WorkUnit[]>} */
  const byPerson = new Map();
  for (const u of outside.others.filter(isOpen)) {
    const id = /** @type {string} */ (u.assigneeAccountId);
    const list = byPerson.get(id);
    if (list) list.push(u);
    else byPerson.set(id, [u]);
  }
  return [...byPerson]
    .map(([accountId, list]) => ({ accountId, displayName: list[0].assigneeName ?? accountId, ...bucket(list) }))
    .sort(byDisplayName);
}
