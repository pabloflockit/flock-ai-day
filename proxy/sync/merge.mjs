import { normalizeConfig } from '../config/normalize.mjs';

/**
 * @typedef {{ displayName?: string, emailAddress?: string | null, active?: boolean }} JiraUser
 * @typedef {(
 *   | { status: 'ok', user: JiraUser }
 *   | { status: 'not_found' }
 *   | { status: 'error', errorCode: string }
 * )} MemberResult
 * @typedef {{ summary?: string | null, linkMethodUsed?: 'parent' | 'epic_link' | null }} EpicResult
 * @typedef {{ members?: Record<string, MemberResult>, epics?: Record<string, EpicResult> }} SyncResult
 */

/** @template T @param {Record<string, T> | undefined} map @param {string} key @returns {T | undefined} */
const own = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : undefined);

/**
 * Merges what a sync learned from Jira into the CURRENT configuration (architecture §6.7).
 *
 * Only these fields are written; everything else is returned untouched:
 *  - `teams[].members[]`: `displayName`, `emailAddress`, `jiraActive`, `refreshedAt`
 *  - `projects[].epics[]`: `summary`, `linkMethodUsed`
 *
 * Rules:
 *  - Members and epics are never added or removed; results for unknown ids are ignored.
 *  - A member Jira does not know any more (`not_found`) is kept with `jiraActive: false`.
 *  - A member whose lookup failed transiently (`error`) is left exactly as it was: a network
 *    hiccup must not mark people inactive.
 *  - `emailAddress` follows Jira when the response carries the field (it may be `null` for
 *    privacy); when the field is absent the stored value is kept.
 *  - An epic field is written only when the result carries it (`linkMethodUsed` is absent for a
 *    failed shard, so the previously detected method survives).
 *
 * None of these fields is part of a cache key, so a merge never moves `projectIssues` keys.
 * The caller passes a freshly loaded config so concurrent user edits are preserved.
 *
 * @param {import('../config/normalize.mjs').AppConfig} currentConfig
 * @param {SyncResult} syncResult
 * @param {{ now: string }} options ISO timestamp with `Z`
 * @returns {import('../config/normalize.mjs').AppConfig} a new, normalized config
 */
export function mergeSyncedFields(currentConfig, syncResult, { now }) {
  const members = syncResult?.members;
  const epics = syncResult?.epics;

  const next = {
    ...currentConfig,
    teams: currentConfig.teams.map((team) => ({
      ...team,
      members: team.members.map((member) => {
        const result = own(members, member.accountId);
        if (!result || result.status === 'error') return { ...member };
        if (result.status === 'not_found') return { ...member, jiraActive: false, refreshedAt: now };
        const user = result.user ?? {};
        return {
          ...member,
          displayName:
            typeof user.displayName === 'string' && user.displayName ? user.displayName : member.displayName,
          emailAddress: Object.hasOwn(user, 'emailAddress') ? (user.emailAddress ?? null) : member.emailAddress,
          jiraActive: user.active !== false,
          refreshedAt: now,
        };
      }),
    })),
    projects: currentConfig.projects.map((project) => ({
      ...project,
      epics: project.epics.map((epic) => {
        const result = own(epics, epic.key);
        if (!result) return { ...epic };
        return {
          ...epic,
          summary: typeof result.summary === 'string' && result.summary ? result.summary : epic.summary,
          linkMethodUsed: Object.hasOwn(result, 'linkMethodUsed') ? result.linkMethodUsed : epic.linkMethodUsed,
        };
      }),
    })),
  };
  return normalizeConfig(next);
}
