import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';

const TOKEN = 'ATATT-super-secret-token-value';
const EMAIL = 'me@acme.com';
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function setup({ responses = [], jira = {}, clock = { t: 0 } } = {}) {
  const calls = [];
  const sleeps = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    return next ?? json({});
  };
  const client = createJiraClient({
    getConfig: () => ({
      jira: { baseUrl: 'https://acme.atlassian.net', email: EMAIL, timeoutMs: 1000, maxRetries: 2, ...jira },
    }),
    secrets: { getJiraToken: () => TOKEN },
    fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
  });
  return { client, calls, sleeps, clock };
}

const code = (c) => (e) => e.code === c;

test('searchJql paginates over 3 pages with nextPageToken and explicit fields', async () => {
  const { client, calls } = setup({
    responses: [
      json({ issues: [{ key: 'A-1' }, { key: 'A-2' }], nextPageToken: 't1' }),
      json({ issues: [{ key: 'A-3' }], nextPageToken: 't2' }),
      json({ issues: [{ key: 'A-4' }], isLast: true }),
    ],
  });
  const issues = await client.searchJql({ jql: 'project = A', fields: ['summary'], expand: 'changelog' });
  assert.deepEqual(issues.map((i) => i.key), ['A-1', 'A-2', 'A-3', 'A-4']);
  assert.equal(calls.length, 3);
  const bodies = calls.map((c) => JSON.parse(c.init.body));
  assert.equal(calls[0].url, 'https://acme.atlassian.net/rest/api/3/search/jql');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(bodies[0], { jql: 'project = A', fields: ['summary'], expand: 'changelog', maxResults: 100 });
  assert.equal(bodies[1].nextPageToken, 't1');
  assert.equal(bodies[2].nextPageToken, 't2');
});

test('searchJql stops on missing token and on an empty page', async () => {
  const a = setup({ responses: [json({ issues: [{ key: 'A-1' }] })] });
  assert.equal((await a.client.searchJql({ jql: 'x', fields: ['summary'] })).length, 1);
  const b = setup({ responses: [json({ issues: [], nextPageToken: 'still' })] });
  assert.equal((await b.client.searchJql({ jql: 'x', fields: ['summary'] })).length, 0);
  assert.equal(b.calls.length, 1);
});

test('searchJql refuses a repeated token instead of looping or truncating silently', async () => {
  const { client, calls } = setup({
    responses: [
      json({ issues: [{ key: 'A-1' }], nextPageToken: 'same' }),
      json({ issues: [{ key: 'A-2' }], nextPageToken: 'same' }),
      json({ issues: [{ key: 'A-3' }], nextPageToken: 'same' }),
    ],
  });
  await assert.rejects(client.searchJql({ jql: 'x', fields: ['summary'] }), code('UNKNOWN'));
  assert.equal(calls.length, 2);
});

test('searchJql requires explicit fields and a jql', async () => {
  const { client, calls } = setup();
  await assert.rejects(client.searchJql({ jql: 'x', fields: [] }), code('VALIDATION_ERROR'));
  await assert.rejects(client.searchJql({ jql: '', fields: ['a'] }), code('VALIDATION_ERROR'));
  assert.equal(calls.length, 0);
});

test('429 honours Retry-After seconds, then succeeds', async () => {
  const { client, calls, sleeps } = setup({
    responses: [json({}, 429, { 'Retry-After': '3' }), json({ accountId: 'u1', displayName: 'U' })],
  });
  assert.equal((await client.myself()).accountId, 'u1');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [3000]);
});

test('429 honours a Retry-After HTTP date relative to the injected clock', async () => {
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const { client, sleeps } = setup({
    clock,
    responses: [json({}, 429, { 'Retry-After': 'Thu, 01 Jan 2026 00:00:07 GMT' }), json({})],
  });
  await client.myself();
  assert.deepEqual(sleeps, [7000]);
});

test('5xx uses exponential backoff with injectable jitter; exhausted -> SERVER_ERROR', async () => {
  const { client, calls, sleeps } = setup({ responses: [json({}, 503), json({}, 500), json({}, 502)] });
  await assert.rejects(client.myself(), (e) => e.code === 'SERVER_ERROR' && e.status === 502);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
});

test('429 exhausted -> RATE_LIMIT', async () => {
  const { client } = setup({ jira: { maxRetries: 0 }, responses: [json({}, 429)] });
  await assert.rejects(client.myself(), code('RATE_LIMIT'));
});

test('400 -> BAD_QUERY without retry, summarising the Jira message', async () => {
  const { client, calls } = setup({
    responses: [json({ errorMessages: ['Field "foo" does not exist.'] }, 400)],
  });
  await assert.rejects(client.searchJql({ jql: 'foo = 1', fields: ['a'] }), (e) => {
    assert.equal(e.code, 'BAD_QUERY');
    assert.match(JSON.stringify(e.details), /does not exist/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('401/403/404 map to AUTH/FORBIDDEN/NOT_FOUND without retry', async () => {
  for (const [status, expected] of [
    [401, 'AUTH'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ]) {
    const { client, calls } = setup({ responses: [json({}, status)] });
    await assert.rejects(client.myself(), code(expected));
    assert.equal(calls.length, 1);
  }
});

test('timeout aborts the request -> TIMEOUT', async () => {
  const { client } = setup({
    jira: { timeoutMs: 20 },
    responses: [
      (_url, init) =>
        new Promise((_res, rej) =>
          init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
        ),
    ],
  });
  await assert.rejects(client.myself(), code('TIMEOUT'));
});

test('network errors -> UNREACHABLE, certificate errors -> TLS', async () => {
  const net = setup({ responses: [new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })] });
  await assert.rejects(net.client.myself(), code('UNREACHABLE'));
  const tls = setup({
    responses: [new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })],
  });
  await assert.rejects(tls.client.myself(), code('TLS'));
  const odd = setup({ responses: [new Error('???')] });
  await assert.rejects(odd.client.myself(), code('UNREACHABLE'));
});

test('an egress-blocked host never reaches fetch', async () => {
  const calls = [];
  const guarded = createGuardedFetch({
    fetchImpl: async (...a) => void calls.push(a),
    getAllowedHosts: () => ['other.atlassian.net'],
  });
  const client = createJiraClient({
    getConfig: () => ({
      jira: { baseUrl: 'https://acme.atlassian.net', email: EMAIL, timeoutMs: 100, maxRetries: 0 },
    }),
    secrets: { getJiraToken: () => TOKEN },
    fetchImpl: guarded,
  });
  await assert.rejects(client.myself(), code('EGRESS_BLOCKED'));
  assert.equal(calls.length, 0);
});

test('Basic auth is built from config email + secrets and never leaks into errors or logs', async () => {
  const logs = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...a) => logs.push(a.map(String).join(' '));
  }
  try {
    const ok = setup({ responses: [json({ accountId: 'u' })] });
    await ok.client.myself();
    assert.equal(ok.calls[0].init.headers.Authorization, `Basic ${BASIC}`);

    const bad = setup({ jira: { maxRetries: 0 }, responses: [json({ message: 'nope' }, 401)] });
    const err = await bad.client.myself().catch((e) => e);
    const dump = JSON.stringify({ m: err.message, d: err.details, s: err.stack, c: err.cause });
    assert.ok(!dump.includes(TOKEN) && !dump.includes(BASIC) && !/authorization/i.test(dump));
    assert.equal(logs.length, 0);
  } finally {
    Object.assign(console, orig);
  }
});

test('missing token fails as AUTH without calling fetch', async () => {
  const calls = [];
  const client = createJiraClient({
    getConfig: () => ({
      jira: { baseUrl: 'https://acme.atlassian.net', email: EMAIL, timeoutMs: 100, maxRetries: 0 },
    }),
    secrets: { getJiraToken: () => null },
    fetchImpl: async () => void calls.push(1),
  });
  await assert.rejects(client.myself(), code('AUTH'));
  assert.equal(calls.length, 0);
});

test('unconfigured or unsafe base URL fails before any call', async () => {
  for (const baseUrl of ['', 'http://acme.atlassian.net', 'https://127.0.0.1']) {
    const calls = [];
    const client = createJiraClient({
      getConfig: () => ({ jira: { baseUrl, email: EMAIL, timeoutMs: 100, maxRetries: 0 } }),
      secrets: { getJiraToken: () => TOKEN },
      fetchImpl: async () => void calls.push(1),
    });
    await assert.rejects(client.myself(), code('JIRA_NOT_CONFIGURED'));
    assert.equal(calls.length, 0);
  }
});

test('serverInfo against a candidate URL sends no credentials and uses a one-host fetch', async () => {
  const seen = [];
  const fetchImpl = async () => json({});
  fetchImpl.forHost = (host) => async (url, init) => {
    seen.push({ host, url: String(url), headers: init.headers });
    return json({ deploymentType: 'Cloud' });
  };
  const client = createJiraClient({
    getConfig: () => ({ jira: { baseUrl: '', email: EMAIL, timeoutMs: 100, maxRetries: 0 } }),
    secrets: { getJiraToken: () => TOKEN },
    fetchImpl,
  });
  const info = await client.serverInfo({ baseUrl: 'https://new.atlassian.net' });
  assert.equal(info.deploymentType, 'Cloud');
  assert.equal(seen[0].host, 'new.atlassian.net');
  assert.equal(seen[0].url, 'https://new.atlassian.net/rest/api/3/serverInfo');
  assert.equal(seen[0].headers.Authorization, undefined);
  await assert.rejects(client.serverInfo({ baseUrl: 'http://evil.example' }), code('VALIDATION_ERROR'));
});

test('metadata is cached for the TTL (injected clock), single-flight, and failures are not cached', async () => {
  const clock = { t: 0 };
  const { client, calls } = setup({
    clock,
    jira: { maxRetries: 0 },
    responses: [json([{ id: 'f1' }]), json([{ id: 'f2' }])],
  });
  const [a, b] = await Promise.all([client.fields(), client.fields()]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  clock.t = 9 * 60 * 1000;
  await client.fields();
  assert.equal(calls.length, 1);
  clock.t = 10 * 60 * 1000 + 1;
  assert.deepEqual(await client.fields(), [{ id: 'f2' }]);
  assert.equal(calls.length, 2);

  const f = setup({ jira: { maxRetries: 0 }, responses: [json({}, 500), json([{ id: 's' }])] });
  await assert.rejects(f.client.statuses(), code('SERVER_ERROR'));
  assert.deepEqual(await f.client.statuses(), [{ id: 's' }]);
});

test('issue and changelog use whitelisted paths with validated keys', async () => {
  const { client, calls } = setup({
    responses: [
      json({ key: 'A-1' }),
      json({ values: [{ id: '1' }], startAt: 0, isLast: false, total: 3 }),
      json({ values: [{ id: '2' }, { id: '3' }], startAt: 1, isLast: true, total: 3 }),
    ],
  });
  await client.issue('A-1', { fields: ['summary', 'issuetype'], expand: 'changelog' });
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/rest/api/3/issue/A-1');
  assert.equal(u.searchParams.get('fields'), 'summary,issuetype');
  assert.equal(u.searchParams.get('expand'), 'changelog');
  const log = await client.issueChangelog('A-1');
  assert.deepEqual(log.map((v) => v.id), ['1', '2', '3']);
  assert.equal(new URL(calls[2].url).searchParams.get('startAt'), '1');
  for (const bad of ['../../myself', 'A-1/../x', 'a b', '']) {
    await assert.rejects(client.issue(bad), code('VALIDATION_ERROR'));
    await assert.rejects(client.issueChangelog(bad), code('VALIDATION_ERROR'));
  }
});

test('userSearch and user build encoded queries', async () => {
  const { client, calls } = setup({ responses: [json([]), json({ accountId: 'x' })] });
  await client.userSearch('ana & co');
  assert.equal(new URL(calls[0].url).pathname, '/rest/api/3/user/search');
  assert.equal(new URL(calls[0].url).searchParams.get('query'), 'ana & co');
  await client.user('712020:abc-123');
  assert.equal(new URL(calls[1].url).searchParams.get('accountId'), '712020:abc-123');
  await assert.rejects(client.user('x&y=1'), code('VALIDATION_ERROR'));
});

test('exposes only the whitelisted endpoint functions', () => {
  const { client } = setup();
  assert.deepEqual(Object.keys(client).sort(), [
    'clearMetadataCache',
    'fields',
    'issue',
    'issueChangelog',
    'issueTypes',
    'myself',
    'searchJql',
    'searchJqlPages',
    'serverInfo',
    'statuses',
    'user',
    'userSearch',
  ]);
});
