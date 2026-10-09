import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { startTestProxy, withSecret } from './helpers.mjs';

const TOKEN = 'ATATT-super-secret-token-value';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Proxy with a real Jira client over a fake fetch; `routes` maps a path to a handler. */
async function withProxy(routes, { baseUrl = 'https://acme.atlassian.net', allowed } = {}) {
  const calls = [];
  const raw = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), init });
    const handler = routes[u.pathname];
    return handler ? handler(u, init) : json({}, 404);
  };
  const guarded = createGuardedFetch({
    fetchImpl: raw,
    getAllowedHosts: () => allowed ?? (baseUrl ? [new URL(baseUrl).host] : []),
  });
  const secrets = { getJiraToken: () => TOKEN };
  const jira = createJiraClient({
    getConfig: () => ({ jira: { baseUrl, email: 'me@acme.com', timeoutMs: 500, maxRetries: 0 } }),
    secrets,
    fetchImpl: guarded,
    sleep: async () => {},
  });
  const proxy = await startTestProxy({ jira, secrets });
  const call = async (method, path, body) => {
    const res = await fetch(`${proxy.base}${path}`, {
      method,
      headers: withSecret({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { proxy, calls, call };
}

test('verify: invalid URLs are rejected without calling fetch', async () => {
  const { proxy, calls, call } = await withProxy({});
  try {
    for (const baseUrl of ['http://x.atlassian.net', 'https://127.0.0.1', 'nope', 42, undefined]) {
      const res = await call('POST', '/api/connection/verify', { baseUrl });
      assert.equal(res.status, 400, String(baseUrl));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await call('POST', '/api/connection/verify')).status, 400);
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('verify: Cloud candidate is reachable once, anonymously, without widening the allowlist', async () => {
  const { proxy, calls, call } = await withProxy(
    { '/rest/api/3/serverInfo': () => json({ deploymentType: 'Cloud', version: '1' }) },
    { baseUrl: '' },
  );
  try {
    const res = await call('POST', '/api/connection/verify', { baseUrl: 'https://new.atlassian.net/' });
    assert.deepEqual(res.body, {
      ok: true,
      data: { deploymentType: 'Cloud', baseUrl: 'https://new.atlassian.net' },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.Authorization, undefined);
    // Nothing is configured and the allowlist is still empty: a normal call stays closed.
    const test = await call('POST', '/api/connection/test');
    assert.equal(test.body.error.code, 'JIRA_NOT_CONFIGURED');
    assert.equal(calls.length, 1);
  } finally {
    await proxy.close();
  }
});

test('verify: non-Cloud deployments are rejected', async () => {
  const { proxy, call } = await withProxy(
    { '/rest/api/3/serverInfo': () => json({ deploymentType: 'Server' }) },
    { baseUrl: '' },
  );
  try {
    const res = await call('POST', '/api/connection/verify', { baseUrl: 'https://onprem.example.com' });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'NOT_CLOUD');
  } finally {
    await proxy.close();
  }
});

test('test: returns accountId and displayName; Jira errors keep their classified code', async () => {
  let status = 200;
  const { proxy, call } = await withProxy({
    '/rest/api/3/myself': () =>
      status === 200
        ? json({ accountId: 'u1', displayName: 'Ana', emailAddress: 'a@x.com' })
        : json({}, status),
  });
  try {
    assert.deepEqual((await call('POST', '/api/connection/test')).body.data, {
      accountId: 'u1',
      displayName: 'Ana',
    });
    status = 401;
    const res = await call('POST', '/api/connection/test');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'AUTH');
    assert.ok(!JSON.stringify(res.body).includes(TOKEN));
  } finally {
    await proxy.close();
  }
});

test('metadata routes project fields, statuses and issue types', async () => {
  const { proxy, call } = await withProxy({
    '/rest/api/3/field': () =>
      json([
        { id: 'customfield_1', name: 'SP', custom: true, schema: { type: 'number', custom: 'x' }, extra: 1 },
        { id: 'summary', name: 'Summary', custom: false },
      ]),
    '/rest/api/3/status': () =>
      json([
        { id: '1', name: 'Open', statusCategory: { key: 'new' } },
        { id: '2', name: 'WIP', statusCategory: { key: 'indeterminate' } },
        { id: '3', name: 'Closed', statusCategory: { key: 'done' } },
        { id: '4', name: 'Legacy', statusCategory: { key: 'undefined' } },
      ]),
    '/rest/api/3/issuetype': () =>
      json([{ id: '10', name: 'Epic', hierarchyLevel: 1, subtask: false, self: 'x' }]),
  });
  try {
    const f = (await call('GET', '/api/jira/fields')).body.data;
    assert.deepEqual(f[0], { id: 'customfield_1', name: 'SP', custom: true, schema: { type: 'number' } });
    assert.deepEqual(f[1].schema, { type: null });
    const s = (await call('GET', '/api/jira/statuses')).body.data;
    assert.deepEqual(s.map((x) => x.statusCategory), ['todo', 'doing', 'done', null]);
    assert.deepEqual(Object.keys(s[0]).sort(), ['id', 'name', 'statusCategory']);
    assert.deepEqual((await call('GET', '/api/jira/issuetypes')).body.data, [
      { id: '10', name: 'Epic', hierarchyLevel: 1, subtask: false },
    ]);
  } finally {
    await proxy.close();
  }
});

test('users: min 2 chars; only active human accounts', async () => {
  const { proxy, calls, call } = await withProxy({
    '/rest/api/3/user/search': () =>
      json([
        { accountId: 'a', displayName: 'Ana', accountType: 'atlassian', active: true, emailAddress: 'a@x.com' },
        { accountId: 'b', displayName: 'Bot', accountType: 'app', active: true },
        { accountId: 'c', displayName: 'Old', accountType: 'atlassian', active: false },
        { accountId: 'd', displayName: 'Cust', accountType: 'customer', active: true },
      ]),
  });
  try {
    for (const q of ['', 'a', ' a ']) {
      assert.equal((await call('GET', `/api/jira/users?query=${encodeURIComponent(q)}`)).status, 400);
    }
    assert.equal((await call('GET', '/api/jira/users')).status, 400);
    assert.equal(calls.length, 0);
    const res = await call('GET', '/api/jira/users?query=an');
    assert.deepEqual(res.body.data, [{ accountId: 'a', displayName: 'Ana', emailAddress: 'a@x.com' }]);
  } finally {
    await proxy.close();
  }
});

test('epics/:key validates an epic by hierarchyLevel 1 using issue type metadata', async () => {
  const { proxy, call } = await withProxy({
    '/rest/api/3/issuetype': () =>
      json([
        { id: '10', name: 'Renamed', hierarchyLevel: 1, subtask: false },
        { id: '11', name: 'Epic', hierarchyLevel: 0, subtask: false },
      ]),
    '/rest/api/3/issue/EP-1': () =>
      json({ key: 'EP-1', fields: { summary: 'Big', issuetype: { id: '10' } } }),
    '/rest/api/3/issue/TK-2': () =>
      json({ key: 'TK-2', fields: { summary: 'Small', issuetype: { id: '11' } } }),
  });
  try {
    assert.deepEqual((await call('GET', '/api/jira/epics/EP-1')).body.data, {
      key: 'EP-1',
      summary: 'Big',
      issueTypeId: '10',
    });
    const notEpic = await call('GET', '/api/jira/epics/TK-2');
    assert.equal(notEpic.status, 422);
    assert.equal(notEpic.body.error.code, 'NOT_AN_EPIC');
    const missing = await call('GET', '/api/jira/epics/ZZ-9');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.equal((await call('GET', '/api/jira/epics/not%20a%20key')).status, 400);
  } finally {
    await proxy.close();
  }
});

test('Jira routes stay behind the secret and answer 503 without a client', async () => {
  const proxy = await startTestProxy({});
  try {
    const noSecret = await fetch(`${proxy.base}/api/jira/fields`);
    assert.equal(noSecret.status, 401);
    const res = await fetch(`${proxy.base}/api/jira/fields`, { headers: withSecret() });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'JIRA_NOT_CONFIGURED');
    const post = await fetch(`${proxy.base}/api/jira/fields`, { method: 'POST', headers: withSecret() });
    assert.equal(post.status, 405);
  } finally {
    await proxy.close();
  }
});
