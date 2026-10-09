import { ApiError, ERROR_CODES, ISSUE_KEY_PATTERN } from '../../shared/contracts.mjs';
import { requireJira } from './connection.mjs';

const MIN_QUERY_CHARS = 2;
const EPIC_HIERARCHY_LEVEL = 1;

/** Jira status category key -> app category. Unknown keys (e.g. `undefined`) map to `null`. */
const CATEGORY = Object.freeze({ new: 'todo', indeterminate: 'doing', done: 'done' });

/**
 * @param {ReturnType<import('../router.mjs').createRouter>} router
 */
export function registerJiraMetaRoutes(router) {
  router.add('GET', '/api/jira/fields', async ({ deps }) =>
    (await requireJira(deps).fields()).map((f) => ({
      id: f.id,
      name: f.name,
      custom: f.custom === true,
      schema: { type: typeof f.schema?.type === 'string' ? f.schema.type : null },
    })),
  );

  router.add('GET', '/api/jira/statuses', async ({ deps }) =>
    (await requireJira(deps).statuses()).map((s) => ({
      id: s.id,
      name: s.name,
      statusCategory: Object.hasOwn(CATEGORY, s.statusCategory?.key)
        ? CATEGORY[/** @type {keyof typeof CATEGORY} */ (s.statusCategory.key)]
        : null,
    })),
  );

  router.add('GET', '/api/jira/issuetypes', async ({ deps }) =>
    (await requireJira(deps).issueTypes()).map((t) => ({
      id: t.id,
      name: t.name,
      hierarchyLevel: Number.isInteger(t.hierarchyLevel) ? t.hierarchyLevel : null,
      subtask: t.subtask === true,
    })),
  );

  router.add('GET', '/api/jira/users', async ({ query, deps }) => {
    const jira = requireJira(deps);
    const text = (query.get('query') ?? '').trim();
    if (text.length < MIN_QUERY_CHARS) {
      throw new ApiError(
        400,
        ERROR_CODES.VALIDATION_ERROR,
        `La búsqueda necesita al menos ${MIN_QUERY_CHARS} caracteres.`,
      );
    }
    // Only active human accounts: Atlassian apps/bots (`app`) and customers are dropped.
    return (await jira.userSearch(text))
      .filter((u) => u.accountType === 'atlassian' && u.active === true)
      .map((u) => ({
        accountId: u.accountId,
        displayName: u.displayName,
        emailAddress: typeof u.emailAddress === 'string' && u.emailAddress ? u.emailAddress : null,
      }));
  });

  router.add('GET', '/api/jira/epics/:key', async ({ params, deps }) => {
    const jira = requireJira(deps);
    const key = params?.key ?? '';
    if (!ISSUE_KEY_PATTERN.test(key)) {
      throw new ApiError(400, ERROR_CODES.VALIDATION_ERROR, 'La clave de la épica no es válida.');
    }
    const issue = await jira.issue(key, { fields: ['summary', 'issuetype'] });
    const issueTypeId = issue?.fields?.issuetype?.id;
    const type = (await jira.issueTypes()).find((t) => t.id === issueTypeId);
    const level = type?.hierarchyLevel ?? issue?.fields?.issuetype?.hierarchyLevel;
    if (level !== EPIC_HIERARCHY_LEVEL) {
      throw new ApiError(422, ERROR_CODES.NOT_AN_EPIC, `La issue ${key} no es una épica.`);
    }
    return { key: issue.key, summary: issue.fields.summary ?? '', issueTypeId };
  });
}
