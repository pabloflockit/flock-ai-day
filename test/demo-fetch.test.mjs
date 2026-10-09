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

test('shows every dashboard feature: a findable non-member with open work, a member to do, an unassigned open unit', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const found = await (await get(f, '/rest/api/3/user/search?query=Carla')).json();
  const carla = found.find((u) => u.active === true && u.accountType === 'atlassian');
  assert.equal(carla?.displayName, 'Carla Demo');
  const memberIds = buildDemoConfig().teams[0].members.map((m) => m.accountId);
  assert.ok(!memberIds.includes(carla.accountId), 'Carla is not a member of the demo team');

  const page = await (
    await search(f, {
      jql: 'parent in ("DEMO-1","DEMO-2") AND statusCategory != Done',
      fields: ['assignee', 'status'],
    })
  ).json();
  const open = page.issues;
  assert.ok(open.filter((i) => i.fields.assignee?.accountId === carla.accountId).length >= 1);
  assert.ok(
    open.some((i) => i.fields.status.statusCategory.key === 'new' && memberIds.includes(i.fields.assignee?.accountId)),
    'a member has a To Do unit',
  );
  assert.ok(open.some((i) => i.fields.assignee === null), 'an open unit stays unassigned');
});

test('demo issues expose fictional layer components and the project components list', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const list = await (await get(f, '/rest/api/3/project/DEMO/components')).json();
  assert.ok(Array.isArray(list));
  for (const c of list) assert.ok(c.self && c.id && c.name && c.projectId);
  const names = list.map((c) => c.name);
  assert.ok(names.includes('FRONTEND') && names.includes('BACKEND'));
  assert.equal((await get(f, '/rest/api/3/project/NOPE/components')).status, 404);

  const config = buildDemoConfig();
  const shards = await fetchProjectIssues({ client: clientFor(f, config), project: config.projects[0], config, sinceMinutes: null });
  const rows = shards.flatMap((s) => s.rows);
  const listed = new Set(list.map((c) => c.id));
  for (const r of rows) for (const c of r.components) assert.ok(listed.has(c.id), `${r.key} ${c.id}`);
  const layerOf = (r) => r.components.map((c) => c.name).filter((n) => n === 'FRONTEND' || n === 'BACKEND');
  const subtasks = rows.filter((r) => r.isSubtask);
  assert.ok(subtasks.some((r) => layerOf(r).includes('FRONTEND')));
  assert.ok(subtasks.some((r) => layerOf(r).includes('BACKEND')));
  assert.ok(subtasks.some((r) => r.components.length === 0), 'analysis-like subtask without components');
  assert.ok(rows.some((r) => !r.isSubtask && r.components.length > 0 && layerOf(r).length === 0), 'area-only primary');
  const done = rows.find((r) => r.key === 'DEMO-5');
  assert.equal(done.statusChanges.length, 3);
  assert.equal(done.statusChanges.at(-1).toStatusId, '4');
  assert.equal(done.statusChanges.at(-1).at, done.doneAt);
});

test('search: assignee in, absolute updated date and key in (sprint report member query)', async () => {
  const f = createDemoFetch({ now: () => NOW });
  const mine = await (
    await search(f, { jql: 'assignee in ("demo-account-001") AND updated >= "2026-10-01"', fields: ['assignee', 'updated'] })
  ).json();
  assert.ok(mine.issues.length > 0);
  assert.ok(mine.issues.every((i) => i.fields.assignee.accountId === 'demo-account-001'));
  assert.ok(mine.issues.every((i) => Date.parse(i.fields.updated.replace(/(\d{2})(\d{2})$/, '$1:$2')) >= Date.parse('2026-10-01T00:00:00Z')));
  const none = await (await search(f, { jql: 'assignee in ("nobody") AND updated >= "2026-01-01"', fields: ['summary'] })).json();
  assert.deepEqual(none.issues, []);
  const keys = await (await search(f, { jql: 'key in ("DEMO-4","DEMO-6")', fields: ['parent'] })).json();
  assert.deepEqual(keys.issues.map((i) => i.key), ['DEMO-4', 'DEMO-6']);
  assert.equal((await search(f, { jql: 'updated >= "2026-02-30"', fields: ['summary'] })).status, 400);
});

test('demo has member work outside the configured epics, resolved by fetchMemberIssues', async () => {
  const { fetchMemberIssues } = await import('../proxy/jira/member-issues.mjs');
  const config = buildDemoConfig();
  const out = await fetchMemberIssues({
    client: clientFor(createDemoFetch({ now: () => NOW })),
    accountIds: ['demo-account-001', 'demo-account-002'],
    since: '2026-10-01',
    config,
    sinceMinutes: null,
  });
  assert.equal(out.status, 'ok');
  const configured = new Set(config.projects.flatMap((p) => p.epics.map((e) => e.key)));
  const outside = out.rows.filter((r) => !configured.has(r.epicKey));
  assert.ok(outside.some((r) => r.epicKey === 'DEMO-25' && r.isSubtask), JSON.stringify(outside.map((r) => [r.key, r.epicKey])));
  assert.ok(outside.some((r) => r.epicKey === null));
  assert.ok(outside.every((r) => r.statusChanges.length > 0));
});
