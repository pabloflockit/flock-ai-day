import { guardDeleteProject, guardDeleteTeam } from '../proxy/config/validate.mjs';

/**
 * Pure edit operations over a normalized config for the administration screens
 * (docs/plan.md §2, §6.1). Each one returns a NEW config or the issues that block it; the input
 * is never modified. They check the rule they touch so the UI can react (for example, offer to
 * move an epic); the proxy still runs the full `validateConfig` on save.
 *
 * @typedef {import('../proxy/config/normalize.mjs').AppConfig} AppConfig
 * @typedef {AppConfig['teams'][number]} Team
 * @typedef {AppConfig['projects'][number]} Project
 * @typedef {{ code: string, path: string, message: string, ownerProjectId?: string }} EditIssue
 * @typedef {{ ok: true, config: AppConfig } | { ok: false, issues: EditIssue[] }} EditResult
 * @typedef {{ accountId: string, displayName: string, emailAddress: string | null, active: boolean }} JiraUser
 */

const WORK_UNITS = ['task', 'subtask', 'both'];

/** @param {string} s */
const nameKey = (s) => s.trim().toLowerCase();
/** @param {string} key */
export const epicKey = (key) => key.trim().toUpperCase();
/** @param {string | null | undefined} s */
const textOrNull = (s) => (s && s.trim() !== '' ? s.trim() : null);

/** @param {AppConfig} config @returns {EditResult} */
const done = (config) => ({ ok: true, config });
/** @returns {EditResult} */
const fail = (code, path, message, extra = {}) => ({ ok: false, issues: [{ code, path, message, ...extra }] });

/** @param {AppConfig} config @param {(draft: AppConfig) => EditResult | void} mutate */
function apply(config, mutate) {
  const draft = structuredClone(config);
  return mutate(draft) ?? done(draft);
}

/** @param {AppConfig} config @param {string} name @param {string | null} exceptId */
function teamNameIssue(config, name, exceptId) {
  if (name === '') return fail('TEAM_NAME_REQUIRED', 'name', 'El equipo necesita un nombre.');
  const taken = config.teams.some((t) => t.id !== exceptId && nameKey(t.name) === nameKey(name));
  return taken ? fail('TEAM_NAME_DUPLICATE', 'name', `Ya existe un equipo llamado "${name}".`) : null;
}

/** @param {AppConfig} config @param {string} name @param {string | null} exceptId */
function projectNameIssue(config, name, exceptId) {
  if (name === '') return fail('PROJECT_NAME_REQUIRED', 'name', 'El proyecto necesita un nombre.');
  const taken = config.projects.some((p) => p.id !== exceptId && nameKey(p.name) === nameKey(name));
  return taken ? fail('PROJECT_NAME_DUPLICATE', 'name', `Ya existe un proyecto llamado "${name}".`) : null;
}

const teamMissing = () => fail('TEAM_NOT_FOUND', 'teams', 'El equipo no existe.');
const projectMissing = () => fail('PROJECT_NOT_FOUND', 'projects', 'El proyecto no existe.');

// ---- Teams ----------------------------------------------------------------------------------

/** @param {AppConfig} config @param {{ id: string, name: string, description?: string | null }} team */
export function addTeam(config, team) {
  const name = team.name.trim();
  return (
    teamNameIssue(config, name, null) ??
    apply(config, (draft) => {
      draft.teams.push({ id: team.id, name, description: textOrNull(team.description), active: true, members: [] });
    })
  );
}

/**
 * @param {AppConfig} config @param {string} teamId
 * @param {{ name?: string, description?: string | null, active?: boolean }} patch
 */
export function updateTeam(config, teamId, patch) {
  const team = config.teams.find((t) => t.id === teamId);
  if (!team) return teamMissing();
  const name = patch.name === undefined ? team.name : patch.name.trim();
  return (
    teamNameIssue(config, name, teamId) ??
    apply(config, (draft) => {
      const target = /** @type {Team} */ (draft.teams.find((t) => t.id === teamId));
      target.name = name;
      if (patch.description !== undefined) target.description = textOrNull(patch.description);
      if (patch.active !== undefined) target.active = patch.active;
    })
  );
}

/** Plan §2.2: blocked while the team has projects. @param {AppConfig} config @param {string} teamId */
export function removeTeam(config, teamId) {
  const issues = guardDeleteTeam(config, teamId);
  if (issues.length > 0) return /** @type {EditResult} */ ({ ok: false, issues });
  return apply(config, (draft) => {
    draft.teams = draft.teams.filter((t) => t.id !== teamId);
  });
}

// ---- Members --------------------------------------------------------------------------------

/**
 * Members always come from Jira (plan §6.1): the Jira data is copied as-is.
 * @param {AppConfig} config @param {string} teamId @param {JiraUser} user @param {string} now ISO Z
 */
export function addMember(config, teamId, user, now) {
  const team = config.teams.find((t) => t.id === teamId);
  if (!team) return teamMissing();
  if (team.members.some((m) => m.accountId === user.accountId)) {
    return fail('MEMBER_DUPLICATE', 'members', `La persona ya está en el equipo "${team.name}".`);
  }
  return apply(config, (draft) => {
    const target = /** @type {Team} */ (draft.teams.find((t) => t.id === teamId));
    target.members.push({
      accountId: user.accountId,
      displayName: user.displayName,
      emailAddress: user.emailAddress ?? null,
      jiraActive: user.active,
      active: true,
      refreshedAt: now,
    });
  });
}

/** @param {AppConfig} config @param {string} teamId @param {string} accountId @param {(m: Team['members'][number], t: Team) => void | ((t: Team) => void)} change */
function changeMember(config, teamId, accountId, change) {
  const team = config.teams.find((t) => t.id === teamId);
  if (!team) return teamMissing();
  if (!team.members.some((m) => m.accountId === accountId)) {
    return fail('MEMBER_NOT_FOUND', 'members', 'La persona no está en el equipo.');
  }
  return apply(config, (draft) => {
    const target = /** @type {Team} */ (draft.teams.find((t) => t.id === teamId));
    change(/** @type {any} */ (target.members.find((m) => m.accountId === accountId)), target);
  });
}

/** @param {AppConfig} config @param {string} teamId @param {string} accountId @param {boolean} active */
export function setMemberActive(config, teamId, accountId, active) {
  return changeMember(config, teamId, accountId, (member) => {
    member.active = active;
  });
}

/** @param {AppConfig} config @param {string} teamId @param {string} accountId */
export function removeMember(config, teamId, accountId) {
  return changeMember(config, teamId, accountId, (_member, team) => {
    team.members = team.members.filter((m) => m.accountId !== accountId);
  });
}

/** Teams a person belongs to (plan §6.1: "si la persona ya está en otros equipos, se indica"). */
export function memberTeams(/** @type {AppConfig} */ config, /** @type {string} */ accountId) {
  return config.teams.filter((t) => t.members.some((m) => m.accountId === accountId));
}

// ---- Projects -------------------------------------------------------------------------------

/**
 * @param {AppConfig} config
 * @param {{ id: string, teamId: string, name: string, description?: string | null }} project
 */
export function addProject(config, project) {
  const name = project.name.trim();
  if (!config.teams.some((t) => t.id === project.teamId)) {
    return fail('PROJECT_TEAM_MISSING', 'teamId', 'El equipo elegido no existe.');
  }
  return (
    projectNameIssue(config, name, null) ??
    apply(config, (draft) => {
      draft.projects.push({
        id: project.id,
        teamId: project.teamId,
        name,
        description: textOrNull(project.description),
        active: true,
        workUnit: 'task',
        measure: { kind: 'count' },
        epics: [],
      });
    })
  );
}

/**
 * @param {AppConfig} config @param {string} projectId
 * @param {{ name?: string, description?: string | null, active?: boolean, workUnit?: string, measure?: Project['measure'] }} patch
 */
export function updateProject(config, projectId, patch) {
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return projectMissing();
  if (patch.workUnit !== undefined && !WORK_UNITS.includes(patch.workUnit)) {
    return fail('PROJECT_WORK_UNIT_INVALID', 'workUnit', 'La unidad de medición no es válida.');
  }
  const name = patch.name === undefined ? project.name : patch.name.trim();
  return (
    projectNameIssue(config, name, projectId) ??
    apply(config, (draft) => {
      const target = /** @type {Project} */ (draft.projects.find((p) => p.id === projectId));
      target.name = name;
      if (patch.description !== undefined) target.description = textOrNull(patch.description);
      if (patch.active !== undefined) target.active = patch.active;
      if (patch.workUnit !== undefined) target.workUnit = /** @type {Project['workUnit']} */ (patch.workUnit);
      if (patch.measure !== undefined) target.measure = structuredClone(patch.measure);
    })
  );
}

/** Plan §2.2: a project can be reassigned to another team (the UI confirms first). */
export function reassignProject(/** @type {AppConfig} */ config, /** @type {string} */ projectId, /** @type {string} */ teamId) {
  if (!config.projects.some((p) => p.id === projectId)) return projectMissing();
  if (!config.teams.some((t) => t.id === teamId)) {
    return fail('PROJECT_TEAM_MISSING', 'teamId', 'El equipo elegido no existe.');
  }
  return apply(config, (draft) => {
    /** @type {Project} */ (draft.projects.find((p) => p.id === projectId)).teamId = teamId;
  });
}

/** Plan §2.2: blocked while the project has epics. @param {AppConfig} config @param {string} projectId */
export function removeProject(config, projectId) {
  const issues = guardDeleteProject(config, projectId);
  if (issues.length > 0) return /** @type {EditResult} */ ({ ok: false, issues });
  return apply(config, (draft) => {
    draft.projects = draft.projects.filter((p) => p.id !== projectId);
  });
}

// ---- Epics ----------------------------------------------------------------------------------

/** The project that owns an epic key, or null. @param {AppConfig} config @param {string} key */
export function findEpicOwner(config, key) {
  const wanted = epicKey(key);
  return config.projects.find((p) => p.epics.some((e) => epicKey(e.key) === wanted)) ?? null;
}

/**
 * Adds an epic validated against Jira (`/api/jira/epics/:key`). When another project owns it, the
 * issue carries `ownerProjectId` so the UI can offer `moveEpic` (plan §2.2).
 * @param {AppConfig} config @param {string} projectId
 * @param {{ key: string, issueTypeId: string, summary: string }} epic
 */
export function addEpic(config, projectId, epic) {
  if (!config.projects.some((p) => p.id === projectId)) return projectMissing();
  const key = epicKey(epic.key);
  const owner = findEpicOwner(config, key);
  if (owner?.id === projectId) {
    return fail('EPIC_DUPLICATE', 'epics', `La épica ${key} ya está en este proyecto.`);
  }
  if (owner) {
    return fail(
      'EPIC_OWNED_BY_OTHER_PROJECT',
      'epics',
      `La épica ${key} ya pertenece al proyecto "${owner.name}".`,
      { ownerProjectId: owner.id },
    );
  }
  return apply(config, (draft) => {
    /** @type {Project} */ (draft.projects.find((p) => p.id === projectId)).epics.push({
      key,
      issueTypeId: epic.issueTypeId,
      summary: epic.summary,
      active: true,
      linkMethodUsed: null,
    });
  });
}

/** Moves an epic (with its data) to another project. @param {AppConfig} config @param {string} key @param {string} toProjectId */
export function moveEpic(config, key, toProjectId) {
  if (!config.projects.some((p) => p.id === toProjectId)) return projectMissing();
  const wanted = epicKey(key);
  const owner = findEpicOwner(config, wanted);
  if (!owner) return fail('EPIC_NOT_FOUND', 'epics', `La épica ${wanted} no está en ningún proyecto.`);
  if (owner.id === toProjectId) {
    return fail('EPIC_ALREADY_IN_PROJECT', 'epics', `La épica ${wanted} ya está en este proyecto.`);
  }
  return apply(config, (draft) => {
    const from = /** @type {Project} */ (draft.projects.find((p) => p.id === owner.id));
    const epic = /** @type {Project['epics'][number]} */ (from.epics.find((e) => epicKey(e.key) === wanted));
    from.epics = from.epics.filter((e) => e !== epic);
    /** @type {Project} */ (draft.projects.find((p) => p.id === toProjectId)).epics.push(epic);
  });
}

/** @param {AppConfig} config @param {string} projectId @param {string} key @param {(p: Project, e: Project['epics'][number]) => void} change */
function changeEpic(config, projectId, key, change) {
  const project = config.projects.find((p) => p.id === projectId);
  if (!project) return projectMissing();
  const wanted = epicKey(key);
  if (!project.epics.some((e) => epicKey(e.key) === wanted)) {
    return fail('EPIC_NOT_FOUND', 'epics', `La épica ${wanted} no está en este proyecto.`);
  }
  return apply(config, (draft) => {
    const target = /** @type {Project} */ (draft.projects.find((p) => p.id === projectId));
    change(target, /** @type {any} */ (target.epics.find((e) => epicKey(e.key) === wanted)));
  });
}

/** @param {AppConfig} config @param {string} projectId @param {string} key @param {boolean} active */
export function setEpicActive(config, projectId, key, active) {
  return changeEpic(config, projectId, key, (_p, epic) => {
    epic.active = active;
  });
}

/** @param {AppConfig} config @param {string} projectId @param {string} key */
export function removeEpic(config, projectId, key) {
  return changeEpic(config, projectId, key, (project, epic) => {
    project.epics = project.epics.filter((e) => e !== epic);
  });
}
