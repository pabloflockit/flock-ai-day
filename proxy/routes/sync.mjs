import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

const MODES = new Set(['delta', 'full']);

/** @param {any} deps */
function requireSync(deps) {
  const sync = deps.sync;
  if (!sync) throw new ApiError(503, ERROR_CODES.STORAGE_UNAVAILABLE, 'La sincronización no está disponible.');
  return sync;
}

/**
 * `POST /api/sync`        body `{ mode?: 'delta' | 'full' }` -> current sync status (starts a run
 *                         unless one is in progress; the run continues in the background).
 * `GET  /api/sync/status` -> current sync status, for polling.
 *
 * Both answer 200 (the router has a single success status); `state` tells whether the run is
 * `running`, `done` or `error`.
 *
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerSyncRoutes(router) {
  router.add('POST', '/api/sync', ({ body, deps }) => {
    const mode = body && typeof body === 'object' && body.mode !== undefined ? body.mode : 'delta';
    if (!MODES.has(mode)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'El parámetro mode debe ser delta o full.');
    }
    return requireSync(deps).start({ mode });
  });

  router.add('GET', '/api/sync/status', ({ deps }) => requireSync(deps).status());
}
