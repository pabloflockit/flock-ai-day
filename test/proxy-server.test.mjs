import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProxyServer } from '../proxy/server.mjs';
import { TEST_SECRET, withSecret } from './helpers.mjs';

/** @type {import('node:http').Server} */
let server;
let base = '';

before(async () => {
  server = await startProxyServer({ port: 0, version: '9.9.9', proxySecret: TEST_SECRET });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET /api/health returns the ok envelope with version', async () => {
  const res = await fetch(`${base}/api/health`, { headers: withSecret() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { ok: true, data: { status: 'ok', version: '9.9.9' } });
});

test('unknown route returns 404 NOT_FOUND envelope', async () => {
  const res = await fetch(`${base}/api/nope`, { headers: withSecret() });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.equal(typeof body.error.message, 'string');
});

test('wrong method on a known route returns 405', async () => {
  const res = await fetch(`${base}/api/health`, { method: 'POST', headers: withSecret() });
  assert.equal(res.status, 405);
  assert.equal((await res.json()).error.code, 'METHOD_NOT_ALLOWED');
});

test('a guard can short-circuit before routing', async () => {
  const guarded = await startProxyServer({
    port: 0,
    proxySecret: TEST_SECRET,
    guards: [
      () => ({ status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } } }),
    ],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${guarded.address().port}/api/health`, {
      headers: withSecret(),
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((resolve) => guarded.close(resolve));
  }
});

test('refuses to bind to anything other than 127.0.0.1', async () => {
  await assert.rejects(
    startProxyServer({ port: 0, host: '0.0.0.0', proxySecret: TEST_SECRET }),
    /127\.0\.0\.1/,
  );
  await assert.rejects(
    startProxyServer({ port: 0, host: 'localhost', proxySecret: TEST_SECRET }),
    /127\.0\.0\.1/,
  );
});
