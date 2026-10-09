import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestProxy, withSecret, TEST_SECRET, APP_ORIGIN, DEV_ORIGIN } from './helpers.mjs';
import { startProxyServer } from '../proxy/server.mjs';

describe('session secret guard', () => {
  let proxy;
  before(async () => {
    proxy = await startTestProxy();
  });
  after(() => proxy.close());

  test('missing secret -> 401 UNAUTHORIZED envelope', async () => {
    const res = await fetch(`${proxy.base}/api/health`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: body.error.message },
    });
  });

  test('wrong secret (same and different length) -> 401', async () => {
    for (const secret of ['nope', 'x'.repeat(TEST_SECRET.length), `${TEST_SECRET}x`]) {
      const res = await fetch(`${proxy.base}/api/health`, {
        headers: { 'X-Proxy-Secret': secret },
      });
      assert.equal(res.status, 401, secret);
    }
  });

  test('correct secret -> 200', async () => {
    const res = await fetch(`${proxy.base}/api/health`, { headers: withSecret() });
    assert.equal(res.status, 200);
  });

  test('unknown route without secret is 401, not 404 (no route probing)', async () => {
    const res = await fetch(`${proxy.base}/api/nope`);
    assert.equal(res.status, 401);
  });

  test('server refuses to be created without a secret', async () => {
    await assert.rejects(startProxyServer({ port: 0 }), /secret/i);
    await assert.rejects(startProxyServer({ port: 0, proxySecret: '' }), /secret/i);
  });
});

describe('CORS', () => {
  let proxy;
  before(async () => {
    proxy = await startTestProxy();
  });
  after(() => proxy.close());

  for (const origin of [APP_ORIGIN, DEV_ORIGIN]) {
    test(`preflight from ${origin} is answered without a secret`, async () => {
      const res = await fetch(`${proxy.base}/api/health`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-proxy-secret',
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      const allowed = res.headers.get('access-control-allow-headers').toLowerCase();
      assert.match(allowed, /x-proxy-secret/);
      assert.match(allowed, /content-type/);
      assert.doesNotMatch(allowed, /x-jira|authorization/);
      assert.match(res.headers.get('access-control-allow-methods'), /PUT/);
      assert.match(res.headers.get('vary'), /Origin/);
    });
  }

  test('preflight from a foreign origin -> 403 without CORS headers', async () => {
    const res = await fetch(`${proxy.base}/api/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal((await res.json()).error.code, 'FORBIDDEN_ORIGIN');
  });

  test('actual request from a foreign origin -> 403 even with the secret', async () => {
    const res = await fetch(`${proxy.base}/api/health`, {
      headers: withSecret({ Origin: 'https://evil.example' }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('"null" origin (file://) is not allowlisted', async () => {
    const res = await fetch(`${proxy.base}/api/health`, {
      headers: withSecret({ Origin: 'null' }),
    });
    assert.equal(res.status, 403);
  });

  test('allowlisted origin gets CORS headers on the real response', async () => {
    const res = await fetch(`${proxy.base}/api/health`, {
      headers: withSecret({ Origin: APP_ORIGIN }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), APP_ORIGIN);
  });

  test('401 responses for allowlisted origins carry CORS headers so the client can read them', async () => {
    const res = await fetch(`${proxy.base}/api/health`, { headers: { Origin: DEV_ORIGIN } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), DEV_ORIGIN);
  });

  test('dev origin is not allowed when the allowlist omits it', async () => {
    const packaged = await startTestProxy({ allowedOrigins: [APP_ORIGIN] });
    try {
      const res = await fetch(`${packaged.base}/api/health`, {
        headers: withSecret({ Origin: DEV_ORIGIN }),
      });
      assert.equal(res.status, 403);
    } finally {
      await packaged.close();
    }
  });
});
