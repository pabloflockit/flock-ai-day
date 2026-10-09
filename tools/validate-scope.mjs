import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_KEY_PATTERN } from '../shared/contracts.mjs';
import { epicProject } from '../shared/cache-key.mjs';
import { validateJiraUrl } from '../shared/jira-url.mjs';
import { isDoing, isDone, isOpen } from '../shared/domain/status.mjs';
import { normalizeConfig } from '../proxy/config/normalize.mjs';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { fetchProjectIssues, SUBTASK_BATCH_SIZE } from '../proxy/jira/hierarchy.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { loadDevEnv } from '../proxy/dev/load-env.mjs';
import {
  DEMO_HOST,
  DEMO_TOKEN,
  buildDemoConfig,
  createDemoFetch,
} from '../fixtures/demo/index.mjs';

/**
 * Validation against Jira (architecture §10). The scope is fetched with the REAL hierarchy and
 * projection code (the rows the proxy builds), the client predicate is applied to those rows, an
 * independently written JQL is run, and the two results are compared by KEY SETS, never by
 * counts: equal totals can hide errors that cancel out.
 *
 *   node tools/validate-scope.mjs --epic KEY [--epic KEY2] [--predicate open|doing|done|all]
 *        [--epic-link-field customfield_N] [--demo]
 *
 * Credentials (not with `--demo`) come from JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, loaded
 * by the dev env loader (`.env` / `.env.local`; real environment variables win). Values are never
 * printed. Exit code: 0 match, 1 mismatch, 2 usage or fetch error.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PREDICATES = Object.freeze(['open', 'doing', 'done', 'all']);

const PREDICATE_FNS = {
  open: isOpen,
  doing: isDoing,
  done: isDone,
  all: () => true,
};
/** JQL for the same predicate, using Jira's own status categories (no client overrides). */
const PREDICATE_JQL = {
  open: 'statusCategory != "Done"',
  doing: 'statusCategory = "In Progress"',
  done: 'statusCategory = "Done"',
  all: null,
};
const EPIC_LINK_FIELD = /^customfield_(\d+)$/;

/**
 * Set comparison by key. Duplicates collapse; lists are sorted for stable output.
 * @param {Iterable<string>} predicateKeys
 * @param {Iterable<string>} jqlKeys
 */
export function compareKeySets(predicateKeys, jqlKeys) {
  const predicate = new Set(predicateKeys);
  const jql = new Set(jqlKeys);
  const onlyPredicate = [...predicate].filter((key) => !jql.has(key)).sort();
  const onlyJql = [...jql].filter((key) => !predicate.has(key)).sort();
  return {
    onlyPredicate,
    onlyJql,
    common: predicate.size - onlyPredicate.length,
    predicateCount: predicate.size,
    jqlCount: jql.size,
    ok: onlyPredicate.length === 0 && onlyJql.length === 0,
  };
}

/** Own quoting on purpose: the validator must not share the escaping it is checking. @param {string} value */
const q = (value) => `"${String(value).replace(/[\\"]/g, '\\$&')}"`;

/** @template T @param {readonly T[]} list @param {number} size */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * The independent side: keys matching the predicate according to JQL only.
 * Children of the epics (by `parent`, plus the Epic Link field when configured) and subtasks of
 * ALL those children: a subtask is in scope whatever its parent's status is.
 */
async function jqlKeys({ client, config, epicKeys, predicate }) {
  const clause = PREDICATE_JQL[predicate];
  const withClause = (jql) => (clause ? `${jql} AND ${clause}` : jql);
  const run = async (jql) => (await client.searchJql({ jql, fields: ['status'] })).map((i) => i.key);

  const epicList = epicKeys.map(q).join(',');
  const linkMatch = EPIC_LINK_FIELD.exec(config.jira.epicLinkFieldId ?? '');
  const byEpic = [`parent in (${epicList})`];
  if (config.jira.epicLinkMode !== 'parent' && linkMatch) {
    byEpic.push(`cf[${linkMatch[1]}] in (${epicList})`);
  }

  const allChildren = new Set();
  const matched = new Set();
  for (const jql of byEpic) {
    for (const key of await run(jql)) allChildren.add(key);
    for (const key of await run(withClause(jql))) matched.add(key);
  }
  for (const batch of chunk([...allChildren], SUBTASK_BATCH_SIZE)) {
    for (const key of await run(withClause(`parent in (${batch.map(q).join(',')})`))) matched.add(key);
  }
  return [...matched];
}

/**
 * @param {{
 *   client: Parameters<typeof fetchProjectIssues>[0]['client'] & { searchJql: Function },
 *   config: import('../proxy/config/normalize.mjs').AppConfig,
 *   epicKeys: string[],
 *   predicate?: 'open' | 'doing' | 'done' | 'all',
 * }} options
 * @returns {Promise<ReturnType<typeof compareKeySets> & { predicate: string, epicKeys: string[], hint?: string }>}
 * @throws when an epic cannot be fetched: comparing against a failed shard would prove nothing
 */
export async function validateScope({ client, config, epicKeys, predicate = 'open' }) {
  if (!Object.hasOwn(PREDICATE_FNS, predicate)) throw new RangeError(`Unknown predicate "${predicate}".`);
  const project = {
    ...epicProject(epicKeys[0]),
    id: 'validate-scope',
    epics: epicKeys.map((key) => ({ key, issueTypeId: '', summary: '', active: true, linkMethodUsed: null })),
  };
  const shards = await fetchProjectIssues({ client, project, config, sinceMinutes: null });
  const failed = shards.filter((shard) => shard.status === 'failed');
  if (failed.length > 0) {
    throw new Error(
      `Could not fetch the scope: ${failed.map((s) => `${s.key} (${s.errorCode})`).join(', ')}.`,
    );
  }
  const keep = PREDICATE_FNS[predicate];
  const predicateKeys = shards.flatMap((shard) => shard.rows).filter((row) => keep(row, config)).map((row) => row.key);
  const keysByJql = await jqlKeys({ client, config, epicKeys, predicate });

  const result = { ...compareKeySets(predicateKeys, keysByJql), predicate, epicKeys };
  if (result.predicateCount === 0 && result.jqlCount === 0) {
    return {
      ...result,
      hint: 'Both sides returned 0 matches: suspect this script first (JQL escaping, quotes, epic keys) before the data.',
    };
  }
  return result;
}

/** Client over the fictional demo site: no network, no credentials. */
export function createDemoValidationContext() {
  const config = buildDemoConfig();
  const fetchImpl = createGuardedFetch({
    fetchImpl: createDemoFetch(),
    getAllowedHosts: () => [DEMO_HOST],
  });
  const client = createJiraClient({
    getConfig: () => config,
    secrets: { getJiraToken: () => DEMO_TOKEN },
    fetchImpl,
    sleep: async () => {},
  });
  return { client, config };
}

/**
 * Client over the real Jira site, from the environment. Egress is limited to that one host.
 * @param {Record<string, string | undefined>} env
 * @param {{ epicLinkField: string | null }} options
 */
export function createEnvValidationContext(env, { epicLinkField }) {
  const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')} (see .env.example).`);
  }
  const url = validateJiraUrl(/** @type {string} */ (env.JIRA_BASE_URL));
  if (!url.ok) throw new Error(`JIRA_BASE_URL is not valid: ${url.reason}`);
  const config = normalizeConfig({
    jira: {
      baseUrl: url.origin,
      email: env.JIRA_EMAIL,
      epicLinkMode: 'auto',
      epicLinkFieldId: epicLinkField,
    },
  });
  const client = createJiraClient({
    getConfig: () => config,
    secrets: { getJiraToken: () => env.JIRA_API_TOKEN },
    fetchImpl: createGuardedFetch({ fetchImpl: globalThis.fetch, getAllowedHosts: () => [url.host] }),
  });
  return { client, config };
}

/**
 * @param {string[]} argv
 * @returns {{ epics: string[], predicate: 'open' | 'doing' | 'done' | 'all', demo: boolean, epicLinkField: string | null }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */ const epics = [];
  let predicate = 'open';
  let demo = false;
  /** @type {string | null} */ let epicLinkField = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value.`);
      return argv[i];
    };
    if (arg === '--epic') {
      const key = value();
      if (!ISSUE_KEY_PATTERN.test(key)) throw new Error(`"${key}" is not a valid issue key.`);
      epics.push(key);
    } else if (arg === '--predicate') {
      predicate = value();
      if (!PREDICATES.includes(predicate)) {
        throw new Error(`Unknown predicate "${predicate}" (use ${PREDICATES.join('|')}).`);
      }
    } else if (arg === '--epic-link-field') {
      epicLinkField = value();
      if (!EPIC_LINK_FIELD.test(epicLinkField)) throw new Error('--epic-link-field must look like customfield_N.');
    } else if (arg === '--demo') {
      demo = true;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  if (epics.length === 0) throw new Error('At least one --epic KEY is required.');
  return { epics, predicate: /** @type {any} */ (predicate), demo, epicLinkField };
}

/** @param {Awaited<ReturnType<typeof validateScope>>} r */
export function formatSummary(r) {
  return (
    `validate-scope: epics=${r.epicKeys.join(',')} predicate=${r.predicate} ` +
    `predicateCount=${r.predicateCount} jqlCount=${r.jqlCount} common=${r.common} ` +
    `onlyPredicate=${r.onlyPredicate.length} onlyJql=${r.onlyJql.length} -> ${r.ok ? 'OK' : 'MISMATCH'}`
  );
}

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, env?: Record<string, string | undefined>, rootDir?: string }} [io]
 *  `rootDir` is where `.env` / `.env.local` are looked up (the repository root by default).
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { out = console.log, env = process.env, rootDir = REPO_ROOT } = {}) {
  try {
    const args = parseArgs(argv);
    let context;
    if (args.demo) {
      context = createDemoValidationContext();
    } else {
      loadDevEnv({ rootDir, packaged: false, env });
      context = createEnvValidationContext(env, { epicLinkField: args.epicLinkField });
    }
    const result = await validateScope({ ...context, epicKeys: args.epics, predicate: args.predicate });
    if (result.onlyPredicate.length > 0) out(`onlyPredicate: ${result.onlyPredicate.join(', ')}`);
    if (result.onlyJql.length > 0) out(`onlyJql: ${result.onlyJql.join(', ')}`);
    if (result.hint) out(`hint: ${result.hint}`);
    out(formatSummary(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    // Messages come from our own code or the Jira client (static text); never the token.
    out(`validate-scope: ${error instanceof Error ? error.message : 'unexpected error'}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
