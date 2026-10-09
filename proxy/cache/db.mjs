import { mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite handle for the encrypted cache (architecture §5).
 *
 * Location is decided by the caller (`electron/main.cjs`):
 *  - packaged: `app.getPath('userData')` (survives updates);
 *  - `--dev`:  `<repo>/.cache/` (git-ignored).
 * The two locations differ, so switching between dev and packaged modes
 * looks like data loss: each mode has its own database. Document this wherever users see it.
 *
 * Every timestamp is produced in JS by the injected `now()` as ISO with `Z`. SQLite's
 * `datetime('now')` is never used (it returns zone-less text that is read as local time).
 */

/** Latest schema version. Add a migration to `MIGRATIONS` and bump this together. */
export const SCHEMA_VERSION = 1;

/** @type {ReadonlyArray<{ version: number, sql: string }>} */
const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE app_config (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        payload_enc BLOB NOT NULL,
        iv          BLOB NOT NULL,
        tag         BLOB NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE datasets (
        scope_id        TEXT NOT NULL,
        source          TEXT NOT NULL,
        params_key      TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        payload_enc     BLOB NOT NULL,
        iv              BLOB NOT NULL,
        tag             BLOB NOT NULL,
        fetched_at      TEXT NOT NULL,
        full_fetched_at TEXT NOT NULL,
        is_current      INTEGER NOT NULL,
        shards_meta     TEXT NOT NULL,
        PRIMARY KEY (scope_id, source, params_key)
      );
    `,
  },
];

const VERSION_KEY = 'schema_version';

/**
 * @param {DatabaseSync} db
 * @param {() => string} now
 */
function migrate(db, now) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(VERSION_KEY);
  const current = row ? Number(row.value) : 0;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The database schema (v${current}) is newer than this app supports (v${SCHEMA_VERSION}).`,
    );
  }
  const setMeta = db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const migration of MIGRATIONS.filter((m) => m.version > current)) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      if (current === 0 && migration.version === 1) setMeta.run('created_at', now());
      setMeta.run(VERSION_KEY, String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** @returns {string} */
const isoNow = () => new Date().toISOString();

/**
 * Opens (creating if needed) the database and applies pending migrations.
 *
 * The returned handle owns the live `DatabaseSync` (`handle.db`, re-pointed by
 * `renameAndRecreate`), so stores must read `handle.db` on each call and never keep it.
 *
 * @param {{ path: string, now?: () => string }} options `path` may be `':memory:'`
 */
export function openDatabase({ path: dbPath, now = isoNow }) {
  const open = () => {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, now);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  };

  const handle = {
    db: open(),
    path: dbPath,
    now,

    close() {
      handle.db.close();
    },

    /**
     * Explicit recovery action (never automatic): moves the current file aside as
     * `<name>.bak-<timestamp>` (never deletes it) and opens a fresh, empty database.
     * Use it when the data key cannot decrypt the existing data and the user accepts starting over.
     *
     * @returns {{ backupPath: string | null }} `null` for in-memory databases
     */
    renameAndRecreate() {
      handle.db.close();
      let backupPath = null;
      if (dbPath !== ':memory:') {
        // ':' is not allowed in Windows file names.
        const stamp = now().replace(/[:.]/g, '-');
        let candidate = `${dbPath}.bak-${stamp}`;
        for (let n = 2; existsSync(candidate); n += 1) candidate = `${dbPath}.bak-${stamp}-${n}`;
        renameSync(dbPath, candidate);
        backupPath = candidate;
      }
      handle.db = open();
      return { backupPath };
    },
  };
  return handle;
}
