import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestProxy, withSecret } from './helpers.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';

let proxy;
let handle;
let key;

before(async () => {
  key = randomBytes(32);
  handle = openDatabase({ path: ':memory:' });
  proxy = await startTestProxy({
    stores: { config: createConfigStore({ handle, getDataKey: () => key }) },
  });
});
after(() => proxy.close());

const call = (method, body, base = proxy.base) =>
  fetch(`${base}/api/config`, {
    method,
    headers: { 'Content-Type': 'application/json', ...withSecret() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const doc = (over = {}) => ({
  jira: { baseUrl: 'https://acme.atlassian.net', ...over.jira },
  teams: over.teams ?? [{ id: 't1', name: 'Alpha', members: [{ accountId: 'm1' }] }],
  projects: [
    { id: 'p1', teamId: 't1', name: 'One', epics: [{ key: 'E-1', issueTypeId: '1' }], ...over.p1 },
    { id: 'p2', teamId: 't1', name: 'Two', epics: [{ key: 'E-9' }], ...over.p2 },
  ],
});

test('GET returns the normalized defaults when nothing is stored', async () => {
  const res = await call('GET');
  assert.equal(res.status, 200);
  const { ok, data } = await res.json();
  assert.equal(ok, true);
  assert.equal(data.jira.epicLinkMode, 'auto');
  assert.deepEqual(data.teams, []);
});

test('PUT stores the normalized config; first save reports every active project as moved', async () => {
  const res = await call('PUT', { ...doc(), token: 'SECRET-TOKEN' });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('SECRET-TOKEN'));
  const { data } = JSON.parse(text);
  assert.equal(data.config.projects.length, 2);
  assert.equal(data.movedKeys.length, 2);
  assert.ok(data.movedKeys.every((k) => k.includes('|projectIssues|')));
  const got = await (await call('GET')).json();
  assert.deepEqual(got.data, data.config);
});

test('PUT of an unchanged or view-only edit moves nothing', async () => {
  const same = await (await call('PUT', doc())).json();
  assert.deepEqual(same.data.movedKeys, []);
  const edit = doc({ p1: { name: 'Renamed' }, teams: [{ id: 't1', name: 'New', members: [] }] });
  const res = await (await call('PUT', edit)).json();
  assert.deepEqual(res.data.movedKeys, []);
});

test('PUT reports only the projects whose key changed', async () => {
  const epics = [{ key: 'E-9' }, { key: 'E-10' }];
  const res = await (await call('PUT', doc({ p2: { epics } }))).json();
  assert.equal(res.data.movedKeys.length, 1);
  assert.ok(res.data.movedKeys[0].startsWith('p2|projectIssues|'));
  const link = await (
    await call('PUT', doc({ p2: { epics }, jira: { epicLinkMode: 'parent' } }))
  ).json();
  assert.equal(link.data.movedKeys.length, 2, 'link mode moves every project');
});

test('PUT with a validation failure is a 400 with issues and stores nothing', async () => {
  const before = await (await call('GET')).json();
  const res = await call('PUT', doc({ p1: { name: 'Two' } }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.equal(body.error.details.issues[0].code, 'PROJECT_NAME_DUPLICATE');
  assert.deepEqual((await (await call('GET')).json()).data, before.data);
});

test('PUT with a non-object body is a 400', async () => {
  for (const body of [[], 'x', 3]) {
    assert.equal((await call('PUT', body)).status, 400);
  }
});

test('DATA_KEY_INVALID surfaces on GET and PUT without touching the row', async () => {
  const rowBefore = handle.db.prepare('SELECT * FROM app_config').all();
  const saved = key;
  key = randomBytes(32);
  for (const [method, body] of [['GET'], ['PUT', doc()]]) {
    const res = await call(method, body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'DATA_KEY_INVALID');
  }
  assert.deepEqual(handle.db.prepare('SELECT * FROM app_config').all(), rowBefore);
  key = saved;
  assert.equal((await call('GET')).status, 200);
});

test('requires the session secret', async () => {
  assert.equal((await fetch(`${proxy.base}/api/config`)).status, 401);
});

test('without a config store the route answers 503, not a crash', async () => {
  const bare = await startTestProxy();
  assert.equal((await call('GET', undefined, bare.base)).status, 503);
  await bare.close();
});

test('a config larger than the default body limit is accepted', async () => {
  const members = Array.from({ length: 800 }, (_, i) => ({
    accountId: `acc-${i}`,
    displayName: 'x'.repeat(30),
  }));
  const res = await call('PUT', { teams: [{ id: 't', name: 'Big', members }] });
  assert.equal(res.status, 200);
});
