import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

/** Dataset sources the routes serve. Only `projectIssues` exists for now. */
const SOURCES = new Set(['projectIssues']);
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
 * `GET  /api/datasets/:source?scopeId=`                      -> `{ rows, fetchedAt, isCurrent, shardsMeta }`
 * `POST /api/datasets/:source/refresh?scopeId=&mode=delta|full` -> same shape, after refreshing.
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
    return requireDatasets(deps).read(scopeId);
  });

  router.add('POST', '/api/datasets/:source/refresh', ({ params, query, deps }) => {
    requireSource(params?.source);
    const scopeId = requireScopeId(query);
    const mode = query.get('mode') ?? 'delta';
    if (!MODES.has(mode)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'El parámetro mode debe ser delta o full.');
    }
    return requireDatasets(deps).refresh(scopeId, /** @type {'delta' | 'full'} */ (mode));
  });
}
