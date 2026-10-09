/**
 * Registers the health route.
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerHealthRoutes(router) {
  router.add('GET', '/api/health', ({ deps }) => ({ status: 'ok', version: deps.version }));
}
