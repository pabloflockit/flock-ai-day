import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestProxy, withSecret } from './helpers.mjs';

const TOKEN = 'ATATT-super-secret-token-value';
const KEY = 'sk-ai-super-secret-key-value';

let proxy;
let stored;

before(async () => {
  stored = {};
  proxy = await startTestProxy({
    secrets: {
      setJiraToken: (v) => (stored.jira = v),
      setAiKey: (v) => (stored.ai = v),
      getJiraToken: () => stored.jira,
      getAiKey: () => stored.ai,
      getDataKey: () => Buffer.alloc(32),
    },
  });
});
after(() => proxy.close());

const put = (path, body, headers = withSecret()) =>
  fetch(`${proxy.base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('PUT /api/connection/token stores and never echoes', async () => {
  const res = await put('/api/connection/token', { token: `  ${TOKEN}\n` });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, data: { stored: true } });
  assert.ok(!text.includes(TOKEN));
  assert.equal(stored.jira, TOKEN, 'value is trimmed before storing');
});

test('PUT /api/ai/key stores and never echoes', async () => {
  const res = await put('/api/ai/key', { key: KEY });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { ok: true, data: { stored: true } });
  assert.ok(!text.includes(KEY));
  assert.equal(stored.ai, KEY);
});

test('there is no way to read them back: every other method is rejected', async () => {
  for (const path of ['/api/connection/token', '/api/ai/key']) {
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      const res = await fetch(`${proxy.base}${path}`, { method, headers: withSecret() });
      const text = await res.text();
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.ok(!text.includes(TOKEN) && !text.includes(KEY));
    }
  }
  for (const path of ['/api/connection/token/value', '/api/config/secrets', '/api/ai/key/value']) {
    const res = await fetch(`${proxy.base}${path}`, { headers: withSecret() });
    assert.equal(res.status, 404);
  }
});

test('requires the session secret', async () => {
  const res = await put('/api/connection/token', { token: TOKEN }, {});
  assert.equal(res.status, 401);
});

test('validation: non-string, empty, whitespace, too long, wrong shape, bad JSON', async () => {
  const cases = [
    ['/api/connection/token', { token: 123 }],
    ['/api/connection/token', { token: '' }],
    ['/api/connection/token', { token: '   ' }],
    ['/api/connection/token', { token: 'x'.repeat(5000) }],
    ['/api/connection/token', {}],
    ['/api/connection/token', []],
    ['/api/ai/key', { key: null }],
    ['/api/ai/key', { key: 'x'.repeat(5000) }],
    ['/api/ai/key', '{not json'],
  ];
  for (const [path, body] of cases) {
    const res = await put(path, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal((await res.json()).error.code, 'VALIDATION_ERROR');
  }
});

test('oversized body -> 413 before parsing', async () => {
  const res = await put('/api/connection/token', 'x'.repeat(100_000));
  assert.equal(res.status, 413);
});

test('a failing store never leaks the value in the response', async () => {
  const leaky = await startTestProxy({
    secrets: {
      setJiraToken: (v) => {
        throw new Error(`cannot store ${v}`);
      },
    },
  });
  try {
    const res = await fetch(`${leaky.base}/api/connection/token`, {
      method: 'PUT',
      headers: withSecret({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ token: TOKEN }),
    });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.ok(!text.includes(TOKEN));
  } finally {
    await leaky.close();
  }
});

test('GET /api/connection/status reports only whether a Jira token is stored', async () => {
  delete stored.jira;
  const before = await fetch(`${proxy.base}/api/connection/status`, { headers: withSecret() });
  assert.deepEqual(await before.json(), { ok: true, data: { tokenStored: false } });

  await put('/api/connection/token', { token: TOKEN });
  const after = await fetch(`${proxy.base}/api/connection/status`, { headers: withSecret() });
  const text = await after.text();
  assert.deepEqual(JSON.parse(text), { ok: true, data: { tokenStored: true } });
  assert.ok(!text.includes(TOKEN));
});
