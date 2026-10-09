import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { AI_ERROR_CODES, draftNarrative } from '../ai/anthropic.mjs';

export const MAX_AI_INPUT_BYTES = 64 * 1024;

/** @param {unknown} value */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/**
 * `POST /api/reports/ai` body `{ input }` -> `{ text, demo }`. The proxy is the only caller of the
 * provider; the key is read in-process and never returned. Disabled -> AI_DISABLED, no key -> AI_KEY_MISSING.
 *
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerAiRoutes(router) {
  router.add('POST', '/api/reports/ai', async ({ body, deps }) => {
    let enabled = false;
    try {
      enabled = deps.stores?.config?.load().settings.ai.enabled === true;
    } catch {
      enabled = false;
    }
    if (!enabled) throw new ApiError(403, AI_ERROR_CODES.DISABLED, 'La redacción con IA está desactivada.');
    const apiKey = deps.secrets?.getAiKey?.();
    if (typeof apiKey !== 'string' || apiKey === '') {
      throw new ApiError(409, AI_ERROR_CODES.KEY_MISSING, 'Falta guardar la clave de IA.');
    }
    const input = body?.input;
    if (!isPlainObject(input)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, '"input" must be an object.');
    }
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_AI_INPUT_BYTES) {
      throw new ApiError(413, ERROR_CODES.PAYLOAD_TOO_LARGE, '"input" is too large.');
    }
    if (typeof deps.aiDemo === 'function') return { text: deps.aiDemo(input), demo: true };
    const text = await draftNarrative({
      fetchImpl: deps.fetch,
      apiKey,
      input,
      timeoutMs: deps.aiTimeoutMs,
    });
    return { text, demo: false };
  });
}
