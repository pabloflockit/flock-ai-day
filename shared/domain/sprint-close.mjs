import { compareCalendarDates, toCalendarDate } from './dates.mjs';
import { effectiveCategory } from './status.mjs';

/**
 * Sprint close report model (odd/tasks/sprint-report.md): the work with REAL status movement in a
 * period, split by layer (from Jira components) -> epic -> primary with its subtasks, plus the team
 * members' work outside the team's epics and deterministic Jira hygiene notes. Pure: no clock, no
 * I/O, inputs are not mutated. Figures come only from here; narrative never computes them.
 *
 * Rules (user decisions):
 *  - an item "moved" when at least one status transition falls on a local calendar day in [from, to];
 *  - "closed" = its LAST transition into an effectively done status (overrides applied) is in the period;
 *  - "blocked" = its current status is one of `blockedStatusIds`;
 *  - layers come only from components mapped per Jira project key + component id; none -> "Sin capa"
 *    (`layer: null`); two or more -> listed in each layer, counted once in the totals, hygiene note;
 *  - a primary that did not move in a layer heads its moved subtasks there as context ("ref.",
 *    `counted: false`).
 *
 * @typedef {import('../contracts.mjs').IssueRow} IssueRow
 * @typedef {'frontend' | 'backend' | 'functional'} Layer
 * @typedef {{ from: string, to: string }} Period calendar dates, inclusive
 * @typedef {{ id: string, name: string, statusCategory: 'todo' | 'doing' | 'done' | null }} StatusInfo
 * @typedef {{ projectKey: string, componentId: string, layer: Layer }} ComponentLayer
 * @typedef {{
 *   at: string, fromStatusId: string | null, fromStatusName: string | null,
 *   toStatusId: string, toStatusName: string | null,
 * }} PeriodChange
 * @typedef {{
 *   key: string, summary: string, issueTypeName: string, isSubtask: boolean,
 *   statusId: string, statusName: string, category: 'todo' | 'doing' | 'done',
 *   assigneeName: string | null, layers: Layer[], moved: boolean,
 *   closedInPeriod: boolean, blocked: boolean, periodChanges: PeriodChange[],
 * }} ItemView
 * @typedef {{ key: string, item: ItemView | null, counted: boolean, subtasks: ItemView[] }} PrimaryEntry
 * @typedef {{ epicKey: string | null, epicSummary: string | null, primaries: PrimaryEntry[] }} EpicGroup
 * @typedef {{ withMovement: number, primaries: number, secondaries: number, closed: number, blocked: number }} Kpis
 * @typedef {{ layer: Layer | null, kpis: { counted: number, closed: number, blocked: number }, epics: EpicGroup[] }} LayerSection
 * @typedef {(
 *   | { code: 'multiple_layers', key: string, layers: Layer[] }
 *   | { code: 'parent_open_all_subtasks_done', key: string, subtaskKeys: string[] }
 *   | { code: 'subtask_open_under_done_parent', key: string, parentKey: string }
 * )} HygieneNote
 * @typedef {{
 *   period: Period,
 *   kpis: Kpis,
 *   layers: LayerSection[],
 *   outside: { kpis: Kpis, epics: EpicGroup[] },
 *   hygiene: HygieneNote[],
 * }} SprintClose
 */

/** Display order of the layers; "Sin capa" (`null`) goes last. */
export const LAYER_ORDER = /** @type {const} */ (['frontend', 'backend', 'functional']);

/** Jira project key of an issue key (`ABC-12` -> `ABC`). @param {string} key */
const projectKeyOf = (key) => {
  const dash = key.lastIndexOf('-');
  return dash < 0 ? key : key.slice(0, dash);
};

/** Natural issue-key order: project key, then number. @param {string} a @param {string} b */
function compareKeys(a, b) {
  const pa = projectKeyOf(a);
  const pb = projectKeyOf(b);
  if (pa !== pb) return pa < pb ? -1 : 1;
  return Number(a.slice(pa.length + 1)) - Number(b.slice(pb.length + 1)) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * @param {string} at instant with `Z`
 * @param {Period & { timeZone: string }} period
 */
function inPeriod(at, { from, to, timeZone }) {
  const day = toCalendarDate(at, timeZone);
  return compareCalendarDates(day, from) >= 0 && compareCalendarDates(day, to) <= 0;
}

/**
 * @param {Pick<IssueRow, 'statusChanges'>} row
 * @param {Period & { timeZone: string }} period
 */
export function movedInPeriod(row, period) {
  return row.statusChanges.some((change) => inPeriod(change.at, period));
}

/**
 * Layers of a row's mapped components, in {@link LAYER_ORDER}, without repeats.
 * @param {Pick<IssueRow, 'key' | 'components'>} row
 * @param {readonly ComponentLayer[]} componentLayers
 * @returns {Layer[]}
 */
export function layersOf(row, componentLayers) {
  const projectKey = projectKeyOf(row.key);
  const ids = new Set(row.components.map((c) => c.id));
  const found = new Set(
    componentLayers.filter((m) => m.projectKey === projectKey && ids.has(m.componentId)).map((m) => m.layer),
  );
  return LAYER_ORDER.filter((layer) => found.has(layer));
}

/**
 * @param {{
 *   teamId: string,
 *   config: {
 *     jira: { statusCategoryOverrides: Record<string, 'todo' | 'doing' | 'done'>, componentLayers: ComponentLayer[] },
 *     projects: Array<{ teamId: string, active: boolean, epics: Array<{ key: string, summary: string, active: boolean }> }>,
 *   },
 *   period: Period,
 *   timeZone: string,
 *   statuses: StatusInfo[],
 *   blockedStatusIds: readonly string[],
 *   epicRows: IssueRow[],
 *   memberRows: IssueRow[],
 * }} input `epicRows`: the team projects' datasets; `memberRows`: the `memberIssues` dataset.
 * @returns {SprintClose}
 */
export function buildSprintClose(input) {
  const { teamId, config, period, timeZone, statuses, blockedStatusIds, epicRows, memberRows } = input;
  const window = { ...period, timeZone };
  const overrides = config.jira.statusCategoryOverrides;
  const statusById = new Map(statuses.map((s) => [String(s.id), s]));
  const blocked = new Set(blockedStatusIds);

  /** @param {string | null} id @param {IssueRow} row */
  const categoryOf = (id, row) => {
    if (id === null) return null;
    if (Object.hasOwn(overrides, id)) return overrides[id];
    return statusById.get(id)?.statusCategory ?? (id === row.statusId ? row.statusCategory : null);
  };
  /** @param {string | null} id */
  const nameOf = (id) => (id === null ? null : (statusById.get(id)?.name ?? null));

  /** @param {IssueRow} row @returns {ItemView} */
  function view(row) {
    const lastDone = [...row.statusChanges].reverse().find((c) => categoryOf(c.toStatusId, row) === 'done');
    return {
      key: row.key,
      summary: row.summary,
      issueTypeName: row.issueTypeName,
      isSubtask: row.isSubtask,
      statusId: row.statusId,
      statusName: nameOf(row.statusId) ?? row.statusName,
      category: effectiveCategory(row, config),
      assigneeName: row.assigneeName,
      layers: layersOf(row, config.jira.componentLayers),
      moved: movedInPeriod(row, window),
      closedInPeriod: lastDone !== undefined && inPeriod(lastDone.at, window),
      blocked: blocked.has(row.statusId),
      periodChanges: row.statusChanges
        .filter((c) => inPeriod(c.at, window))
        .map((c) => ({
          at: c.at,
          fromStatusId: c.fromStatusId,
          fromStatusName: nameOf(c.fromStatusId),
          toStatusId: c.toStatusId,
          toStatusName: nameOf(c.toStatusId),
        })),
    };
  }

  // Work items only: epics (and anything above) are groups, not items.
  const isItem = (/** @type {IssueRow} */ row) => !(Number.isInteger(row.hierarchyLevel) && /** @type {number} */ (row.hierarchyLevel) >= 1);

  const teamEpics = config.projects
    .filter((p) => p.active && p.teamId === teamId)
    .flatMap((p) => p.epics.filter((e) => e.active));
  const teamEpicKeys = new Set(teamEpics.map((e) => e.key));
  /** @type {Map<string, string>} summary of any configured epic */
  const epicSummary = new Map(config.projects.flatMap((p) => p.epics.map((e) => [e.key, e.summary])));

  /** @type {Map<string, IssueRow>} */
  const rowByKey = new Map();
  for (const row of [...memberRows, ...epicRows]) rowByKey.set(row.key, row);
  /** @type {Map<string, ItemView>} */
  const views = new Map();
  const viewOf = (/** @type {string} */ key) => {
    const row = rowByKey.get(key);
    if (!row) return null;
    if (!views.has(key)) views.set(key, view(row));
    return /** @type {ItemView} */ (views.get(key));
  };

  const inEpics = dedupe(epicRows).filter((r) => isItem(r) && r.epicKey !== null && teamEpicKeys.has(r.epicKey));
  const inEpicKeys = new Set(inEpics.map((r) => r.key));
  const moved = inEpics.filter((r) => movedInPeriod(r, window));
  const outsideMoved = dedupe(memberRows).filter(
    (r) =>
      isItem(r) &&
      !inEpicKeys.has(r.key) &&
      !(r.epicKey !== null && teamEpicKeys.has(r.epicKey)) &&
      movedInPeriod(r, window),
  );

  // Layers: a placement is (layer, epic, primary key, subtask or the primary itself).
  /** @type {Map<Layer | null, Map<string | null, Map<string, PrimaryEntry>>>} */
  const layerTree = new Map();
  /** @param {Layer | null} layer @param {string | null} epicKey @param {string} primaryKey */
  const entryIn = (layer, epicKey, primaryKey) => {
    if (!layerTree.has(layer)) layerTree.set(layer, new Map());
    const epics = /** @type {Map<string | null, Map<string, PrimaryEntry>>} */ (layerTree.get(layer));
    if (!epics.has(epicKey)) epics.set(epicKey, new Map());
    const primaries = /** @type {Map<string, PrimaryEntry>} */ (epics.get(epicKey));
    if (!primaries.has(primaryKey)) {
      primaries.set(primaryKey, { key: primaryKey, item: viewOf(primaryKey), counted: false, subtasks: [] });
    }
    return /** @type {PrimaryEntry} */ (primaries.get(primaryKey));
  };

  for (const row of moved) {
    const item = /** @type {ItemView} */ (viewOf(row.key));
    const layers = item.layers.length > 0 ? item.layers : [null];
    for (const layer of layers) {
      if (row.isSubtask && row.parentKey) entryIn(layer, row.epicKey, row.parentKey).subtasks.push(item);
      else entryIn(layer, row.epicKey, row.key).counted = true;
    }
  }

  const epicOrder = teamEpics.map((e) => e.key);
  /** @type {LayerSection[]} */
  const layers = [...LAYER_ORDER, null]
    .filter((layer) => layerTree.has(layer))
    .map((layer) => {
      const epics = /** @type {Map<string | null, Map<string, PrimaryEntry>>} */ (layerTree.get(layer));
      const groups = epicOrder
        .filter((key) => epics.has(key))
        .map((key) => group(key, epicSummary.get(key) ?? null, /** @type {Map<string, PrimaryEntry>} */ (epics.get(key))));
      const counted = groups.flatMap(countedItems);
      return {
        layer,
        kpis: {
          counted: counted.length,
          closed: counted.filter((i) => i.closedInPeriod).length,
          blocked: counted.filter((i) => i.blocked).length,
        },
        epics: groups,
      };
    });

  // Outside the team's epics: grouped by epic (no epic last), no layers.
  /** @type {Map<string | null, Map<string, PrimaryEntry>>} */
  const outsideTree = new Map();
  for (const row of outsideMoved) {
    const item = /** @type {ItemView} */ (viewOf(row.key));
    if (!outsideTree.has(row.epicKey)) outsideTree.set(row.epicKey, new Map());
    const primaries = /** @type {Map<string, PrimaryEntry>} */ (outsideTree.get(row.epicKey));
    const primaryKey = row.isSubtask && row.parentKey ? row.parentKey : row.key;
    if (!primaries.has(primaryKey)) {
      primaries.set(primaryKey, { key: primaryKey, item: viewOf(primaryKey), counted: false, subtasks: [] });
    }
    const entry = /** @type {PrimaryEntry} */ (primaries.get(primaryKey));
    if (primaryKey === row.key) entry.counted = true;
    else entry.subtasks.push(item);
  }
  const outsideKeys = [...outsideTree.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : compareKeys(a, b)));
  const outsideEpics = outsideKeys.map((key) =>
    group(key, key === null ? null : (epicSummary.get(key) ?? null), /** @type {Map<string, PrimaryEntry>} */ (outsideTree.get(key))),
  );

  return {
    period: { from: period.from, to: period.to },
    kpis: kpisOf(moved.map((r) => /** @type {ItemView} */ (viewOf(r.key)))),
    layers,
    outside: { kpis: kpisOf(outsideMoved.map((r) => /** @type {ItemView} */ (viewOf(r.key)))), epics: outsideEpics },
    hygiene: hygieneNotes(layers, inEpics, viewOf),
  };
}

/** Last row wins per key, original order kept. @param {IssueRow[]} rows */
function dedupe(rows) {
  /** @type {Map<string, IssueRow>} */
  const byKey = new Map();
  for (const row of rows) byKey.set(row.key, row);
  return [...byKey.values()];
}

/**
 * @param {string | null} epicKey
 * @param {string | null} epicSummary
 * @param {Map<string, PrimaryEntry>} primaries
 * @returns {EpicGroup}
 */
function group(epicKey, epicSummary, primaries) {
  return {
    epicKey,
    epicSummary,
    primaries: [...primaries.values()]
      .sort((a, b) => compareKeys(a.key, b.key))
      .map((p) => ({ ...p, subtasks: [...p.subtasks].sort((a, b) => compareKeys(a.key, b.key)) })),
  };
}

/** Items counted in a group: counted primaries and every (moved) subtask. @param {EpicGroup} g */
function countedItems(g) {
  return g.primaries.flatMap((p) => [...(p.counted && p.item ? [p.item] : []), ...p.subtasks]);
}

/** @param {ItemView[]} items unique items @returns {Kpis} */
function kpisOf(items) {
  return {
    withMovement: items.length,
    primaries: items.filter((i) => !i.isSubtask).length,
    secondaries: items.filter((i) => i.isSubtask).length,
    closed: items.filter((i) => i.closedInPeriod).length,
    blocked: items.filter((i) => i.blocked).length,
  };
}

/**
 * Hygiene over the items the report shows (moved items and their primaries), sorted by key.
 * @param {LayerSection[]} layers
 * @param {IssueRow[]} inEpics every row of the team's epics (to know all the subtasks of a primary)
 * @param {(key: string) => ItemView | null} viewOf
 * @returns {HygieneNote[]}
 */
function hygieneNotes(layers, inEpics, viewOf) {
  /** @type {Map<string, ItemView>} */
  const shown = new Map();
  for (const section of layers) {
    for (const g of section.epics) {
      for (const p of g.primaries) {
        if (p.item) shown.set(p.key, p.item);
        for (const s of p.subtasks) shown.set(s.key, s);
      }
    }
  }
  /** @type {Map<string, string[]>} */
  const subtasksOf = new Map();
  for (const row of inEpics) {
    if (!row.isSubtask || !row.parentKey) continue;
    subtasksOf.set(row.parentKey, [...(subtasksOf.get(row.parentKey) ?? []), row.key]);
  }

  /** @type {HygieneNote[]} */
  const notes = [];
  for (const item of shown.values()) {
    if (item.moved && item.layers.length > 1) notes.push({ code: 'multiple_layers', key: item.key, layers: item.layers });
    if (!item.isSubtask && item.category !== 'done') {
      const subtaskKeys = [...(subtasksOf.get(item.key) ?? [])].sort(compareKeys);
      const subtasks = subtaskKeys.map(viewOf);
      if (subtasks.length > 0 && subtasks.every((s) => s !== null && s.category === 'done')) {
        notes.push({ code: 'parent_open_all_subtasks_done', key: item.key, subtaskKeys });
      }
    }
  }
  for (const row of inEpics) {
    const item = shown.get(row.key);
    if (!item || !item.isSubtask || item.category === 'done' || !row.parentKey) continue;
    const parent = viewOf(row.parentKey);
    if (parent && parent.category === 'done') {
      notes.push({ code: 'subtask_open_under_done_parent', key: row.key, parentKey: row.parentKey });
    }
  }
  const codeOrder = ['multiple_layers', 'parent_open_all_subtasks_done', 'subtask_open_under_done_parent'];
  return notes.sort((a, b) => compareKeys(a.key, b.key) || codeOrder.indexOf(a.code) - codeOrder.indexOf(b.code));
}
