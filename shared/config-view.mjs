/**
 * Read-only views over a normalized config for the administration screens (docs/plan.md §6.1).
 * Pure functions: nothing here edits the config (see `config-edit.mjs` for that).
 *
 * @typedef {import('../proxy/config/normalize.mjs').AppConfig} AppConfig
 * @typedef {AppConfig['teams'][number]} Team
 * @typedef {{ accountId: string, displayName: string, emailAddress: string | null }} JiraUserHit
 */

/**
 * Avatar initials: first letter of the first and last word. `?` when there is no name.
 * @param {string} name
 */
export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toLocaleUpperCase('es-AR');
}

/**
 * One row per team with its counts (plan §6.1.2: members, projects and epics).
 * @param {AppConfig} config
 */
export function teamSummaries(config) {
  return config.teams.map((team) => {
    const projects = config.projects.filter((p) => p.teamId === team.id);
    return {
      team,
      members: team.members.length,
      activeMembers: team.members.filter((m) => m.active).length,
      projects: projects.length,
      epics: projects.reduce((sum, p) => sum + p.epics.length, 0),
    };
  });
}

/**
 * Jira user search results for a team (plan §6.1.3): whether the person is already in this team,
 * and the names of the other teams they belong to.
 * @param {AppConfig} config @param {string} teamId @param {JiraUserHit[]} users
 */
export function userSearchHits(config, teamId, users) {
  return users.map((user) => {
    const teams = config.teams.filter((t) => t.members.some((m) => m.accountId === user.accountId));
    return {
      user,
      inThisTeam: teams.some((t) => t.id === teamId),
      otherTeams: teams.filter((t) => t.id !== teamId).map((t) => t.name),
    };
  });
}
