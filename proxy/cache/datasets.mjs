import { buildAad, decryptJson, encryptJson } from './crypto.mjs';

/**
 * Cached datasets (architecture §5.2, §6.5, §6.6). Only technical keys, dates, versions and the
 * per-epic shard status are stored in clear; rows are AES-256-GCM encrypted. No derived values
 * (percentages, days in state, totals) are persisted: they are recomputed from rows + config.
 *
 * Stores take a context `{ handle, getDataKey }` where `handle` comes from `openDatabase`.
 * @typedef {{ handle: ReturnType<typeof import('./db.mjs').openDatabase>, getDataKey: () => Buffer }} CacheContext
 * @typedef {{ scopeId: string, source: string, paramsKey: string }} DatasetId
 * @typedef {{ key: string, status: 'ok' | 'failed', lastOkAt: string | null, errorCode?: string | null }} ShardMeta
 * @typedef {{
 *   rows: any[], fetchedAt: string, fullFetchedAt: string, isCurrent: boolean,
 *   shardsMeta: ShardMeta[], payloadVersion: number,
 * }} DatasetEntry
 */

/**
 * Shape version of the stored rows. Increment whenever the row shape changes: it forces a full
 * refresh, otherwise a delta would keep rows in the old shape forever (architecture §6.5).
 */
export const PAYLOAD_VERSION = 1;

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** @param {string} value @param {string} name */
function assertIsoZ(value, name) {
  if (typeof value !== 'string' || !ISO_Z.test(value)) {
    throw new Error(`${name} must be an ISO timestamp ending with Z.`);
  }
}

/** @param {DatasetId} id */
const aadFor = ({ scopeId, source, paramsKey }) => buildAad('datasets', scopeId, source, paramsKey);

/**
 * @param {CacheContext} ctx
 * @param {DatasetId} id
 * @returns {DatasetEntry | null} `null` when absent. Throws `DATA_KEY_INVALID` when it cannot be
 *   decrypted; the row is left untouched.
 */
export function readDataset(ctx, id) {
  const row = ctx.handle.db
    .prepare(
      `SELECT payload_version, payload_enc, iv, tag, fetched_at, full_fetched_at, is_current, shards_meta
       FROM datasets WHERE scope_id = ? AND source = ? AND params_key = ?`,
    )
    .get(id.scopeId, id.source, id.paramsKey);
  if (!row) return null;
  const rows = decryptJson(
    ctx.getDataKey(),
    { payloadEnc: row.payload_enc, iv: row.iv, tag: row.tag },
    aadFor(id),
  );
  return {
    rows,
    fetchedAt: row.fetched_at,
    fullFetchedAt: row.full_fetched_at,
    isCurrent: row.is_current === 1,
    shardsMeta: JSON.parse(row.shards_meta),
    payloadVersion: row.payload_version,
  };
}

/**
 * Inserts or replaces a dataset. `fetchedAt` defaults to `now()`; `fullFetchedAt` defaults to
 * `fetchedAt` (a full load). A delta write must pass the previous entry's `fullFetchedAt`.
 *
 * @param {CacheContext} ctx
 * @param {DatasetId & {
 *   rows: any[], isCurrent?: boolean, shardsMeta?: ShardMeta[],
 *   fetchedAt?: string, fullFetchedAt?: string, payloadVersion?: number,
 * }} input
 */
export function writeDataset(ctx, input) {
  const fetchedAt = input.fetchedAt ?? ctx.handle.now();
  const fullFetchedAt = input.fullFetchedAt ?? fetchedAt;
  assertIsoZ(fetchedAt, 'fetchedAt');
  assertIsoZ(fullFetchedAt, 'fullFetchedAt');
  const sealed = encryptJson(ctx.getDataKey(), input.rows, aadFor(input));
  ctx.handle.db
    .prepare(
      `INSERT INTO datasets
         (scope_id, source, params_key, payload_version, payload_enc, iv, tag,
          fetched_at, full_fetched_at, is_current, shards_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, source, params_key) DO UPDATE SET
         payload_version = excluded.payload_version,
         payload_enc     = excluded.payload_enc,
         iv              = excluded.iv,
         tag             = excluded.tag,
         fetched_at      = excluded.fetched_at,
         full_fetched_at = excluded.full_fetched_at,
         is_current      = excluded.is_current,
         shards_meta     = excluded.shards_meta`,
    )
    .run(
      input.scopeId,
      input.source,
      input.paramsKey,
      input.payloadVersion ?? PAYLOAD_VERSION,
      sealed.payloadEnc,
      sealed.iv,
      sealed.tag,
      fetchedAt,
      fullFetchedAt,
      input.isCurrent === false ? 0 : 1,
      JSON.stringify(input.shardsMeta ?? []),
    );
}

/**
 * Whether a delta is not enough (architecture §6.5): no entry, row shape version mismatch, or the
 * last full load is older than the configured maximum age. A user request is handled by the caller.
 *
 * @param {Pick<DatasetEntry, 'payloadVersion' | 'fullFetchedAt'> | null | undefined} entry
 * @param {{ now: Date | number | string, fullRefreshMaxAgeHours: number, payloadVersion?: number }} options
 * @returns {boolean}
 */
export function needsFullRefresh(entry, { now, fullRefreshMaxAgeHours, payloadVersion = PAYLOAD_VERSION }) {
  if (!entry) return true;
  if (entry.payloadVersion !== payloadVersion) return true;
  const fullAt = Date.parse(entry.fullFetchedAt);
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(fullAt) || Number.isNaN(nowMs)) return true;
  return nowMs - fullAt > fullRefreshMaxAgeHours * 3_600_000;
}
