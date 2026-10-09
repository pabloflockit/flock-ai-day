import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../proxy/router.mjs';

const ctx = (path, method = 'GET') => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: {},
  deps: {},
});

test('path parameters are matched per segment, decoded, and exposed as ctx.params', async () => {
  const router = createRouter();
  router.add('GET', '/api/x/:key', ({ params }) => params);
  router.add('GET', '/api/x/special', () => 'exact');
  assert.deepEqual((await router.dispatch(ctx('/api/x/EP-1'))).body.data, { key: 'EP-1' });
  assert.equal((await router.dispatch(ctx('/api/x/special'))).body.data, 'exact');
  assert.equal((await router.dispatch(ctx('/api/x/a%20b'))).body.data.key, 'a b');
  assert.equal((await router.dispatch(ctx('/api/x/a/b'))).status, 404);
  assert.equal((await router.dispatch(ctx('/api/x/'))).status, 404);
  assert.equal((await router.dispatch(ctx('/api/x/EP-1', 'POST'))).status, 405);
});
