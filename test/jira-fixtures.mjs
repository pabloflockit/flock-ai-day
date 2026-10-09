import { normalizeConfig } from '../proxy/config/normalize.mjs';

export const TYPES = [
  { id: '10000', name: 'Epic', hierarchyLevel: 1, subtask: false },
  { id: '10001', name: 'Task', hierarchyLevel: 0, subtask: false },
  { id: '10003', name: 'Sub-task', hierarchyLevel: -1, subtask: true },
];
export const STATUSES = [
  { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
  { id: '3', name: 'Done', statusCategory: { key: 'done' } },
];

export const issue = (key, { parent = null, type = '10001', updated = '2024-02-01T10:00:00.000+0000' } = {}) => ({
  key,
  fields: {
    summary: `Summary ${key}`,
    issuetype: { id: type, name: type === '10003' ? 'Sub-task' : 'Task' },
    parent: parent ? { key: parent } : null,
    status: { id: '1', name: 'To Do' },
    assignee: null,
    priority: null,
    created: '2024-01-01T10:00:00.000+0000',
    updated,
    duedate: null,
    resolutiondate: null,
    customfield_1: 3,
  },
  changelog: { histories: [], total: 0, maxResults: 100 },
});

/** Fake Jira client: `search(jql)` returns issues or throws. */
export function fakeClient(search, extra = {}) {
  const calls = [];
  return {
    calls,
    issueTypes: async () => TYPES,
    statuses: async () => STATUSES,
    searchJql: async ({ jql, fields, expand }) => {
      calls.push({ jql, fields, expand });
      return search(jql);
    },
    issueChangelog: async () => [],
    ...extra,
  };
}

export function makeConfig({ mode = 'parent', fieldId = null, epics = ['E-1'], overrides } = {}) {
  return normalizeConfig({
    jira: { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', epicLinkMode: mode, epicLinkFieldId: fieldId },
    teams: [{ id: 't1', name: 'T' }],
    projects: [
      {
        id: 'p1',
        teamId: 't1',
        name: 'P',
        measure: { kind: 'field', fieldId: 'customfield_1', fieldName: 'SP', valueType: 'number' },
        epics: epics.map((key) => ({ key, issueTypeId: '10000', active: true })),
      },
    ],
    ...overrides,
  });
}

