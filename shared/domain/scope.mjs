/**
 * Team scope (plan §4): which work units belong to a team's dashboard and which ones fall
 * outside it. Pure: no clock, no I/O, inputs are not mutated.
 *
 * @typedef {import('./work-units.mjs').WorkUnit} WorkUnit
 * @typedef {import('../../proxy/config/normalize.mjs').AppConfig} AppConfig
 * @typedef {{ unassigned: WorkUnit[], others: WorkUnit[] }} TeamOutside
 */

/**
 * Units of an active project of the team whose epic is an active epic of that project.
 *
 * @param {WorkUnit[]} units
 * @param {string} teamId
 * @param {Pick<AppConfig, 'projects'>} config
 * @returns {WorkUnit[]}
 */
function inTeamEpics(units, teamId, config) {
  const projects = new Map(config.projects.filter((p) => p.active && p.teamId === teamId).map((p) => [p.id, p]));
  return units.filter((u) => {
    const project = projects.get(u.projectId);
    return Boolean(project) && u.epicKey !== null && project.epics.some((e) => e.active && e.key === u.epicKey);
  });
}

/** @param {Pick<AppConfig, 'teams'>} config @param {string} teamId @returns {Set<string>} */
function activeMemberIds(config, teamId) {
  const team = config.teams.find((t) => t.id === teamId);
  return new Set((team?.members ?? []).filter((m) => m.active).map((m) => m.accountId));
}

/**
 * Units counted in the team: active project + active epic + active member of the team.
 *
 * @param {WorkUnit[]} units
 * @param {string} teamId
 * @param {Pick<AppConfig, 'teams' | 'projects'>} config
 * @returns {WorkUnit[]}
 */
export function teamScope(units, teamId, config) {
  if (!config.teams.some((t) => t.id === teamId)) return [];
  const members = activeMemberIds(config, teamId);
  return inTeamEpics(units, teamId, config).filter((u) => u.assigneeAccountId !== null && members.has(u.assigneeAccountId));
}

/**
 * Work of the team's projects/epics that the team scope leaves out. Includes done units
 * (metrics filter open themselves).
 *
 * @param {WorkUnit[]} units
 * @param {string} teamId
 * @param {Pick<AppConfig, 'teams' | 'projects'>} config
 * @returns {TeamOutside}
 */
export function teamOutside(units, teamId, config) {
  /** @type {TeamOutside} */
  const out = { unassigned: [], others: [] };
  if (!config.teams.some((t) => t.id === teamId)) return out;
  const members = activeMemberIds(config, teamId);
  for (const u of inTeamEpics(units, teamId, config)) {
    if (u.assigneeAccountId === null) out.unassigned.push(u);
    else if (!members.has(u.assigneeAccountId)) out.others.push(u);
  }
  return out;
}
