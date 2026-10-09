import { ApiError, ERROR_CODES, errorEnvelope, okEnvelope } from '../shared/contracts.mjs';

/**
 * @typedef {{ method: string, path: string, query: URLSearchParams, headers: import('node:http').IncomingHttpHeaders, body?: any, params?: Record<string, string>, deps: any }} RouteContext
 * @typedef {(ctx: RouteContext) => Promise<any> | any} RouteHandler
 * @typedef {{ status: number, body: import('../shared/contracts.mjs').ApiEnvelope }} RouteResult
 */

/**
 * Tiny path router. Each path maps to a method → handler table. Exact paths win; otherwise a
 * pattern with `:name` segments matches one decoded segment each and fills `ctx.params`.
 * Handlers return the `data` payload; thrown errors become INTERNAL envelopes.
 */
export function createRouter() {
  /** @type {Map<string, Map<string, RouteHandler>>} */
  const table = new Map();
  /** @type {Array<{ segments: string[], methods: Map<string, RouteHandler> }>} */
  const patterns = [];

  /** @param {string} path @returns {{ methods: Map<string, RouteHandler>, params?: Record<string, string> } | null} */
  function resolve(path) {
    const exact = table.get(path);
    if (exact) return { methods: exact };
    const parts = path.split('/');
    for (const { segments, methods } of patterns) {
      if (segments.length !== parts.length) continue;
      /** @type {Record<string, string>} */
      const params = {};
      const matched = segments.every((segment, i) => {
        if (!segment.startsWith(':')) return segment === parts[i];
        if (parts[i] === '') return false;
        try {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } catch {
          return false;
        }
        return true;
      });
      if (matched) return { methods, params };
    }
    return null;
  }

  return {
    /**
     * @param {string} method
     * @param {string} path
     * @param {RouteHandler} handler
     */
    add(method, path, handler) {
      const isPattern = path.split('/').some((s) => s.startsWith(':'));
      let methods = table.get(path);
      if (!methods) {
        methods = new Map();
        table.set(path, methods);
        if (isPattern) patterns.push({ segments: path.split('/'), methods });
      }
      methods.set(method.toUpperCase(), handler);
    },

    /**
     * @param {RouteContext} ctx
     * @returns {Promise<RouteResult>}
     */
    async dispatch(ctx) {
      const found = resolve(ctx.path);
      if (!found) {
        return { status: 404, body: errorEnvelope(ERROR_CODES.NOT_FOUND, 'Route not found.') };
      }
      if (found.params) ctx.params = found.params;
      const handler = found.methods.get(ctx.method.toUpperCase());
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
          return { status: error.status, body: errorEnvelope(error.code, error.message, error.details) };
        }
        // Unknown errors may carry sensitive text: never forward their message.
        return { status: 500, body: errorEnvelope(ERROR_CODES.INTERNAL, 'Internal error.') };
      }
    },
  };
}
