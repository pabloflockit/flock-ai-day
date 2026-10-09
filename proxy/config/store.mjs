import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { buildAad, decryptJson, encryptJson } from '../cache/crypto.mjs';
import { normalizeConfig } from './normalize.mjs';
import { validateConfig } from './validate.mjs';

/**
 * The single encrypted `app_config` row (id = 1). The stored document is always normalized.
 *
 * @param {import('../cache/datasets.mjs').CacheContext} ctx
 */
export function createConfigStore(ctx) {
  const aad = buildAad('app_config', '1');

  /**
   * Current config, normalized. Defaults when nothing is stored yet. Throws `DATA_KEY_INVALID`
   * if the row cannot be decrypted (the row is never modified by a read).
   * @returns {import('./normalize.mjs').AppConfig}
   */
  function load() {
    const row = ctx.handle.db
      .prepare('SELECT payload_enc, iv, tag FROM app_config WHERE id = 1')
      .get();
    if (!row) return normalizeConfig(undefined);
    const stored = decryptJson(
      ctx.getDataKey(),
      { payloadEnc: row.payload_enc, iv: row.iv, tag: row.tag },
      aad,
    );
    return normalizeConfig(stored);
  }

  /**
   * normalize -> validate -> encrypt -> write. Rejects with `VALIDATION_FAILED` (issues in
   * `details.issues`) without touching the stored row. The existing row is decrypted first so a
   * wrong data key is reported instead of silently replacing data it cannot read.
   *
   * @param {unknown} raw
   * @returns {import('./normalize.mjs').AppConfig} the saved, normalized config
   */
  function save(raw) {
    const config = normalizeConfig(raw);
    const issues = validateConfig(config);
    if (issues.length > 0) {
      throw new ApiError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'The configuration has validation errors.',
        { issues },
      );
    }
    load(); // throws DATA_KEY_INVALID if the existing row is unreadable: never overwrite it
    const sealed = encryptJson(ctx.getDataKey(), config, aad);
    ctx.handle.db
      .prepare(
        `INSERT INTO app_config (id, payload_enc, iv, tag, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload_enc = excluded.payload_enc, iv = excluded.iv,
           tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run(sealed.payloadEnc, sealed.iv, sealed.tag, ctx.handle.now());
    return config;
  }

  return { load, save };
}
