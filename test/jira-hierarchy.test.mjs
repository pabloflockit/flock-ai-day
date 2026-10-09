import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ERROR_CODES } from '../shared/contracts.mjs';
import { fetchProjectIssues } from '../proxy/jira/hierarchy.mjs';
import { issue, fakeClient, makeConfig } from './jira-fixtures.mjs';

const run = (client, config, sinceMinutes = null) =>
  fetchProjectIssues({ client, project: config.projects[0], config, sinceMinutes });

test('parent mode: children by parent, subtasks by parent in (...), epicKey resolved', async () => {
  const client = fakeClient((jql) => {
    if (jql.startsWith('parent = "E-1"')) return [issue('A-1', { parent: 'E-1' }), issue('A-2', { parent: 'E-1' })];
    if (jql.startsWith('parent in ("A-1","A-2")')) return [issue('A-3', { parent: 'A-2', type: '10003' })];
    throw new Error(`unexpected ${jql}`);
  });
  const [shard] = await run(client, makeConfig());
  assert.equal(shard.status, 'ok');
  assert.equal(shard.key, 'E-1');
  assert.equal(shard.linkMethodUsed, 'parent');
  assert.deepEqual(shard.rows.map((r) => r.key), ['A-1', 'A-2', 'A-3']);
  assert.deepEqual(shard.rows.map((r) => r.epicKey), ['E-1', 'E-1', 'E-1']);
  assert.equal(shard.rows[2].isSubtask, true);
  assert.equal(shard.rows[0].measures.customfield_1, 3);
  assert.equal(client.calls[0].expand, 'changelog');
  assert.ok(client.calls[0].fields.includes('customfield_1'));
});

test('epic_link mode queries cf[<numeric id>]', async () => {
  const client = fakeClient((jql) => (jql.startsWith('cf[10014] = "E-1"') ? [issue('A-1')] : []));
  const [shard] = await run(client, makeConfig({ mode: 'epic_link', fieldId: 'customfield_10014' }));
  assert.equal(shard.status, 'ok');
  assert.equal(shard.linkMethodUsed, 'epic_link');
  assert.equal(shard.rows[0].epicKey, 'E-1');
  assert.ok(client.calls[0].fields.includes('customfield_10014'));
});

test('epic_link without a valid field id fails the shard without calling Jira', async () => {
  const client = fakeClient(() => []);
  const [shard] = await run(client, makeConfig({ mode: 'epic_link', fieldId: null }));
  assert.equal(shard.status, 'failed');
  assert.equal(shard.errorCode, ERROR_CODES.VALIDATION_ERROR);
  assert.equal(client.calls.length, 0);
});

test('auto: parent first; zero children retries epic_link and reports it', async () => {
  const client = fakeClient((jql) => (jql.startsWith('cf[10014]') ? [issue('A-1')] : []));
  const [shard] = await run(client, makeConfig({ mode: 'auto', fieldId: 'customfield_10014' }));
  assert.equal(shard.status, 'ok');
  assert.equal(shard.linkMethodUsed, 'epic_link');
  assert.deepEqual(client.calls.map((c) => c.jql.split(' ')[0]), ['parent', 'cf[10014]', 'parent']);
});

test('auto: parent with children does not retry; no field id means no retry', async () => {
  const withKids = fakeClient((jql) => (jql.startsWith('parent = ') ? [issue('A-1', { parent: 'E-1' })] : []));
  const [a] = await run(withKids, makeConfig({ mode: 'auto', fieldId: 'customfield_10014' }));
  assert.equal(a.linkMethodUsed, 'parent');
  assert.equal(withKids.calls.some((c) => c.jql.startsWith('cf[')), false);

  const noField = fakeClient(() => []);
  const [b] = await run(noField, makeConfig({ mode: 'auto' }));
  assert.equal(b.status, 'ok');
  assert.equal(b.linkMethodUsed, null);
  assert.equal(noField.calls.length, 1);
});

test('subtasks are batched by 50 keys', async () => {
  const children = Array.from({ length: 120 }, (_, i) => issue(`A-${i + 1}`, { parent: 'E-1' }));
  const client = fakeClient((jql) => (jql.startsWith('parent = ') ? children : []));
  const [shard] = await run(client, makeConfig());
  assert.equal(shard.status, 'ok');
  const subtaskCalls = client.calls.filter((c) => c.jql.startsWith('parent in'));
  assert.equal(subtaskCalls.length, 3);
  assert.equal(subtaskCalls[0].jql.match(/"/g).length / 2, 50);
  assert.equal(subtaskCalls[2].jql.match(/"/g).length / 2, 20);
});

test('delta adds a relative updated clause to children and subtasks', async () => {
  const client = fakeClient((jql) => (jql.startsWith('parent = ') ? [issue('A-1', { parent: 'E-1' })] : []));
  await run(client, makeConfig(), 35);
  assert.ok(client.calls.every((c) => c.jql.endsWith(' AND updated >= "-35m"')), JSON.stringify(client.calls));
  const full = fakeClient(() => []);
  await run(full, makeConfig(), null);
  assert.equal(full.calls[0].jql.includes('updated'), false);
});

test('delta also asks for subtasks of known (cached) children that did not change', async () => {
  const client = fakeClient((jql) => (jql.startsWith('parent = ') ? [] : [issue('A-9', { parent: 'A-1', type: '10003' })]));
  const config = makeConfig();
  const [shard] = await fetchProjectIssues({
    client,
    project: config.projects[0],
    config,
    sinceMinutes: 10,
    knownChildKeys: new Map([['E-1', ['A-1']]]),
  });
  assert.equal(shard.status, 'ok');
  assert.deepEqual(shard.rows.map((r) => [r.key, r.epicKey]), [['A-9', 'E-1']]);
});

test('JQL keys are quoted and escaped', async () => {
  const client = fakeClient(() => []);
  const config = makeConfig({ epics: ['E-1'] });
  config.projects[0].epics[0].key = 'E"-1\\';
  await run(client, config);
  assert.equal(client.calls[0].jql, 'parent = "E\\"-1\\\\"');
});

test('a Jira error marks only that shard failed, never empty-ok', async () => {
  const client = fakeClient((jql) => {
    if (jql.includes('"E-2"')) throw new ApiError(400, ERROR_CODES.BAD_QUERY, 'bad');
    return jql.startsWith('parent = ') ? [issue('A-1', { parent: 'E-1' })] : [];
  });
  const shards = await run(client, makeConfig({ epics: ['E-1', 'E-2'] }));
  assert.deepEqual(shards.map((s) => [s.key, s.status]), [['E-1', 'ok'], ['E-2', 'failed']]);
  assert.equal(shards[1].errorCode, ERROR_CODES.BAD_QUERY);
  assert.deepEqual(shards[1].rows, []);
});

test('non-API errors become UNKNOWN without leaking their message', async () => {
  const client = fakeClient(() => { throw new Error('secret detail'); });
  const [shard] = await run(client, makeConfig());
  assert.equal(shard.errorCode, ERROR_CODES.UNKNOWN);
  assert.equal(JSON.stringify(shard).includes('secret'), false);
});

test('metadata failure fails every shard with its code (rows preserved by the caller)', async () => {
  const client = fakeClient(() => [], {
    issueTypes: async () => { throw new ApiError(401, ERROR_CODES.AUTH, 'no'); },
  });
  const shards = await run(client, makeConfig({ epics: ['E-1', 'E-2'] }));
  assert.deepEqual(shards.map((s) => [s.status, s.errorCode]), [['failed', 'AUTH'], ['failed', 'AUTH']]);
});

test('epics run with concurrency 6 and inactive epics are excluded', async () => {
  let inFlight = 0;
  let peak = 0;
  const client = fakeClient(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return [];
  });
  const keys = Array.from({ length: 14 }, (_, i) => `E-${i + 1}`);
  const config = makeConfig({ epics: keys });
  config.projects[0].epics[0].active = false;
  const shards = await run(client, config);
  assert.equal(shards.length, 13);
  assert.equal(shards.some((s) => s.key === 'E-1'), false);
  assert.equal(peak, 6);
});

test('truncated embedded changelog triggers a per-issue fetch that feeds the projection', async () => {
  const truncated = issue('A-1', { parent: 'E-1' });
  truncated.changelog = { histories: [], total: 2, maxResults: 100 };
  const fetched = [];
  const client = fakeClient((jql) => (jql.startsWith('parent = ') ? [truncated] : []), {
    issueChangelog: async (key) => {
      fetched.push(key);
      return [{ created: '2024-01-06T10:00:00.000+0000', items: [{ fieldId: 'status', from: '1', to: '3' }] }];
    },
  });
  const [shard] = await run(client, makeConfig());
  assert.deepEqual(fetched, ['A-1']);
  assert.equal(shard.rows[0].doneAt, '2024-01-06T10:00:00.000Z');
});
