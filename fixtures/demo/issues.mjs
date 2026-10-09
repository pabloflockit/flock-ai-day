import { DEMO_BASE_URL, EPIC_LINK_FIELD_ID, STORY_POINTS_FIELD_ID } from './constants.mjs';

/**
 * Hand-written, fictional issues in the shape Jira Cloud returns them. Everything is invented:
 * keys, summaries and people. Full recorded and anonymized fixtures belong to flow 2.
 *
 * Layout: DEMO-1 and DEMO-2 are healthy epics; DEMO-3 is the epic whose searches answer 400
 * (see `FAILING_EPICS`), used to show the stale-not-empty degradation. DEMO-25 (not configured)
 * and DEMO-28 (no epic) are member work outside the team's epics.
 *
 * Status ids: 1 To Do, 2 In Progress, 3 In Review, 4 Done, 5 Blocked.
 * Type ids: 10000 Epic, 10001 Story, 10002 Task, 10003 Bug, 10004 Sub-task, 10005/10006 Improvement.
 * Moves are `[when, fromStatusId, toStatusId]`, oldest first, in UTC.
 * Components (fictional, one list per demo project): 20001 FRONTEND, 20002 BACKEND (layers, on
 * development subtasks), 20003 Onboarding, 20004 Reporting (areas, on some primaries), 20005 QA (functional follow-up).
 */

/** Project key -> id of the fictional demo project. */
export const DEMO_PROJECT_ID = '10100';

/** The fictional components of the demo project, in the shape of `GET /project/{key}/components`. */
export const DEMO_COMPONENTS = Object.freeze([
  { id: '20001', name: 'FRONTEND' },
  { id: '20002', name: 'BACKEND' },
  { id: '20003', name: 'Onboarding' },
  { id: '20004', name: 'Reporting' },
  { id: '20005', name: 'QA' },
]);

/** Epics whose child searches return 400 unless a test overrides it. */
export const FAILING_EPICS = Object.freeze(['DEMO-3']);

const STATUS = {
  1: { name: 'To Do', category: 'new' },
  2: { name: 'In Progress', category: 'indeterminate' },
  3: { name: 'In Review', category: 'indeterminate' },
  4: { name: 'Done', category: 'done' },
  5: { name: 'Blocked', category: 'indeterminate' },
};
const TYPE = {
  10000: 'Epic',
  10001: 'Story',
  10002: 'Task',
  10003: 'Bug',
  10004: 'Sub-task',
  10005: 'Improvement',
  10006: 'Improvement',
};
const PEOPLE = {
  ana: { accountId: 'demo-account-001', displayName: 'Ana Demo' },
  ben: { accountId: 'demo-account-002', displayName: 'Ben Demo' },
  // Not a member of the seeded demo team: her open work shows in the outside view.
  carla: { accountId: 'demo-account-003', displayName: 'Carla Demo' },
};

/**
 * `epic` is the legacy Epic Link value of a child; `embedded` is how many history entries the
 * search result carries when the changelog is truncated (the rest needs the per-issue endpoint).
 *
 * @typedef {{
 *   key: string, type: number, summary: string, status: number, created: string,
 *   parent?: string, epic?: string, who?: 'ana' | 'ben' | 'carla', sp?: number | null, prio?: string,
 *   due?: string, comps?: number[], moves?: Array<[string, number, number]>, embedded?: number, updated?: string,
 * }} Row
 */

/** @type {Row[]} */
const TABLE = [
  // DEMO-1: healthy epic, 7 children, 3 subtasks
  { key: 'DEMO-1', type: 10000, summary: 'Demo: onboarding flow', status: 2, created: '2026-08-20T09:00', moves: [['2026-08-25T09:00', 1, 2]] },
  { key: 'DEMO-4', comps: [20003, 20001], type: 10001, summary: 'Demo: welcome screen', status: 4, created: '2026-09-01T09:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ana', sp: 5, due: '2026-09-10', moves: [['2026-09-02T10:00', 1, 2], ['2026-09-08T16:30', 2, 4]] },
  { key: 'DEMO-5', comps: [20003], type: 10001, summary: 'Demo: account setup wizard', status: 4, created: '2026-09-01T09:30', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ben', sp: 3, prio: 'High', due: '2026-09-12', moves: [['2026-09-03T10:00', 1, 2], ['2026-09-07T11:00', 2, 3], ['2026-09-09T15:00', 3, 4]], embedded: 1 },
  { key: 'DEMO-6', comps: [20003], type: 10002, summary: 'Demo: profile picture upload', status: 2, created: '2026-09-02T09:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ana', sp: 8, due: '2026-10-02', moves: [['2026-09-10T09:00', 1, 2]] },
  { key: 'DEMO-7', comps: [20005], type: 10003, summary: 'Demo: wizard shows wrong step count', status: 3, created: '2026-09-03T09:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ben', sp: 2, prio: 'High', moves: [['2026-09-14T09:00', 1, 2], ['2026-09-21T09:00', 2, 3]] },
  { key: 'DEMO-8', type: 10002, summary: 'Demo: email templates', status: 1, created: '2026-09-04T09:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'carla', sp: null },
  { key: 'DEMO-9', type: 10001, summary: 'Demo: tooltip tour', status: 1, created: '2026-09-04T10:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ben', sp: 0, prio: 'Low', due: '2026-10-30' },
  { key: 'DEMO-10', comps: [20002], type: 10005, summary: 'Demo: faster first load', status: 5, created: '2026-09-05T09:00', parent: 'DEMO-1', epic: 'DEMO-1', who: 'ana', sp: 3, moves: [['2026-09-15T09:00', 1, 2], ['2026-09-22T09:00', 2, 5]] },
  { key: 'DEMO-11', comps: [20001], type: 10004, summary: 'Demo: resize images', status: 4, created: '2026-09-10T09:00', parent: 'DEMO-6', who: 'ana', sp: null, moves: [['2026-09-11T09:00', 1, 2], ['2026-09-14T09:00', 2, 4]] },
  { key: 'DEMO-12', comps: [20002], type: 10004, summary: 'Demo: validate file type', status: 4, created: '2026-09-10T09:30', parent: 'DEMO-6', who: 'ben', sp: 1, moves: [['2026-09-12T09:00', 1, 2], ['2026-09-17T09:00', 2, 4]] },
  { key: 'DEMO-13', type: 10004, summary: 'Demo: copy review for welcome screen', status: 2, created: '2026-09-09T09:00', parent: 'DEMO-4', sp: 0, moves: [['2026-09-12T09:00', 1, 2]] },

  // DEMO-2: healthy epic, 6 children, 2 subtasks
  { key: 'DEMO-2', type: 10000, summary: 'Demo: reporting module', status: 2, created: '2026-08-22T09:00', moves: [['2026-08-28T09:00', 1, 2]] },
  { key: 'DEMO-14', comps: [20004], type: 10001, summary: 'Demo: weekly summary page', status: 4, created: '2026-09-01T11:00', parent: 'DEMO-2', epic: 'DEMO-2', who: 'ben', sp: 8, due: '2026-09-18', moves: [['2026-09-02T09:00', 1, 2], ['2026-09-16T17:00', 2, 4]] },
  { key: 'DEMO-15', comps: [20004, 20003, 20002], type: 10001, summary: 'Demo: export to markdown', status: 2, created: '2026-09-02T11:00', parent: 'DEMO-2', epic: 'DEMO-2', who: 'ana', sp: 5, due: '2026-10-05', moves: [['2026-09-18T09:00', 1, 2]] },
  { key: 'DEMO-16', type: 10002, summary: 'Demo: chart legend wording', status: 1, created: '2026-09-03T11:00', parent: 'DEMO-2', epic: 'DEMO-2', sp: 2 },
  { key: 'DEMO-17', comps: [20004, 20005], type: 10003, summary: 'Demo: totals ignore empty rows', status: 4, created: '2026-09-04T11:00', parent: 'DEMO-2', epic: 'DEMO-2', who: 'ana', sp: 1, prio: 'High', moves: [['2026-09-05T09:00', 1, 2], ['2026-09-06T09:00', 2, 4]] },
  { key: 'DEMO-18', comps: [20001, 20002], type: 10006, summary: 'Demo: print layout', status: 3, created: '2026-09-05T11:00', parent: 'DEMO-2', epic: 'DEMO-2', who: 'ben', sp: null, moves: [['2026-09-19T09:00', 1, 2], ['2026-09-25T09:00', 2, 3]] },
  { key: 'DEMO-24', type: 10001, summary: 'Demo: shareable report link', status: 2, created: '2026-09-20T09:00', parent: 'DEMO-2', epic: 'DEMO-2', who: 'carla', sp: 3, moves: [['2026-09-23T09:00', 1, 2]] },
  { key: 'DEMO-19', comps: [20002], type: 10004, summary: 'Demo: markdown table escaping', status: 2, created: '2026-09-18T09:00', parent: 'DEMO-15', who: 'ana', sp: null, moves: [['2026-09-19T09:00', 1, 2]] },
  { key: 'DEMO-20', comps: [20001], type: 10004, summary: 'Demo: file name suggestion', status: 4, created: '2026-09-18T09:30', parent: 'DEMO-15', who: 'ben', sp: 0, moves: [['2026-09-20T09:00', 1, 2], ['2026-09-22T09:00', 2, 4]] },

  // DEMO-3: epic whose searches fail (400) in the default demo
  { key: 'DEMO-3', type: 10000, summary: 'Demo: legacy migration', status: 1, created: '2026-08-30T09:00' },
  { key: 'DEMO-21', type: 10002, summary: 'Demo: inventory of old records', status: 4, created: '2026-09-06T09:00', parent: 'DEMO-3', epic: 'DEMO-3', who: 'ana', sp: 3, moves: [['2026-09-07T09:00', 1, 2], ['2026-09-09T09:00', 2, 4]] },
  { key: 'DEMO-22', type: 10002, summary: 'Demo: map old fields', status: 2, created: '2026-09-06T10:00', parent: 'DEMO-3', epic: 'DEMO-3', who: 'ben', sp: 5, moves: [['2026-09-10T09:00', 1, 2]] },
  { key: 'DEMO-23', type: 10001, summary: 'Demo: dry run report', status: 1, created: '2026-09-06T11:00', parent: 'DEMO-3', epic: 'DEMO-3', sp: null },

  // DEMO-25: an epic of another team (not in the demo config). The members' work under it, and
  // DEMO-28 without any epic, is the sprint report's "outside the team's epics" section. DEMO-26
  // belongs to a non-member, so its subtask's epic needs the parent lookup.
  { key: 'DEMO-25', type: 10000, summary: 'Demo: support rotation', status: 2, created: '2026-09-15T09:00', moves: [['2026-09-16T09:00', 1, 2]] },
  { key: 'DEMO-26', type: 10001, summary: 'Demo: triage incoming tickets', status: 2, created: '2026-09-16T09:00', parent: 'DEMO-25', epic: 'DEMO-25', who: 'carla', sp: 2, moves: [['2026-09-28T09:00', 1, 2]] },
  { key: 'DEMO-27', comps: [20002], type: 10004, summary: 'Demo: fix the export timeout', status: 4, created: '2026-10-01T09:00', parent: 'DEMO-26', who: 'ben', sp: null, moves: [['2026-10-02T09:00', 1, 2], ['2026-10-06T15:00', 2, 4]] },
  { key: 'DEMO-28', type: 10002, summary: 'Demo: help the sales demo', status: 2, created: '2026-10-02T09:00', who: 'ana', sp: null, moves: [['2026-10-03T10:00', 1, 2]] },
];

const COMPONENT_BY_ID = new Map(DEMO_COMPONENTS.map((c) => [c.id, c]));

/** @param {string} when e.g. `2026-09-02T10:00` */
const stamp = (when) => `${when}:00.000+0000`;
const num = (key) => Number(key.replace('DEMO-', ''));

/**
 * @param {Row} row
 * @returns {{ key: string, id: string, fields: Record<string, any>, history: any[], embedded: number | null }}
 */
function build(row) {
  const status = STATUS[row.status];
  const moves = row.moves ?? [];
  const history = moves.map(([when, from, to], i) => ({
    id: `${num(row.key)}${i}`,
    created: stamp(when),
    items: [
      {
        field: 'status',
        fieldId: 'status',
        from: String(from),
        fromString: STATUS[from].name,
        to: String(to),
        toString: STATUS[to].name,
      },
    ],
  }));
  const lastMove = moves.at(-1)?.[0] ?? row.created;
  const lastDone = [...moves].reverse().find(([, , to]) => STATUS[to].category === 'done');
  const person = row.who ? PEOPLE[row.who] : null;
  /** @type {Record<string, any>} */
  const fields = {
    summary: row.summary,
    issuetype: { id: String(row.type), name: TYPE[row.type] },
    status: {
      id: String(row.status),
      name: status.name,
      statusCategory: { key: status.category, name: status.name },
    },
    assignee: person ? { accountId: person.accountId, displayName: person.displayName } : null,
    priority: { name: row.prio ?? 'Medium' },
    created: stamp(row.created),
    updated: stamp(row.updated ?? lastMove),
    duedate: row.due ?? null,
    resolutiondate: lastDone ? stamp(lastDone[0]) : null,
    [STORY_POINTS_FIELD_ID]: row.type === 10000 ? null : (row.sp ?? null),
    [EPIC_LINK_FIELD_ID]: row.epic ?? null,
  };
  fields.components = (row.comps ?? []).map((id) => ({
    self: `${DEMO_BASE_URL}/rest/api/3/component/${id}`,
    id: String(id),
    name: COMPONENT_BY_ID.get(String(id)).name,
  }));
  if (row.parent) fields.parent = { key: row.parent };
  return { key: row.key, id: String(10000 + num(row.key)), fields, history, embedded: row.embedded ?? null };
}

/** @returns {ReturnType<typeof build>[]} issues ordered by key number */
export function buildIssues() {
  return TABLE.map(build).sort((a, b) => num(a.key) - num(b.key));
}
