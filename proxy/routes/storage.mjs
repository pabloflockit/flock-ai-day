import path from 'node:path';
import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

/**
 * Data-key recovery (architecture 4.5, always available): `renameAndRecreate()` moves the
 * current database aside and opens a fresh one. The old file is never deleted. Stores read
 * `handle.db` on every call, so config and dataset routes work again without a restart.
 *
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerStorageRoutes(router) {
  router.add('POST', '/api/storage/reset', ({ body, deps }) => {
    const handle = deps.storage?.handle;
    if (!handle) {
      throw new ApiError(503, ERROR_CODES.STORAGE_UNAVAILABLE, 'El almacenamiento local no está disponible.');
    }
    if (!body || typeof body !== 'object' || body.confirm !== 'RESET') {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'Falta la confirmación para crear una base nueva.');
    }
    const { backupPath } = handle.renameAndRecreate();
    return { backupFile: backupPath ? path.basename(backupPath) : null };
  });
}
