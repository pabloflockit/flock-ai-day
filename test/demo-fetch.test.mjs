import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createDemoFetch } from '../fixtures/demo/demo-fetch.mjs';
import { DEMO_BASE_URL, DEMO_HOST, DEMO_TOKEN, buildDemoConfig } from '../fixtures/demo/index.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { fetchProjectIssues } from '../proxy/jira/hierarchy.mjs';
import { refreshProjectIssues } from '../proxy/jira/refresh.mjs';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const get = (fetchImpl, path) => fetchImpl(`${DEMO_BASE_URL}${path}`);
const search = (fetchImpl, body) =>
  fetchImpl(`${DEMO_BASE_URL}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

function clientFor(fetchImpl, config = buildDemoConfig()) {
  const guarded = createGuardedFetch({ fetchImpl, getAllowedHosts: () => [DEMO_HOST] });
  return createJiraClient({
    getConfig: () => config,
    secrets: { getJiraToken: () => DEMO_TOKEN },
    fetchImpl: guarded,
    sleep: async () => {},
  });
}

test('answers every whitelisted metadata endpoint from the fixtures', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const info = await (await get(f, '/rest/api/3/serverInfo')).json();
  assert.equal(info.deploymentType, 'Cloud');
  const me = await (await get(f, '/rest/api/3/myself')).json();
  assert.ok(me.accountId);
  const fields = await (await get(f, '/rest/api/3/field')).json();
  assert.ok(fields.some((x) => x.custom === true && x.schema.type === 'number'));
  const statuses = await (await get(f, '/rest/api/3/status')).json();
  assert.deepEqual(
    [...new Set(statuses.map((s) => s.statusCategory.key))].sort(),
    ['done', 'indeterminate', 'new'],
  );
  const types = await (await get(f, '/rest/api/3/issuetype')).json();
  assert.deepEqual(
    types.filter((t) => t.hierarchyLevel === 1).map((t) => t.name),
    ['Epic'],
  );
  assert.ok(types.some((t) => t.subtask === true && t.hierarchyLevel === -1));
  const names = types.map((t) => t.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  assert.ok(dup, 'two types share a name');
  assert.equal(new Set(types.filter((t) => t.name === dup).map((t) => t.id)).size, 2);
});

test('answers users and single issue endpoints', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const users = await (await get(f, '/rest/api/3/user/search?query=demo')).json();
  assert.ok(users.some((u) => u.accountType === 'app'));
  assert.ok(users.some((u) => u.active === false));
  const user = await (await get(f, `/rest/api/3/user?accountId=${users[0].accountId}`)).json();
  assert.equal(user.accountId, users[0].accountId);
  const issue = await (await get(f, '/rest/api/3/issue/DEMO-1?fields=summary')).json();
  assert.equal(issue.key, 'DEMO-1');
  assert.deepEqual(Object.keys(issue.fields), ['summary']);
  assert.equal((await get(f, '/rest/api/3/issue/NOPE-1')).status, 404);
});

test('returns 404 for anything that is not whitelisted, and for other hosts', async () => {
  const f = createDemoFetch({ now: () => NOW });
  for (const path of ['/rest/api/3/project', '/rest/api/2/serverInfo', '/rest/api/3/issue', '/foo']) {
    assert.equal((await get(f, path)).status, 404, path);
  }
  assert.equal((await f('https://other.example.net/rest/api/3/serverInfo')).status, 404);
  const post = await f(`${DEMO_BASE_URL}/rest/api/3/field`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 404);
});

test('search: parent, parent in, epic link, delta window and pagination', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const children = await (await search(f, { jql: 'parent = "DEMO-1"', fields: ['summary'] })).json();
  assert.ok(children.issues.length >= 5);
  const both = await (await search(f, { jql: 'parent in ("DEMO-1","DEMO-2")', fields: ['parent'] })).json();
  assert.ok(both.issues.length > children.issues.length);
  assert.ok(both.issues.every((i) => ['DEMO-1', 'DEMO-2'].includes(i.fields.parent.key)));
  const byLink = await (await search(f, { jql: 'cf[10014] = "DEMO-1"', fields: ['summary'] })).json();
  assert.deepEqual(byLink.issues.map((i) => i.key).sort(), children.issues.map((i) => i.key).sort());
  // The delta window is relative to the injected clock: nothing was updated in the last 5 minutes.
  const recent = await (
    await search(f, { jql: 'parent = "DEMO-1" AND updated >= "-5m"', fields: ['summary'] })
  ).json();
  assert.deepEqual(recent.issues, []);
  const wide = await (
    await search(f, { jql: 'parent = "DEMO-1" AND updated >= "-5000000m"', fields: ['summary'] })
  ).json();
  assert.equal(wide.issues.length, children.issues.length);

  const seen = [];
  let token;
  let pages = 0;
  do {
    const page = await (
      await search(f, { jql: 'parent = "DEMO-1"', fields: ['summary'], maxResults: 2, nextPageToken: token })
    ).json();
    pages += 1;
    seen.push(...page.issues.map((i) => i.key));
    token = page.isLast ? undefined : page.nextPageToken;
  } while (token);
  assert.ok(pages > 1);
  assert.deepEqual(seen.sort(), children.issues.map((i) => i.key).sort());
});

test('search: unparsable JQL and a failing epic answer 400', async () => {
  const f = createDemoFetch({ now: () => NOW });
  assert.equal((await search(f, { jql: 'project = X', fields: ['summary'] })).status, 400);
  const bad = await search(f, { jql: 'parent = "DEMO-3"', fields: ['summary'] });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray((await bad.json()).errorMessages));
  const ok = createDemoFetch({ now: () => NOW, failingEpics: [] });
  assert.equal((await search(ok, { jql: 'parent = "DEMO-3"', fields: ['summary'] })).status, 200);
});

test('the Jira client works over the demo fetch (null vs 0 measures survive)', async () => {
  const client = clientFor(createDemoFetch({ now: () => NOW }));
  const issues = await client.searchJql({
    jql: 'parent = "DEMO-1"',
    fields: ['customfield_10016', 'status'],
    expand: 'changelog',
  });
  const sp = issues.map((i) => i.fields.customfield_10016);
  assert.ok(sp.includes(null), 'a null measure exists');
  assert.ok(sp.includes(0), 'a zero measure exists');
});

test('a truncated embedded changelog triggers the per-issue changelog fetch', async () => {
  const urls = [];
  const inner = createDemoFetch({ now: () => NOW });
  const f = async (url, init) => {
    urls.push(String(url));
    return inner(url, init);
  };
  const config = buildDemoConfig();
  const shards = await fetchProjectIssues({
    client: clientFor(f, config),
    project: { ...config.projects[0], epics: config.projects[0].epics.filter((e) => e.key === 'DEMO-1') },
    config,
    sinceMinutes: null,
  });
  assert.equal(shards[0].status, 'ok');
  const changelogCalls = urls.filter((u) => /\/issue\/[^/]+\/changelog/.test(u));
  assert.equal(changelogCalls.length, 1);
  const truncated = /\/issue\/([^/]+)\/changelog/.exec(changelogCalls[0])[1];
  const row = shards[0].rows.find((r) => r.key === truncated);
  // The complete history (not the embedded first page) is what the projection used.
  assert.equal(row.statusCategory, 'done');
  assert.ok(row.doneAt, 'doneAt comes from a transition missing in the embedded page');
  assert.ok(row.firstDoingAt);
});

test('stale-not-empty end to end: a failing epic keeps its cached rows, healthy epics refresh', async () => {
  const key = randomBytes(32);
  let clock = '2026-10-09T12:00:00.000Z';
  const handle = openDatabase({ path: ':memory:', now: () => clock });
  const db = { handle, getDataKey: () => key };
  const config = buildDemoConfig();
  const projectId = config.projects[0].id;

  // Run 1: every epic answers, so DEMO-3 gets cached rows.
  const healthy = clientFor(createDemoFetch({ now: () => NOW, failingEpics: [] }));
  const first = await refreshProjectIssues({ db, client: healthy, config, projectId, mode: 'full', now: clock });
  assert.equal(first.isCurrent, true);
  const demo3Rows = first.rows.filter((r) => r.epicKey === 'DEMO-3');
  assert.ok(demo3Rows.length > 0);

  // Run 2: the default fixtures: DEMO-3 returns 400.
  const firstAt = clock;
  clock = '2026-10-09T13:00:00.000Z';
  const failing = clientFor(createDemoFetch({ now: () => NOW }));
  const second = await refreshProjectIssues({ db, client: failing, config, projectId, mode: 'full', now: clock });
  assert.equal(second.isCurrent, false);
  const byKey = Object.fromEntries(second.shardsMeta.map((m) => [m.key, m]));
  assert.equal(byKey['DEMO-1'].status, 'ok');
  assert.equal(byKey['DEMO-1'].lastOkAt, clock);
  assert.equal(byKey['DEMO-2'].status, 'ok');
  assert.equal(byKey['DEMO-3'].status, 'failed');
  assert.equal(byKey['DEMO-3'].errorCode, 'BAD_QUERY');
  assert.equal(byKey['DEMO-3'].lastOkAt, firstAt);
  assert.deepEqual(
    second.rows.filter((r) => r.epicKey === 'DEMO-3').map((r) => r.key).sort(),
    demo3Rows.map((r) => r.key).sort(),
  );
});

test('default demo run: healthy epics ok, the failing one is marked failed', async () => {
  const handle = openDatabase({ path: ':memory:' });
  const db = { handle, getDataKey: () => randomBytes(32) };
  const config = buildDemoConfig();
  const out = await refreshProjectIssues({
    db,
    client: clientFor(createDemoFetch({ now: () => NOW })),
    config,
    projectId: config.projects[0].id,
  });
  assert.deepEqual(
    out.shardsMeta.map((m) => `${m.key}:${m.status}`),
    ['DEMO-1:ok', 'DEMO-2:ok', 'DEMO-3:failed'],
  );
  assert.ok(out.rows.length >= 12);
});
