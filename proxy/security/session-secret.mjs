import { createHash, timingSafeEqual } from 'node:crypto';
import { ERROR_CODES, errorEnvelope } from '../../shared/contracts.mjs';

export const SECRET_HEADER = 'x-proxy-secret';

/** @param {string} value */
const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Guard that rejects (401) any request without the per-launch session secret.
 * Both sides are hashed first so `timingSafeEqual` gets equal-length buffers and the
 * comparison leaks neither content nor length.
 *
 * @param {string} secret
 */
export function createSecretGuard(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('A non-empty session secret is required.');
  }
  const expected = digest(secret);
  return (/** @type {import('../router.mjs').RouteContext} */ ctx) => {
    const provided = ctx.headers[SECRET_HEADER];
    if (typeof provided === 'string' && timingSafeEqual(digest(provided), expected)) {
      return null;
    }
    return {
      status: 401,
      body: errorEnvelope(ERROR_CODES.UNAUTHORIZED, 'Missing or invalid session secret.'),
    };
  };
}
