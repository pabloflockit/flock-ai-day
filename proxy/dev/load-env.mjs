import fs from 'node:fs';
import path from 'node:path';

/**
 * Development-only environment loader (architecture §4.3): `.env` and `.env.local` are read in
 * dev, never by a packaged build, and real environment variables always take precedence.
 *
 * Pattern from the reference (`scripts/load-env.mjs`): same parser rules. Changes: `packaged`
 * short-circuits before any file is touched, and the result lists key NAMES only, so a caller can
 * log what was loaded without ever holding a value in a log line.
 */

/**
 * Parses `KEY=VALUE` content. Blank lines and `#` comments are ignored, keys and values are
 * trimmed, one layer of surrounding quotes is stripped, and `=` after the first one belongs to
 * the value. No variable expansion, no multiline values.
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvContent(content) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/**
 * Loads `<rootDir>/.env` then `<rootDir>/.env.local` into `env`. Keys already present in `env`
 * win; between files `.env.local` wins. Missing or unreadable files are skipped. A packaged
 * build loads nothing.
 *
 * @param {{ rootDir: string, packaged: boolean, env?: Record<string, string | undefined> }} options
 * @returns {{ loaded: string[] }} names of the variables that were set (never their values)
 */
export function loadDevEnv({ rootDir, packaged, env = process.env }) {
  if (packaged) return { loaded: [] };
  /** @type {Record<string, string>} */
  const fromFiles = {};
  for (const name of ['.env', '.env.local']) {
    let content;
    try {
      content = fs.readFileSync(path.join(rootDir, name), 'utf8');
    } catch {
      continue;
    }
    Object.assign(fromFiles, parseEnvContent(content));
  }
  const loaded = [];
  for (const [key, value] of Object.entries(fromFiles)) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return { loaded };
}
