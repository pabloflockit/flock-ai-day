import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM for everything the cache stores in `payload_enc` (architecture §4.5).
 * The key is the 32-byte data key from `secrets.getDataKey()`; it never leaves the process.
 *
 * Each write uses a fresh random 12-byte IV. The additional authenticated data (AAD) binds a
 * ciphertext to its row identity, so a valid ciphertext copied into another row fails to decrypt.
 *
 * @typedef {{ payloadEnc: Buffer, iv: Buffer, tag: Buffer }} Sealed
 */

/**
 * Row identity used as AAD. JSON-encoded so that no part can smuggle a separator into another.
 * @param {...string} parts e.g. `('datasets', scopeId, source, paramsKey)` or `('app_config', '1')`
 * @returns {string}
 */
export function buildAad(...parts) {
  return JSON.stringify(parts);
}

/** @param {Buffer} key */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error(`The data key must be a Buffer of ${KEY_BYTES} bytes.`);
  }
}

/**
 * @param {Buffer} key
 * @param {unknown} value any JSON-serialisable value
 * @param {string} aad
 * @returns {Sealed}
 */
export function encryptJson(key, value, aad) {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const payloadEnc = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return { payloadEnc, iv, tag: cipher.getAuthTag() };
}

/**
 * Decrypts and parses. Any failure (wrong key, tampering, wrong AAD, bad lengths) is the same
 * classified error: callers must never overwrite the stored row because of it.
 *
 * @param {Buffer} key
 * @param {{ payloadEnc: Uint8Array, iv: Uint8Array, tag: Uint8Array }} sealed
 * @param {string} aad
 * @returns {any}
 */
export function decryptJson(key, sealed, aad) {
  assertKey(key);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.payloadEnc)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw dataKeyInvalid();
  }
}

/** The message is static: it never includes data. */
export function dataKeyInvalid() {
  return new ApiError(
    409,
    ERROR_CODES.DATA_KEY_INVALID,
    'The stored data could not be decrypted with the current data key. Nothing was overwritten.',
  );
}
