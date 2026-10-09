import { ApiError, ERROR_CODES, ISSUE_KEY_PATTERN } from '../../shared/contracts.mjs';
import { epicIssuesParams, epicProject, projectIssuesParams, resolveTarget } from '../../shared/cache-key.mjs';
import { PAYLOAD_VERSION, needsFullRefresh, readDataset, writeDataset } from '../cache/datasets.mjs';
import { fetchProjectIssues } from './hierarchy.mjs';

/**
 * Incremental refresh of a project's `projectIssues` dataset (architecture §6.5, §6.6).
 *
 * Pattern from the reference (its Jira proxy script): delta window with
 * a safety margin (~162-164, `resolveDeltaWindowMinutes` 1590-1604), full-fetch triggers
 * (`refreshAuditDataset` 1647-1685) and carrying cached rows of incomplete epics
 * (`preserveRowsOfIncompleteEpics` 1149-1181, including its version downgrade). Not ported: the
 * `jira_unreachable` flag (replaced by `is_current` + `shards_meta`), the module-level DB handle.
 */

export const SOURCE = 'projectIssues';
/** Diagnostics source: the rows of one epic, from a synthetic in-memory project (never in the config). */
export const EPIC_SOURCE = 'epicIssues';
/** Extra minutes added to the time since the last successful fetch of an epic. */
export const DELTA_SAFETY_MARGIN_MINUTES = 5;
const MS_PER_MINUTE = 60_000;

/**
 * Looks up an ACTIVE project and derives its cache identity. The key is always built by
 * `resolveTarget`, never by hand.
 * @param {import('../config/normalize.mjs').AppConfig} config
 * @param {string} projectId
 */
function resolveProject(config, projectId) {
  const project = config.projects.find((p) => p.id === projectId && p.active);
  if (!project) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'El proyecto no existe o está inactivo.');
  }
  const { scopeId, paramsKey, cacheKey } = resolveTarget(project.id, SOURCE, projectIssuesParams(project, config));
  return { project, id: { scopeId, source: SOURCE, paramsKey }, cacheKey };
}

/**
 * Cache identity of an epic's diagnostics dataset. The project is synthetic (`epic:<KEY>`, one
 * active epic, count measure) and the `jira` config is the current one; the key still comes from
 * `resolveTarget`.
 * @param {import('../config/normalize.mjs').AppConfig} config
 * @param {string} epicKey
 */
function resolveEpic(config, epicKey) {
  if (typeof epicKey !== 'string' || !ISSUE_KEY_PATTERN.test(epicKey)) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'La clave de la épica no es válida.');
  }
  const { scopeId, paramsKey, cacheKey } = resolveTarget(
    { type: 'epic', id: epicKey },
    EPIC_SOURCE,
    epicIssuesParams(epicKey, config),
  );
  return { project: epicProject(epicKey), id: { scopeId, source: EPIC_SOURCE, paramsKey }, cacheKey };
}

/** @param {{ rows: any[], fetchedAt: string | null, isCurrent: boolean, shardsMeta: any[] }} view */
const toView = ({ rows, fetchedAt, isCurrent, shardsMeta }) => ({ rows, fetchedAt, isCurrent, shardsMeta });

/**
 * Subtasks follow their parent: after a merge the parent's row is the freshest source for the epic.
 * @param {Map<string, any>} rows
 */
function reresolveEpicKeys(rows) {
  for (const row of rows.values()) {
    if (!row.isSubtask || !row.parentKey) continue;
    const parent = rows.get(row.parentKey);
    if (parent && parent.epicKey) row.epicKey = parent.epicKey;
  }
}

/**
 * Refreshes one project's dataset and returns the stored view.
 *
 * Full when `mode = 'full'` or `needsFullRefresh` (no entry, payload version, max age). A full
 * load replaces the cached rows of every epic that was fetched successfully (the only way to see
 * deleted or moved issues). A delta merges updated rows by `key` over the cached ones.
 *
 * The delta window is per epic: minutes since THAT epic's `lastOkAt` (the oldest one is used for
 * the group) plus a margin; an epic with no successful fetch yet is fetched in full. The dataset's
 * own `fetchedAt` is the time of the last attempt and is not used for windows, because a failed
 * epic would otherwise lose the updates made while it was failing.
 *
 * Degradation (never "empty"): a failed epic keeps its cached rows, its shard is marked `failed`
 * (keeping the previous `lastOkAt`) and the dataset gets `is_current = 0`. A first-ever fetch with a
 * failing epic stores no rows for it but still records it as failed.
 *
 * @param {{
 *   db: import('../cache/datasets.mjs').CacheContext,
 *   client: Parameters<typeof fetchProjectIssues>[0]['client'],
 *   config: import('../config/normalize.mjs').AppConfig,
 *   projectId: string,
 *   mode?: 'delta' | 'full',
 *   now?: string | (() => string),
 * }} options `now` is an ISO timestamp with `Z` (or a function returning one)
 */
export async function refreshProjectIssues({ db, client, config, projectId, mode = 'delta', now }) {
  return refreshTarget({ db, client, config, target: resolveProject(config, projectId), mode, now });
}

/**
 * Same as {@link refreshProjectIssues} for an epic of the diagnostics page (`epicIssues`).
 * @param {Omit<Parameters<typeof refreshProjectIssues>[0], 'projectId'> & { epicKey: string }} options
 */
export async function refreshEpicIssues({ db, client, config, epicKey, mode = 'delta', now }) {
  return refreshTarget({ db, client, config, target: resolveEpic(config, epicKey), mode, now });
}

/**
 * @param {Omit<Parameters<typeof refreshProjectIssues>[0], 'projectId'> & { target: ReturnType<typeof resolveProject> }} options
 */
async function refreshTarget({ db, client, config, target, mode = 'delta', now }) {
  const nowIso = typeof now === 'function' ? now() : (now ?? db.handle.now());
  const nowMs = Date.parse(nowIso);
  const { project, id } = target;
  const entry = readDataset(db, id);

  const full =
    mode === 'full' ||
    needsFullRefresh(entry, { now: nowIso, fullRefreshMaxAgeHours: config.settings.fullRefreshMaxAgeHours });
  const epics = project.epics.filter((epic) => epic.active);
  const previousMeta = new Map((entry?.shardsMeta ?? []).map((meta) => [meta.key, meta]));

  /** @type {typeof epics} */ const fullEpics = [];
  /** @type {typeof epics} */ const deltaEpics = [];
  let oldestOkMs = Infinity;
  for (const epic of epics) {
    const lastOkMs = Date.parse(previousMeta.get(epic.key)?.lastOkAt ?? '');
    if (full || Number.isNaN(lastOkMs)) {
      fullEpics.push(epic);
    } else {
      deltaEpics.push(epic);
      oldestOkMs = Math.min(oldestOkMs, lastOkMs);
    }
  }

  const cachedRows = entry?.rows ?? [];
  /** @type {Map<string, string[]>} cached child keys per epic, so a delta also covers their subtasks */
  const knownChildKeys = new Map();
  for (const row of cachedRows) {
    if (row.isSubtask || !row.epicKey) continue;
    const list = knownChildKeys.get(row.epicKey) ?? [];
    list.push(row.key);
    knownChildKeys.set(row.epicKey, list);
  }

  const shards = [];
  if (fullEpics.length > 0) {
    shards.push(
      ...(await fetchProjectIssues({
        client,
        project: { ...project, epics: fullEpics },
        config,
        sinceMinutes: null,
      })),
    );
  }
  if (deltaEpics.length > 0) {
    // Clock skew (a last success "in the future") never yields a window below the margin.
    const elapsed = Math.max(0, Math.ceil((nowMs - oldestOkMs) / MS_PER_MINUTE));
    shards.push(
      ...(await fetchProjectIssues({
        client,
        project: { ...project, epics: deltaEpics },
        config,
        sinceMinutes: elapsed + DELTA_SAFETY_MARGIN_MINUTES,
        knownChildKeys,
      })),
    );
  }
  const shardByKey = new Map(shards.map((shard) => [shard.key, shard]));
  const replaced = new Set(fullEpics.filter((e) => shardByKey.get(e.key)?.status === 'ok').map((e) => e.key));
  const activeKeys = new Set(epics.map((epic) => epic.key));

  // Cached rows survive unless their epic is gone/inactive or was just replaced by a full load.
  /** @type {Map<string, any>} */
  const merged = new Map();
  let carriedFromFailed = 0;
  for (const row of cachedRows) {
    if (!activeKeys.has(row.epicKey) || replaced.has(row.epicKey)) continue;
    merged.set(row.key, row);
    if (shardByKey.get(row.epicKey)?.status === 'failed') carriedFromFailed++;
  }
  for (const shard of shards) {
    if (shard.status !== 'ok') continue;
    for (const row of shard.rows) merged.set(row.key, row);
  }
  reresolveEpicKeys(merged);

  const shardsMeta = epics.map((epic) => {
    const shard = shardByKey.get(epic.key);
    if (shard?.status === 'ok') return { key: epic.key, status: /** @type {const} */ ('ok'), lastOkAt: nowIso };
    return {
      key: epic.key,
      status: /** @type {const} */ ('failed'),
      lastOkAt: previousMeta.get(epic.key)?.lastOkAt ?? null,
      errorCode: shard?.errorCode ?? ERROR_CODES.UNKNOWN,
    };
  });
  const isCurrent = shardsMeta.every((meta) => meta.status === 'ok');

  // A partial full load is not a full load; old-shape rows that had to be carried must not be
  // stamped with the new payload version, or the delta would keep them forever (§6.5).
  const fullFetchedAt = full ? (isCurrent ? nowIso : (entry?.fullFetchedAt ?? nowIso)) : entry.fullFetchedAt;
  const carriedOldShape = entry !== null && entry.payloadVersion !== PAYLOAD_VERSION && carriedFromFailed > 0;
  const payloadVersion = carriedOldShape ? entry.payloadVersion : PAYLOAD_VERSION;

  const rows = [...merged.values()];
  writeDataset(db, {
    ...id,
    rows,
    isCurrent,
    shardsMeta,
    fetchedAt: nowIso,
    fullFetchedAt,
    payloadVersion,
  });
  // Method that returned children per successful epic (`auto` detection), for the §6.7 sync.
  /** @type {Record<string, 'parent' | 'epic_link' | null>} */
  const linkMethods = {};
  for (const shard of shards) {
    if (shard.status === 'ok') linkMethods[shard.key] = shard.linkMethodUsed ?? null;
  }
  return { rows, fetchedAt: nowIso, isCurrent, shardsMeta, linkMethods };
}

/**
 * Read and refresh entry points for the routes. Refreshes of the same cache key are coalesced:
 * while one is in flight, an equal-or-weaker request (a delta, or anything while a full runs)
 * receives the same promise; a stronger request (full during a delta) runs right after it.
 *
 * @param {{
 *   db: import('../cache/datasets.mjs').CacheContext,
 *   client: Parameters<typeof fetchProjectIssues>[0]['client'],
 *   getConfig: () => import('../config/normalize.mjs').AppConfig,
 *   now?: () => string,
 * }} deps
 */
export function createProjectIssuesService({ db, client, getConfig, now = () => db.handle.now() }) {
  /** @type {Map<string, { mode: 'delta' | 'full', promise: Promise<any> }>} */
  const inFlight = new Map();

  /** @param {ReturnType<typeof resolveProject>} target */
  function readTarget({ id }) {
    const entry = readDataset(db, id);
    return entry ? toView(entry) : { rows: [], fetchedAt: null, isCurrent: false, shardsMeta: [] };
  }

  /**
   * @param {ReturnType<typeof resolveProject>} target
   * @param {'delta' | 'full'} mode
   * @param {(config: import('../config/normalize.mjs').AppConfig, mode: 'delta' | 'full', now: string) => Promise<any>} run
   */
  function refreshCoalesced({ cacheKey }, mode, run) {
    const current = inFlight.get(cacheKey);
    if (current && (current.mode === 'full' || mode === 'delta')) return current.promise;

    const start = () => run(getConfig(), mode, now());
    const started = current ? current.promise.then(start, start) : start();
    const promise = started.finally(() => {
      if (inFlight.get(cacheKey)?.promise === promise) inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, { mode, promise });
    return promise;
  }

  return {
    /**
     * The stored dataset. Never fetched -> `{ rows: [], fetchedAt: null, isCurrent: false,
     * shardsMeta: [] }` (200), so `fetchedAt === null` is the "no data yet" signal.
     * @param {string} projectId
     */
    read(projectId) {
      return readTarget(resolveProject(getConfig(), projectId));
    },

    /**
     * @param {string} projectId
     * @param {'delta' | 'full'} [mode]
     */
    refresh(projectId, mode = 'delta') {
      const target = resolveProject(getConfig(), projectId);
      return refreshCoalesced(target, mode, (config, m, nowIso) =>
        refreshProjectIssues({ db, client, config, projectId, mode: m, now: nowIso }),
      );
    },

    /**
     * Diagnostics source `epicIssues`: same envelope, degradation and coalescing, scoped by epic key.
     * @param {string} epicKey
     */
    readEpic(epicKey) {
      return readTarget(resolveEpic(getConfig(), epicKey));
    },

    /**
     * @param {string} epicKey
     * @param {'delta' | 'full'} [mode]
     */
    refreshEpic(epicKey, mode = 'delta') {
      const target = resolveEpic(getConfig(), epicKey);
      return refreshCoalesced(target, mode, (config, m, nowIso) =>
        refreshEpicIssues({ db, client, config, epicKey, mode: m, now: nowIso }),
      );
    },
  };
}
