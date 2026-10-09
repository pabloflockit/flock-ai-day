import { readFileSync } from 'node:fs';
import { DEMO_BASE_URL, DEMO_HOST, EPIC_LINK_FIELD_ID } from './constants.mjs';
import { DEMO_COMPONENTS, DEMO_PROJECT_ID, FAILING_EPICS, buildIssues } from './issues.mjs';

/**
 * A `fetchImpl` that answers Jira Cloud requests from the fictional fixtures in this directory.
 * No network, no credentials. It answers ONLY the endpoints the Jira client uses; everything else
 * (other paths, other methods, other hosts) is a 404. `GET /project/DEMO/components` returns the
 * fictional component list (the proxy route that reads it is a later task).
 *
 * Search understands exactly the JQL shapes the proxy and `tools/validate-scope.mjs` emit, joined
 * with AND:
 *  - `parent = "K"` and `parent in ("A","B")`
 *  - `cf[10014] = "K"` and `cf[10014] in ("A","B")` (the legacy Epic Link field)
 *  - `updated >= "-Nm"` (relative to the injected clock)
 *  - `statusCategory = "In Progress"` / `!= "Done"` (quotes optional)
 * Anything else is a 400, like Jira rejecting a query. A search that names an epic listed in
 * `failingEpics` is a 400 too: that is how the demo shows the stale-not-empty degradation.
 */

const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));

const DEFAULT_PAGE_SIZE = 50;
const CATEGORY_BY_NAME = { 'to do': 'new', 'in progress': 'indeterminate', done: 'done' };
const QUOTED = '"((?:[^"\\\\]|\\\\.)*)"';
const unquote = (text) => text.replace(/\\(.)/g, '$1');
const CLAUSES = {
  parentEq: new RegExp(`^parent\\s*=\\s*${QUOTED}$`),
  parentIn: /^parent\s+in\s*\((.*)\)$/s,
  linkEq: new RegExp(`^cf\\[(\\d+)\\]\\s*=\\s*${QUOTED}$`),
  linkIn: /^cf\[(\d+)\]\s+in\s*\((.*)\)$/s,
  updated: /^updated\s*>=\s*"-(\d+)m"$/,
  category: /^statusCategory\s*(=|!=)\s*(?:"([^"]*)"|(\S+))$/,
};

class BadQuery extends Error {}

/** Splits on top-level AND, ignoring AND inside quotes or parentheses. @param {string} jql */
function splitClauses(jql) {
  const clauses = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < jql.length; i += 1) {
    const ch = jql[i];
    if (quoted) {
      if (ch === '\\') i += 1;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (depth === 0 && /^\sAND\s/i.test(jql.slice(i, i + 5))) {
      clauses.push(jql.slice(start, i));
      start = i + 5;
      i += 4;
    }
  }
  clauses.push(jql.slice(start));
  return clauses.map((c) => c.trim());
}

/** @param {string} list `"A","B"` @returns {string[]} */
function parseList(list) {
  const values = [...list.matchAll(new RegExp(QUOTED, 'g'))].map((m) => unquote(m[1]));
  const rest = list.replace(new RegExp(QUOTED, 'g'), '').replace(/[,\s]/g, '');
  if (values.length === 0 || rest !== '') throw new BadQuery('Bad list.');
  return values;
}

/**
 * @param {string} jql
 * @param {{ now: number }} clock
 * @returns {{ test(issue: any): boolean, epics: string[] }} `epics`: every epic key the query names
 */
function parseJql(jql, { now }) {
  if (typeof jql !== 'string' || jql.trim() === '') throw new BadQuery('Empty query.');
  /** @type {Array<(issue: any) => boolean>} */
  const tests = [];
  /** @type {string[]} */
  const named = [];
  for (const clause of splitClauses(jql)) {
    let m;
    if ((m = CLAUSES.parentEq.exec(clause))) {
      const key = unquote(m[1]);
      named.push(key);
      tests.push((i) => i.fields.parent?.key === key);
    } else if ((m = CLAUSES.parentIn.exec(clause))) {
      const keys = parseList(m[1]);
      named.push(...keys);
      tests.push((i) => keys.includes(i.fields.parent?.key));
    } else if ((m = CLAUSES.linkEq.exec(clause) ?? CLAUSES.linkIn.exec(clause))) {
      if (`customfield_${m[1]}` !== EPIC_LINK_FIELD_ID) throw new BadQuery('Unknown field.');
      const keys = CLAUSES.linkIn.test(clause) ? parseList(m[2]) : [unquote(m[2])];
      named.push(...keys);
      tests.push((i) => keys.includes(i.fields[EPIC_LINK_FIELD_ID]));
    } else if ((m = CLAUSES.updated.exec(clause))) {
      const since = now - Number(m[1]) * 60_000;
      tests.push((i) => Date.parse(i.fields.updated.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) >= since);
    } else if ((m = CLAUSES.category.exec(clause))) {
      const category = CATEGORY_BY_NAME[(m[2] ?? m[3]).toLowerCase()];
      if (!category) throw new BadQuery('Unknown status category.');
      const negate = m[1] === '!=';
      tests.push((i) => (i.fields.status.statusCategory.key === category) !== negate);
    } else {
      throw new BadQuery('Unsupported clause.');
    }
  }
  return { test: (issue) => tests.every((t) => t(issue)), epics: named };
}

/**
 * @param {{ now?: () => number, failingEpics?: readonly string[], maxPageSize?: number }} [options]
 *  `now` is epoch milliseconds (delta windows are relative to it).
 * @returns {typeof fetch}
 */
export function createDemoFetch({ now = () => Date.now(), failingEpics = FAILING_EPICS, maxPageSize = 100 } = {}) {
  const serverInfo = readJson('server-info.json');
  const myself = readJson('myself.json');
  const fields = readJson('fields.json');
  const statuses = readJson('statuses.json');
  const issueTypes = readJson('issuetypes.json');
  const users = readJson('users.json');
  const issues = buildIssues();
  const byKey = new Map(issues.map((i) => [i.key, i]));

  const respond = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const notFound = () => respond(404, { errorMessages: ['Not found.'], errors: {} });
  const badQuery = (message) => respond(400, { errorMessages: [message], errors: {} });

  /** @param {typeof issues[number]} issue @param {string[] | undefined} names */
  function present(issue, names, { expandChangelog }) {
    const wanted = names ?? [];
    const out = { id: issue.id, key: issue.key };
    out.fields = wanted.includes('*all')
      ? { ...issue.fields }
      : Object.fromEntries(wanted.filter((name) => name in issue.fields).map((name) => [name, issue.fields[name]]));
    if (expandChangelog) {
      const embedded = issue.embedded ?? issue.history.length;
      out.changelog = {
        startAt: 0,
        maxResults: Math.max(embedded, 1),
        total: issue.history.length,
        histories: issue.history.slice(0, embedded),
      };
    }
    return JSON.parse(JSON.stringify(out));
  }

  function search(body) {
    if (!body || typeof body !== 'object') return badQuery('Invalid request body.');
    let query;
    try {
      query = parseJql(body.jql, { now: now() });
    } catch (error) {
      if (error instanceof BadQuery) return badQuery(`Error in the JQL query: ${error.message}`);
      throw error;
    }
    if (query.epics.some((key) => failingEpics.includes(key))) {
      return badQuery('The value does not exist for the field.');
    }
    let offset = 0;
    if (typeof body.nextPageToken === 'string' && body.nextPageToken !== '') {
      const m = /^o:(\d+)$/.exec(Buffer.from(body.nextPageToken, 'base64url').toString('utf8'));
      if (!m) return badQuery('Invalid page token.');
      offset = Number(m[1]);
    }
    const size = Math.min(Number.isInteger(body.maxResults) && body.maxResults > 0 ? body.maxResults : DEFAULT_PAGE_SIZE, maxPageSize);
    const names = Array.isArray(body.fields) ? body.fields : ['id'];
    const expandChangelog = typeof body.expand === 'string' && body.expand.split(',').includes('changelog');
    const matches = issues.filter((i) => query.test(i));
    const page = matches.slice(offset, offset + size).map((i) => present(i, names, { expandChangelog }));
    const end = offset + size;
    return respond(
      200,
      end >= matches.length
        ? { issues: page, isLast: true }
        : { issues: page, isLast: false, nextPageToken: Buffer.from(`o:${end}`).toString('base64url') },
    );
  }

  function changelog(issue, params) {
    const startAt = Math.max(0, Number(params.get('startAt') ?? 0) || 0);
    const size = Math.min(Number(params.get('maxResults') ?? 100) || 100, 100);
    const values = issue.history.slice(startAt, startAt + size);
    return respond(200, {
      startAt,
      maxResults: size,
      total: issue.history.length,
      isLast: startAt + values.length >= issue.history.length,
      values: JSON.parse(JSON.stringify(values)),
    });
  }

  return async function demoFetch(input, init = {}) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    let url;
    try {
      url = new URL(raw);
    } catch {
      return notFound();
    }
    if (url.host !== DEMO_HOST) return notFound();
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const params = url.searchParams;

    if (method === 'POST' && path === '/rest/api/3/search/jql') {
      let body;
      try {
        body = JSON.parse(init.body ?? '');
      } catch {
        return badQuery('Invalid request body.');
      }
      return search(body);
    }
    if (method !== 'GET') return notFound();

    switch (path) {
      case '/rest/api/3/serverInfo':
        return respond(200, serverInfo);
      case '/rest/api/3/myself':
        return respond(200, myself);
      case '/rest/api/3/field':
        return respond(200, fields);
      case '/rest/api/3/status':
        return respond(200, statuses);
      case '/rest/api/3/issuetype':
        return respond(200, issueTypes);
      case '/rest/api/3/user/search': {
        const text = (params.get('query') ?? '').toLowerCase();
        return respond(
          200,
          users.filter((u) => `${u.displayName} ${u.emailAddress ?? ''}`.toLowerCase().includes(text)),
        );
      }
      case '/rest/api/3/user': {
        const user = users.find((u) => u.accountId === params.get('accountId'));
        return user ? respond(200, user) : notFound();
      }
      default:
    }

    const componentsMatch = /^\/rest\/api\/3\/project\/([^/]+)\/components$/.exec(path);
    if (componentsMatch) {
      const projectKey = decodeURIComponent(componentsMatch[1]);
      if (projectKey !== 'DEMO') return notFound();
      return respond(
        200,
        DEMO_COMPONENTS.map((c) => ({
          self: `${DEMO_BASE_URL}/rest/api/3/component/${c.id}`,
          id: c.id,
          name: c.name,
          assigneeType: 'PROJECT_DEFAULT',
          realAssigneeType: 'PROJECT_DEFAULT',
          isAssigneeTypeValid: false,
          project: projectKey,
          projectId: Number(DEMO_PROJECT_ID),
        })),
      );
    }
    const changelogMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/changelog$/.exec(path);
    if (changelogMatch) {
      const issue = byKey.get(decodeURIComponent(changelogMatch[1]));
      return issue ? changelog(issue, params) : notFound();
    }
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const issue = byKey.get(decodeURIComponent(issueMatch[1]));
      if (!issue) return notFound();
      const names = params.has('fields') ? params.get('fields').split(',') : ['*all'];
      return respond(200, present(issue, names, { expandChangelog: params.get('expand') === 'changelog' }));
    }
    return notFound();
  };
}
