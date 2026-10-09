import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

/**
 * Dataset sources the routes serve. `epicIssues` (scopeId = epic key) feeds the diagnostics page;
 * `memberIssues` (scopeId = team id, plus a required `since=YYYY-MM-DD`) feeds the sprint report.
 */
const SOURCES = new Set(['projectIssues', 'epicIssues', 'memberIssues']);
const MODES = new Set(['delta', 'full']);

/** @param {any} deps */
function requireDatasets(deps) {
  const service = deps.stores?.datasets;
  if (!service) {
    throw new ApiError(503, ERROR_CODES.STORAGE_UNAVAILABLE, 'Dataset storage is not available.');
  }
  return service;
}

/** @param {string | undefined} source */
function requireSource(source) {
  if (!source || !SOURCES.has(source)) {
    throw new ApiError(404, ERROR_CODES.NOT_FOUND, 'La fuente de datos no existe.');
  }
}

/** @param {URLSearchParams} query */
function requireScopeId(query) {
  const scopeId = (query.get('scopeId') ?? '').trim();
  if (!scopeId) {
    throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'Falta el parámetro scopeId.');
  }
  return scopeId;
}

/**
 * Reads one source's stored view. `since` is validated by the service (`memberIssues` only).
 * @param {any} service
 * @param {string} source
 * @param {string} scopeId
 * @param {URLSearchParams} query
 */
function readSource(service, source, scopeId, query) {
  if (source === 'epicIssues') return service.readEpic(scopeId);
  if (source === 'memberIssues') return service.readMembers(scopeId, query.get('since') ?? '');
  return service.read(scopeId);
}

/**
 * `GET  /api/datasets/:source?scopeId=`                      -> `{ rows, fetchedAt, isCurrent, shardsMeta }`
 * `GET  /api/datasets/:source/meta?scopeId=`                 -> the same without `rows` (admin screens).
 * `POST /api/datasets/:source/refresh?scopeId=&mode=delta|full` -> same shape, after refreshing.
 * `memberIssues` also needs `since=YYYY-MM-DD` on the three routes (missing/invalid -> 400).
 *
 * Never fetched: 200 with `rows: []` and `fetchedAt: null` (not an error: the front hydrates and
 * then refreshes). Unknown source or project -> 404 `NOT_FOUND`; `DATA_KEY_INVALID` is 409.
 *
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerDatasetRoutes(router) {
  router.add('GET', '/api/datasets/:source', ({ params, query, deps }) => {
    requireSource(params?.source);
    const scopeId = requireScopeId(query);
    return readSource(requireDatasets(deps), params.source, scopeId, query);
  });

  router.add('GET', '/api/datasets/:source/meta', ({ params, query, deps }) => {
    requireSource(params?.source);
    const scopeId = requireScopeId(query);
    const { fetchedAt, isCurrent, shardsMeta } = readSource(requireDatasets(deps), params.source, scopeId, query);
    return { fetchedAt, isCurrent, shardsMeta };
  });

  router.add('POST', '/api/datasets/:source/refresh', ({ params, query, deps }) => {
    requireSource(params?.source);
    const scopeId = requireScopeId(query);
    const mode = query.get('mode') ?? 'delta';
    if (!MODES.has(mode)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'El parámetro mode debe ser delta o full.');
    }
    const service = requireDatasets(deps);
    const refreshMode = /** @type {'delta' | 'full'} */ (mode);
    if (params.source === 'epicIssues') return service.refreshEpic(scopeId, refreshMode);
    if (params.source === 'memberIssues') return service.refreshMembers(scopeId, query.get('since') ?? '', refreshMode);
    return service.refresh(scopeId, refreshMode);
  });
}
