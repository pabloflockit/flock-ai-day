import { validateJiraUrl } from '../../shared/jira-url.mjs';

/**
 * Business integrity rules for the configuration (docs/plan.md §2.2). Input is a normalized
 * config. Messages are Spanish because they are shown in the UI.
 *
 * @typedef {{ code: string, path: string, message: string }} ConfigIssue
 * @typedef {import('./normalize.mjs').AppConfig} AppConfig
 */

/** Names are compared ignoring case and surrounding spaces. @param {string} s */
const nameKey = (s) => s.trim().toLowerCase();

/**
 * @param {AppConfig} config
 * @returns {ConfigIssue[]} empty when valid
 */
export function validateConfig(config) {
  /** @type {ConfigIssue[]} */
  const issues = [];
  const add = (code, path, message) => issues.push({ code, path, message });

  if (config.jira.baseUrl !== '') {
    const url = validateJiraUrl(config.jira.baseUrl);
    if (!url.ok) {
      add('JIRA_URL_INVALID', 'jira.baseUrl', `La URL de Jira no es válida: ${url.reason}`);
    }
  }

  if (config.jira.epicLinkMode === 'epic_link' && !config.jira.epicLinkFieldId) {
    add(
      'EPIC_LINK_FIELD_REQUIRED',
      'jira.epicLinkFieldId',
      'El método de vínculo "Epic Link" necesita el campo de Jira que lo guarda.',
    );
  }

  const teamNames = new Set();
  const teamIds = new Set();
  config.teams.forEach((team, i) => {
    const path = `teams[${i}]`;
    if (teamIds.has(team.id)) {
      add('TEAM_ID_DUPLICATE', `${path}.id`, `El identificador del equipo "${team.name}" está repetido.`);
    }
    teamIds.add(team.id);
    if (team.name === '') {
      add('TEAM_NAME_REQUIRED', `${path}.name`, 'El equipo necesita un nombre.');
    } else if (teamNames.has(nameKey(team.name))) {
      add('TEAM_NAME_DUPLICATE', `${path}.name`, `Ya existe un equipo llamado "${team.name}".`);
    }
    teamNames.add(nameKey(team.name));

    const members = new Set();
    team.members.forEach((member, j) => {
      if (members.has(member.accountId)) {
        add(
          'MEMBER_DUPLICATE',
          `${path}.members[${j}].accountId`,
          `La persona ya está en el equipo "${team.name}".`,
        );
      }
      members.add(member.accountId);
    });
  });

  const projectNames = new Set();
  const projectIds = new Set();
  /** @type {Map<string, string>} epic key -> project id that owns it */
  const epicOwner = new Map();
  config.projects.forEach((project, i) => {
    const path = `projects[${i}]`;
    if (projectIds.has(project.id)) {
      add(
        'PROJECT_ID_DUPLICATE',
        `${path}.id`,
        `El identificador del proyecto "${project.name}" está repetido.`,
      );
    }
    projectIds.add(project.id);
    if (project.name === '') {
      add('PROJECT_NAME_REQUIRED', `${path}.name`, 'El proyecto necesita un nombre.');
    } else if (projectNames.has(nameKey(project.name))) {
      add(
        'PROJECT_NAME_DUPLICATE',
        `${path}.name`,
        `Ya existe un proyecto llamado "${project.name}".`,
      );
    }
    projectNames.add(nameKey(project.name));

    if (!teamIds.has(project.teamId)) {
      add(
        'PROJECT_TEAM_MISSING',
        `${path}.teamId`,
        `El proyecto "${project.name}" apunta a un equipo que no existe.`,
      );
    }

    project.epics.forEach((epic, j) => {
      const key = epic.key.toUpperCase();
      const owner = epicOwner.get(key);
      if (owner === undefined) {
        epicOwner.set(key, project.id);
        return;
      }
      add(
        'EPIC_DUPLICATE',
        `${path}.epics[${j}].key`,
        owner === project.id
          ? `La épica ${epic.key} está repetida en el proyecto "${project.name}".`
          : `La épica ${epic.key} ya pertenece a otro proyecto. Una épica solo puede estar en un proyecto.`,
      );
    });
  });

  return issues;
}

/**
 * Deletion guard (plan §2.2): a team with projects cannot be deleted. Deactivating is the
 * default action. For later UI use; returns the blocking issues (empty = allowed).
 *
 * @param {AppConfig} config
 * @param {string} teamId
 * @returns {ConfigIssue[]}
 */
export function guardDeleteTeam(config, teamId) {
  const index = config.teams.findIndex((t) => t.id === teamId);
  if (index < 0) {
    return [{ code: 'TEAM_NOT_FOUND', path: 'teams', message: 'El equipo no existe.' }];
  }
  const count = config.projects.filter((p) => p.teamId === teamId).length;
  return count === 0
    ? []
    : [
        {
          code: 'TEAM_HAS_PROJECTS',
          path: `teams[${index}]`,
          message: `El equipo tiene ${count} proyecto(s). Muévelos o elimínalos primero, o desactiva el equipo.`,
        },
      ];
}

/**
 * Deletion guard (plan §2.2): a project with epics cannot be deleted.
 *
 * @param {AppConfig} config
 * @param {string} projectId
 * @returns {ConfigIssue[]}
 */
export function guardDeleteProject(config, projectId) {
  const index = config.projects.findIndex((p) => p.id === projectId);
  if (index < 0) {
    return [{ code: 'PROJECT_NOT_FOUND', path: 'projects', message: 'El proyecto no existe.' }];
  }
  const count = config.projects[index].epics.length;
  return count === 0
    ? []
    : [
        {
          code: 'PROJECT_HAS_EPICS',
          path: `projects[${index}]`,
          message: `El proyecto tiene ${count} épica(s). Muévelas o elimínalas primero, o desactiva el proyecto.`,
        },
      ];
}
