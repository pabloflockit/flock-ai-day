import { ApiError, ERROR_CODES, errorEnvelope, okEnvelope } from '../shared/contracts.mjs';

/**
 * @typedef {{ method: string, path: string, query: URLSearchParams, headers: import('node:http').IncomingHttpHeaders, body?: any, deps: any }} RouteContext
 * @typedef {(ctx: RouteContext) => Promise<any> | any} RouteHandler
 * @typedef {{ status: number, body: import('../shared/contracts.mjs').ApiEnvelope }} RouteResult
 */

/**
 * Tiny exact-path router. Each path maps to a method → handler table.
 * Handlers return the `data` payload; thrown errors become INTERNAL envelopes.
 */
export function createRouter() {
  /** @type {Map<string, Map<string, RouteHandler>>} */
  const table = new Map();

  return {
    /**
     * @param {string} method
     * @param {string} path
     * @param {RouteHandler} handler
     */
    add(method, path, handler) {
      const methods = table.get(path) ?? new Map();
      methods.set(method.toUpperCase(), handler);
      table.set(path, methods);
    },

    /**
     * @param {RouteContext} ctx
     * @returns {Promise<RouteResult>}
     */
    async dispatch(ctx) {
      const methods = table.get(ctx.path);
      if (!methods) {
        return { status: 404, body: errorEnvelope(ERROR_CODES.NOT_FOUND, 'Route not found.') };
      }
      const handler = methods.get(ctx.method.toUpperCase());
      if (!handler) {
        return {
          status: 405,
          body: errorEnvelope(ERROR_CODES.METHOD_NOT_ALLOWED, 'Method not allowed.'),
        };
      }
      try {
        return { status: 200, body: okEnvelope(await handler(ctx)) };
      } catch (error) {
        if (error instanceof ApiError) {
          return { status: error.status, body: errorEnvelope(error.code, error.message) };
        }
        // Unknown errors may carry sensitive text: never forward their message.
        return { status: 500, body: errorEnvelope(ERROR_CODES.INTERNAL, 'Internal error.') };
      }
    },
  };
}
