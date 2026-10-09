/**
 * The ONLY cache-key derivation, imported by the proxy and by Angular (architecture §8.3).
 * Keys are never built by hand. This module must stay free of Node built-ins (`node:crypto`
 * included) so it bundles for the browser.
 *
 * `paramsKey` is a stable hash of the parameters that CHANGE THE QUERY. Anything that only
 * filters on the client (members, names, view filters, status overrides) must not be passed in.
 */

const encoder = new TextEncoder();
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a over the UTF-8 bytes, as 16 lowercase hex digits. Deterministic and not a
 * security primitive: it only names a cache entry (scope and source are part of the row key too).
 * @param {string} text
 * @returns {string}
 */
export function hash64(text) {
  let h = FNV_OFFSET;
  for (const byte of encoder.encode(text)) {
    h = ((h ^ BigInt(byte)) * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Canonical JSON: object keys sorted, `undefined` properties dropped.
 * Every array is treated as a SET and sorted by its canonical JSON, because all current
 * query parameters (epic keys, field ids) are order-insensitive. If a future parameter is order
 * sensitive, encode it as a string or an object, not as an array.
 * Throws on values that have no stable JSON form (NaN, Infinity, functions, bigint, symbols).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Cache params cannot contain NaN or Infinity.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).sort().join(',')}]`;
      }
      const entries = Object.keys(value)
        .filter((k) => /** @type {any} */ (value)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new Error(`Cache params cannot contain a value of type ${typeof value}.`);
  }
}

/**
 * A scope is a plain id (a project id, 'global') or a typed ref such as `{ type: 'epic', id }`.
 * A typed ref becomes `<type>:<id>`, so ids of different types can never collide.
 * @typedef {string | { type: string, id: string }} Scope
 */

/** @param {Scope} scope @returns {string} */
function scopeIdOf(scope) {
  if (typeof scope === 'string') return scope;
  if (!scope || typeof scope.type !== 'string' || !scope.type || typeof scope.id !== 'string' || !scope.id) {
    throw new Error('A typed scope needs a non-empty type and id.');
  }
  return `${scope.type}:${scope.id}`;
}

/**
 * @param {Scope} scope scope (e.g. a project id, `{ type: 'epic', id: 'KEY-1' }`, or 'global')
 * @param {string} source dataset source (e.g. 'projectIssues')
 * @param {unknown} params query-changing parameters
 * @returns {{ scopeId: string, paramsKey: string, cacheKey: string }}
 *   `scopeId` is the `scope_id` column; `paramsKey` is the `params_key` column; `cacheKey` is
 *   `scopeId|source|paramsKey`.
 */
export function resolveTarget(scope, source, params) {
  const scopeId = scopeIdOf(scope);
  const paramsKey = hash64(canonicalJson(params ?? {}));
  return { scopeId, paramsKey, cacheKey: `${scopeId}|${source}|${paramsKey}` };
}

/**
 * The query-changing parameters of a project's `projectIssues` dataset (docs/plan.md §2.3):
 * active epic keys (sorted), measure field ids, `epicLinkMode` and `epicLinkFieldId`.
 * Deliberately absent: members, names, descriptions, view filters, fields maintained by the
 * sync (`summary`, `linkMethodUsed`, member data) and `statusCategoryOverrides`.
 *
 * @param {import('../proxy/config/normalize.mjs').Project} project
 * @param {import('../proxy/config/normalize.mjs').AppConfig} config
 */
export function projectIssuesParams(project, config) {
  return {
    epicKeys: project.epics
      .filter((epic) => epic.active)
      .map((epic) => epic.key)
      .sort(),
    measureFieldIds: project.measure.kind === 'field' ? [project.measure.fieldId] : [],
    epicLinkMode: config.jira.epicLinkMode,
    epicLinkFieldId: config.jira.epicLinkFieldId,
  };
}

/**
 * Query-changing parameters of a team's `memberIssues` dataset (sprint report): the ACTIVE
 * members' account ids (sorted), the period start and the `jira` link config (it decides which
 * fields are requested and how epics are resolved). Unlike `projectIssues`, members are part of
 * the key here because they ARE the query (`assignee in (...)`). Names stay out.
 *
 * @param {import('../proxy/config/normalize.mjs').Team} team
 * @param {string} since `YYYY-MM-DD`
 * @param {import('../proxy/config/normalize.mjs').AppConfig} config
 */
export function memberIssuesParams(team, since, config) {
  return {
    accountIds: team.members
      .filter((member) => member.active)
      .map((member) => member.accountId)
      .sort(),
    since,
    epicLinkMode: config.jira.epicLinkMode,
    epicLinkFieldId: config.jira.epicLinkFieldId,
  };
}

/**
 * In-memory project that stands for a single epic (diagnostics `epicIssues` source). It is never
 * stored in the configuration.
 * @param {string} epicKey
 * @returns {import('../proxy/config/normalize.mjs').Project}
 */
export function epicProject(epicKey) {
  return {
    id: `epic:${epicKey}`,
    teamId: '',
    name: epicKey,
    description: null,
    active: true,
    workUnit: 'task',
    measure: { kind: 'count' },
    epics: [{ key: epicKey, issueTypeId: '', summary: '', active: true, linkMethodUsed: null }],
  };
}

/**
 * Query-changing parameters of `epicIssues`: the same derivation as a project with this one epic,
 * so the key moves with the current `jira` link mode exactly like `projectIssues`.
 * @param {string} epicKey
 * @param {import('../proxy/config/normalize.mjs').AppConfig} config
 */
export function epicIssuesParams(epicKey, config) {
  return projectIssuesParams(epicProject(epicKey), config);
}
