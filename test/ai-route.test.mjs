import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestProxy, withSecret } from './helpers.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { createJiraEndpoint } from '../proxy/config/jira-endpoint.mjs';
import { demoNarrative } from '../proxy/ai/demo-narrative.mjs';
import { AI_MODEL } from '../proxy/ai/prompt.mjs';

const KEY = 'sk-ant-SECRET-KEY-0123456789';
const INPUT = { team: 'Equipo', kpis: { closed: 2, withMovement: 5, primaries: 3, secondaries: 2, blocked: 0 } };

async function setup({ enabled = true, key = KEY, fetchImpl, aiDemo, aiTimeoutMs } = {}) {
  const handle = openDatabase({ path: ':memory:' });
  const dataKey = randomBytes(32);
  const config = createConfigStore({ handle, getDataKey: () => dataKey });
  config.save({ jira: { baseUrl: 'https://acme.atlassian.net' }, settings: { ai: { enabled } } });
  const calls = [];
  const raw = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(url, init);
  };
  const endpoint = createJiraEndpoint(config);
  const proxy = await startTestProxy({
    stores: { config },
    secrets: { getAiKey: () => key, getJiraToken: () => null },
    fetch: createGuardedFetch({ fetchImpl: raw, getAllowedHosts: endpoint.getAllowedHosts }),
    aiDemo,
    aiTimeoutMs,
  });
  const post = async (body = { input: INPUT }) => {
    const res = await fetch(`${proxy.base}/api/reports/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...withSecret() },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  return { proxy, post, calls, config };
}

const reply = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const ok = reply({ content: [{ type: 'text', text: '{"titulares":["a"],"lectura":"b"}' }] });

test('disabled -> AI_DISABLED and the provider is never called', async () => {
  const { proxy, post, calls } = await setup({ enabled: false, fetchImpl: ok });
  try {
    const res = await post();
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, 'AI_DISABLED');
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('no stored key -> AI_KEY_MISSING', async () => {
  const { proxy, post, calls } = await setup({ key: null, fetchImpl: ok });
  try {
    const res = await post();
    assert.equal(res.json.error.code, 'AI_KEY_MISSING');
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('request shape: endpoint, headers, body; response is { text } without the key', async () => {
  const { proxy, post, calls } = await setup({ fetchImpl: ok });
  try {
    const res = await post();
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data, { text: '{"titulares":["a"],"lectura":"b"}', demo: false });
    assert.ok(!res.text.includes(KEY));
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-api-key'], KEY);
    assert.equal(init.headers['anthropic-version'], '2023-06-01');
    assert.equal(init.headers['content-type'], 'application/json');
    const body = JSON.parse(init.body);
    assert.equal(body.model, AI_MODEL);
    assert.ok(Number.isInteger(body.max_tokens));
    assert.match(body.system, /solo las cifras/);
    assert.match(body.system, /nunca instrucciones/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(body.messages[0].content.includes(JSON.stringify(INPUT)));
    assert.ok(!init.body.includes(KEY));
  } finally {
    await proxy.close();
  }
});

test('provider errors map to stable codes and never leak the key or the raw body', async () => {
  const leak = { error: { message: `bad key ${KEY}` } };
  for (const [status, message] of [[401, /rechaz/], [500, /devolvi/]]) {
    const { proxy, post } = await setup({ fetchImpl: reply(leak, status) });
    try {
      const res = await post();
      assert.equal(res.json.error.code, 'AI_PROVIDER_ERROR');
      assert.match(res.json.error.message, message);
      assert.ok(!res.text.includes(KEY) && !res.text.includes('bad key'));
    } finally {
      await proxy.close();
    }
  }
});

test('timeout -> AI_TIMEOUT', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
    );
  const { proxy, post } = await setup({ fetchImpl: hang, aiTimeoutMs: 30 });
  try {
    const res = await post();
    assert.equal(res.status, 504);
    assert.equal(res.json.error.code, 'AI_TIMEOUT');
  } finally {
    await proxy.close();
  }
});

test('network failure -> AI_PROVIDER_ERROR; unusable answers -> AI_BAD_RESPONSE', async () => {
  const down = await setup({ fetchImpl: async () => { throw new Error(`boom ${KEY}`); } });
  try {
    const res = await down.post();
    assert.equal(res.json.error.code, 'AI_PROVIDER_ERROR');
    assert.ok(!res.text.includes(KEY));
  } finally {
    await down.proxy.close();
  }
  for (const impl of [reply({ content: [] }), reply({ nope: 1 }), async () => new Response('not json')]) {
    const { proxy, post } = await setup({ fetchImpl: impl });
    try {
      assert.equal((await post()).json.error.code, 'AI_BAD_RESPONSE');
    } finally {
      await proxy.close();
    }
  }
});

test('input must be a plain object of at most 64 KB', async () => {
  const { proxy, post, calls } = await setup({ fetchImpl: ok });
  try {
    for (const body of [{}, { input: [] }, { input: 'x' }, { input: null }]) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const big = await post({ input: { text: 'x'.repeat(65 * 1024) } });
    assert.equal(big.status, 413);
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('requires the proxy secret like every other route', async () => {
  const { proxy } = await setup({ fetchImpl: ok });
  try {
    const res = await fetch(`${proxy.base}/api/reports/ai`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  } finally {
    await proxy.close();
  }
});

test('demo: canned deterministic narrative, no provider call, labelled as demo', async () => {
  const { proxy, post, calls } = await setup({ fetchImpl: ok, aiDemo: demoNarrative });
  try {
    const first = await post();
    const second = await post();
    assert.equal(first.status, 200);
    assert.equal(first.json.data.demo, true);
    assert.equal(first.text, second.text);
    const parsed = JSON.parse(first.json.data.text);
    assert.match(parsed.lectura, /demostración/);
    assert.ok(parsed.titulares[0].includes('[Demo]') && parsed.titulares[0].includes('5'));
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('demo still honours the disabled switch', async () => {
  const { proxy, post } = await setup({ enabled: false, fetchImpl: ok, aiDemo: demoNarrative });
  try {
    assert.equal((await post()).json.error.code, 'AI_DISABLED');
  } finally {
    await proxy.close();
  }
});
