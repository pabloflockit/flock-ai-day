import { COMPONENT_LAYERS } from '../../shared/contracts.mjs';
import { validateJiraUrl } from '../../shared/jira-url.mjs';

/**
 * A valid Jira URL is stored as its canonical origin (`https://host`, lower-case, no path or
 * trailing slash) so every writer stores the same value. Invalid input is returned unchanged:
 * `validateConfig` must still see it and reject it instead of it being silently "fixed".
 * @param {string} value
 */
function canonicalBaseUrl(value) {
  const result = validateJiraUrl(value);
  return result.ok ? result.origin : value;
}

/**
 * `normalizeConfig` is the ONLY place where the shape of the configuration is defined and
 * migrated (architecture §8.4). It is a whitelist: unknown keys are dropped, invalid values fall
 * back to defaults, and secrets can never survive (the Jira token and AI key live in safeStorage;
 * there is no field for them). Idempotent: `normalize(normalize(x))` equals `normalize(x)`.
 *
 * Migration: bump `CONFIG_VERSION` and branch on `raw.version` at the top of `normalizeConfig`
 * to upgrade old shapes before the whitelist runs.
 *
 * Identity is never invented: teams, members, projects without an id/accountId and epics without
 * a key are dropped (the UI always creates ids).
 *
 * Shape: see `docs/plan.md` §2.1.
 *
 * @typedef {'task' | 'subtask' | 'both'} WorkUnit
 * @typedef {{ kind: 'count' } | { kind: 'field', fieldId: string, fieldName: string, valueType: 'number' | 'time_seconds' }} Measure
 * @typedef {{ accountId: string, displayName: string, emailAddress: string | null, jiraActive: boolean, active: boolean, refreshedAt: string }} Member
 * @typedef {{ id: string, name: string, description: string | null, active: boolean, members: Member[] }} Team
 * @typedef {{ key: string, issueTypeId: string, summary: string, active: boolean, linkMethodUsed: 'parent' | 'epic_link' | null }} Epic
 * @typedef {{ projectKey: string, componentId: string, componentName: string, layer: 'frontend' | 'backend' | 'functional' }} ComponentLayer
 * @typedef {{ id: string, teamId: string, name: string, description: string | null, active: boolean, workUnit: WorkUnit, measure: Measure, epics: Epic[] }} Project
 * @typedef {{
 *   version: number,
 *   jira: { baseUrl: string, email: string, epicLinkMode: 'parent' | 'epic_link' | 'auto', epicLinkFieldId: string | null, timeoutMs: number, maxRetries: number, statusCategoryOverrides: Record<string, 'todo' | 'doing' | 'done'>, componentLayers: ComponentLayer[] },
 *   settings: { staleBusinessDays: number, agingBusinessDays: number, fullRefreshMaxAgeHours: number, ai: { enabled: boolean } },
 *   teams: Team[],
 *   projects: Project[],
 * }} AppConfig
 */

export const CONFIG_VERSION = 1;

/** @param {unknown} v @returns {Record<string, any>} */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {any} */ (v) : {});
/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v : []);
/** @param {unknown} v @param {string} d */
const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d);
/** @param {unknown} v @returns {string | null} */
const strOrNull = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
/** @param {unknown} v @param {boolean} d */
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
/** @param {unknown} v @param {number} d @param {number} min */
const int = (v, d, min) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min ? v : d;
/** @template T @param {unknown} v @param {readonly T[]} allowed @param {T} d @returns {T} */
const oneOf = (v, allowed, d) => (allowed.includes(/** @type {any} */ (v)) ? /** @type {T} */ (v) : d);

const CATEGORIES = /** @type {const} */ (['todo', 'doing', 'done']);

/** @param {unknown} raw @returns {Member | null} */
function normalizeMember(raw) {
  const m = obj(raw);
  const accountId = str(m.accountId);
  if (!accountId) return null;
  return {
    accountId,
    displayName: str(m.displayName),
    emailAddress: strOrNull(m.emailAddress),
    jiraActive: bool(m.jiraActive, true),
    active: bool(m.active, true),
    refreshedAt: str(m.refreshedAt),
  };
}

/** @param {unknown} raw @returns {Team | null} */
function normalizeTeam(raw) {
  const t = obj(raw);
  const id = str(t.id);
  if (!id) return null;
  return {
    id,
    name: str(t.name),
    description: strOrNull(t.description),
    active: bool(t.active, true),
    members: arr(t.members).map(normalizeMember).filter((m) => m !== null),
  };
}

/** @param {unknown} raw @returns {Epic | null} */
function normalizeEpic(raw) {
  const e = obj(raw);
  const key = str(e.key);
  if (!key) return null;
  return {
    key,
    issueTypeId: str(e.issueTypeId),
    summary: str(e.summary),
    active: bool(e.active, true),
    linkMethodUsed: oneOf(e.linkMethodUsed, ['parent', 'epic_link', null], null),
  };
}

/** @param {unknown} raw @returns {Measure} */
function normalizeMeasure(raw) {
  const m = obj(raw);
  const fieldId = str(m.fieldId);
  if (m.kind === 'field' && fieldId) {
    return {
      kind: 'field',
      fieldId,
      fieldName: str(m.fieldName),
      valueType: oneOf(m.valueType, ['number', 'time_seconds'], 'number'),
    };
  }
  return { kind: 'count' };
}

/** @param {unknown} raw @returns {Project | null} */
function normalizeProject(raw) {
  const p = obj(raw);
  const id = str(p.id);
  if (!id) return null;
  return {
    id,
    teamId: str(p.teamId),
    name: str(p.name),
    description: strOrNull(p.description),
    active: bool(p.active, true),
    workUnit: oneOf(p.workUnit, ['task', 'subtask', 'both'], 'task'),
    measure: normalizeMeasure(p.measure),
    epics: arr(p.epics).map(normalizeEpic).filter((e) => e !== null),
  };
}

/** @param {unknown} raw @returns {Record<string, 'todo' | 'doing' | 'done'>} */
function normalizeOverrides(raw) {
  /** @type {Record<string, 'todo' | 'doing' | 'done'>} */
  const out = {};
  for (const [statusId, category] of Object.entries(obj(raw))) {
    if (statusId.trim() !== '' && CATEGORIES.includes(/** @type {any} */ (category))) {
      out[statusId.trim()] = /** @type {any} */ (category);
    }
  }
  return out;
}

/**
 * Component -> layer mapping, by Jira project key + component id. An entry without a project key,
 * component id or a known layer is dropped; the same component twice keeps the LAST one (in the
 * position of the first). The project key is stored upper-case, like epic keys.
 * @param {unknown} raw @returns {ComponentLayer[]}
 */
function normalizeComponentLayers(raw) {
  /** @type {Map<string, ComponentLayer>} */
  const byComponent = new Map();
  for (const item of arr(raw)) {
    const e = obj(item);
    const projectKey = str(e.projectKey).toUpperCase();
    const componentId = str(e.componentId);
    if (!projectKey || !componentId || !COMPONENT_LAYERS.includes(e.layer)) continue;
    byComponent.set(`${projectKey}|${componentId}`, {
      projectKey,
      componentId,
      componentName: str(e.componentName),
      layer: e.layer,
    });
  }
  return [...byComponent.values()];
}

/**
 * @param {unknown} raw anything (a stored document, a request body, `undefined`)
 * @returns {AppConfig}
 */
export function normalizeConfig(raw) {
  const root = obj(raw);
  const jira = obj(root.jira);
  const settings = obj(root.settings);
  return {
    version: CONFIG_VERSION,
    jira: {
      baseUrl: canonicalBaseUrl(str(jira.baseUrl)),
      email: str(jira.email),
      epicLinkMode: oneOf(jira.epicLinkMode, ['parent', 'epic_link', 'auto'], 'auto'),
      epicLinkFieldId: strOrNull(jira.epicLinkFieldId),
      timeoutMs: int(jira.timeoutMs, 15000, 1),
      maxRetries: int(jira.maxRetries, 3, 0),
      statusCategoryOverrides: normalizeOverrides(jira.statusCategoryOverrides),
      componentLayers: normalizeComponentLayers(jira.componentLayers),
    },
    settings: {
      staleBusinessDays: int(settings.staleBusinessDays, 5, 1),
      agingBusinessDays: int(settings.agingBusinessDays, 10, 1),
      fullRefreshMaxAgeHours: int(settings.fullRefreshMaxAgeHours, 24, 1),
      ai: { enabled: bool(obj(settings.ai).enabled, false) },
    },
    teams: arr(root.teams).map(normalizeTeam).filter((t) => t !== null),
    projects: arr(root.projects).map(normalizeProject).filter((p) => p !== null),
  };
}
