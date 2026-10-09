import { ERROR_CODES } from '../../shared/contracts.mjs';
import { mapWithConcurrency } from '../jira/concurrency.mjs';
import { mergeSyncedFields } from './merge.mjs';

const MEMBER_CONCURRENCY = 6;
const EPIC_CONCURRENCY = 6;

/**
 * @typedef {{
 *   runId: string | null,
 *   state: 'idle' | 'running' | 'done' | 'error',
 *   mode: 'delta' | 'full' | null,
 *   startedAt: string | null,
 *   finishedAt: string | null,
 *   projects: { total: number, done: number, failed: number },
 *   members: { total: number, done: number, failed: number },
 *   failedEpics: Array<{ projectId: string, key: string, errorCode: string }>,
 *   error: { code: string, message: string } | null,
 * }} SyncStatus
 */

/** @returns {SyncStatus} */
function idleStatus() {
  return {
    runId: null,
    state: 'idle',
    mode: null,
    startedAt: null,
    finishedAt: null,
    projects: { total: 0, done: 0, failed: 0 },
    members: { total: 0, done: 0, failed: 0 },
    failedEpics: [],
    error: null,
  };
}

/** @param {unknown} reason */
const codeOf = (reason) =>
  reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string'
    ? reason.code
    : ERROR_CODES.UNKNOWN;

/**
 * The sync of architecture §6.7: refreshes every active project of every active team, then
 * refreshes the Jira-maintained config fields (members, epic summary / link method) and merges
 * them into the LATEST config. One run at a time; progress is exposed for polling.
 *
 * @param {{
 *   client: {
 *     user(accountId: string): Promise<any>,
 *     issue(key: string, options?: { fields?: string[] }): Promise<any>,
 *   },
 *   refreshProject: (projectId: string, mode: 'delta' | 'full') => Promise<{
 *     shardsMeta: Array<{ key: string, status: 'ok' | 'failed', errorCode?: string }>,
 *     linkMethods?: Record<string, 'parent' | 'epic_link' | null>,
 *   }>,
 *   loadConfig: () => import('../config/normalize.mjs').AppConfig,
 *   saveConfig: (config: import('../config/normalize.mjs').AppConfig) => unknown,
 *   now?: () => string,
 * }} deps
 */
export function createSyncService({ client, refreshProject, loadConfig, saveConfig, now = () => new Date().toISOString() }) {
  /** @type {SyncStatus} */ let status = idleStatus();
  /** @type {Promise<void>} */ let current = Promise.resolve();
  let counter = 0;

  const snapshot = () => structuredClone(status);

  /** @param {'delta' | 'full'} mode */
  async function run(mode) {
    try {
      const config = loadConfig();
      const activeTeams = config.teams.filter((team) => team.active);
      const activeTeamIds = new Set(activeTeams.map((team) => team.id));
      const projects = config.projects.filter((project) => project.active && activeTeamIds.has(project.teamId));
      const accountIds = [...new Set(activeTeams.flatMap((team) => team.members.map((m) => m.accountId)))];
      status.projects.total = projects.length;
      status.members.total = accountIds.length;

      /** @type {Record<string, import('./merge.mjs').EpicResult>} */
      const epics = Object.create(null);
      for (const project of projects) {
        try {
          const out = await refreshProject(project.id, mode);
          for (const meta of out.shardsMeta ?? []) {
            if (meta.status === 'failed') {
              status.failedEpics.push({ projectId: project.id, key: meta.key, errorCode: meta.errorCode ?? ERROR_CODES.UNKNOWN });
            } else if (out.linkMethods && Object.hasOwn(out.linkMethods, meta.key)) {
              epics[meta.key] = { linkMethodUsed: out.linkMethods[meta.key] };
            }
          }
          status.projects.done++;
        } catch {
          status.projects.failed++;
        }
      }

      const epicKeys = projects.flatMap((project) => project.epics.filter((e) => e.active).map((e) => e.key));
      const summaries = await mapWithConcurrency(epicKeys, EPIC_CONCURRENCY, (key) =>
        client.issue(key, { fields: ['summary'] }),
      );
      summaries.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const summary = result.value?.fields?.summary;
        if (typeof summary === 'string' && summary) {
          const key = epicKeys[index];
          epics[key] = { ...(epics[key] ?? {}), summary };
        }
      });

      /** @type {Record<string, import('./merge.mjs').MemberResult>} */
      const members = Object.create(null);
      const lookups = await mapWithConcurrency(accountIds, MEMBER_CONCURRENCY, (id) => client.user(id));
      lookups.forEach((result, index) => {
        const id = accountIds[index];
        if (result.status === 'fulfilled') {
          members[id] = { status: 'ok', user: result.value ?? {} };
          status.members.done++;
        } else if (codeOf(result.reason) === ERROR_CODES.NOT_FOUND) {
          members[id] = { status: 'not_found' };
          status.members.done++;
        } else {
          members[id] = { status: 'error', errorCode: codeOf(result.reason) };
          status.members.failed++;
        }
      });

      // Re-read right before writing so edits made while the sync ran are preserved.
      const latest = loadConfig();
      saveConfig(mergeSyncedFields(latest, { members, epics }, { now: now() }));
      status.state = 'done';
    } catch (error) {
      status.state = 'error';
      status.error = {
        code: codeOf(error),
        message: error instanceof Error ? error.message : 'Sync failed.',
      };
    } finally {
      status.finishedAt = now();
    }
  }

  return {
    /**
     * Starts a run unless one is in progress; either way returns the current status.
     * @param {{ mode?: 'delta' | 'full' }} [options]
     */
    start({ mode = 'delta' } = {}) {
      if (status.state === 'running') return snapshot();
      counter++;
      status = { ...idleStatus(), runId: `sync-${counter}`, state: 'running', mode, startedAt: now() };
      current = run(mode);
      return snapshot();
    },

    /** @returns {SyncStatus} */
    status: snapshot,

    /** Resolves when the current run (if any) has finished. */
    whenIdle: () => current,
  };
}
