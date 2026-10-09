import { ApiError } from '../../shared/contracts.mjs';
import { AI_ENDPOINT, AI_MAX_TOKENS, AI_MODEL, ANTHROPIC_VERSION, SYSTEM_PROMPT, userMessage } from './prompt.mjs';

export const AI_ERROR_CODES = Object.freeze({
  DISABLED: 'AI_DISABLED',
  KEY_MISSING: 'AI_KEY_MISSING',
  PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  TIMEOUT: 'AI_TIMEOUT',
  BAD_RESPONSE: 'AI_BAD_RESPONSE',
});

export const AI_TIMEOUT_MS = 60_000;

/**
 * One Messages API call. Errors carry stable codes and fixed messages: neither the key nor the raw
 * provider body is ever echoed.
 *
 * @param {{ fetchImpl: typeof fetch, apiKey: string, input: unknown, timeoutMs?: number }} options
 * @returns {Promise<string>} the raw model text
 */
export async function draftNarrative({ fetchImpl, apiKey, input, timeoutMs = AI_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Response} */
  let response;
  try {
    response = await fetchImpl(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage(input) }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const name = /** @type {any} */ (error)?.name;
    const code = /** @type {any} */ (error)?.code;
    if (controller.signal.aborted || name === 'AbortError' || name === 'TimeoutError') {
      throw new ApiError(504, AI_ERROR_CODES.TIMEOUT, 'El proveedor de IA tardó demasiado en responder.');
    }
    if (code === 'EGRESS_BLOCKED') {
      throw new ApiError(403, AI_ERROR_CODES.DISABLED, 'La IA está desactivada.');
    }
    throw new ApiError(502, AI_ERROR_CODES.PROVIDER_ERROR, 'No se pudo contactar al proveedor de IA.');
  }
  try {
    if (!response.ok) {
      throw new ApiError(
        502,
        AI_ERROR_CODES.PROVIDER_ERROR,
        response.status === 401 || response.status === 403
          ? 'El proveedor de IA rechazó la clave.'
          : 'El proveedor de IA devolvió un error.',
        { providerStatus: response.status },
      );
    }
    /** @type {any} */
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(502, AI_ERROR_CODES.BAD_RESPONSE, 'La respuesta del proveedor de IA no es válida.');
    }
    const text = (Array.isArray(data?.content) ? data.content : [])
      .filter((/** @type {any} */ part) => part?.type === 'text' && typeof part.text === 'string')
      .map((/** @type {any} */ part) => part.text)
      .join('');
    if (text.trim() === '') {
      throw new ApiError(502, AI_ERROR_CODES.BAD_RESPONSE, 'La respuesta del proveedor de IA no es válida.');
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}
