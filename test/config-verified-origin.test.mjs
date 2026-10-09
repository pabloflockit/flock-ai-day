import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startTestProxy, withSecret } from './helpers.mjs';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createVerifiedOrigins } from '../proxy/config/verified-origins.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Proxy with a real config store and a fake Jira whose `serverInfo` answers `deploymentType`. */
async function setup({ deploymentType = 'Cloud', verifiedOrigins } = {}) {
  const key = randomBytes(32);
  const handle = openDatabase({ path: ':memory:' });
  const configStore = createConfigStore({ handle, getDataKey: () => key });
  const jira = { serverInfo: async () => ({ deploymentType }) };
  const proxy = await startTestProxy({ stores: { config: configStore }, jira, verifiedOrigins });
  const call = async (method, path, body) => {
    const res = await fetch(`${proxy.base}${path}`, {
      method,
      headers: withSecret({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const put = (baseUrl, extra = {}) => call('PUT', '/api/config', { jira: { baseUrl }, ...extra });
  const verify = (baseUrl) => call('POST', '/api/connection/verify', { baseUrl });
  return { proxy, put, verify, call };
}

test('saving an unverified host is rejected with URL_NOT_VERIFIED and stores nothing', async () => {
  const { proxy, put, call } = await setup();
  try {
    const res = await put('https://evil.example.com');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'URL_NOT_VERIFIED');
    assert.match(res.body.error.message, /verific/i);
    assert.equal((await call('GET', '/api/config')).body.data.jira.baseUrl, '');
  } finally {
    await proxy.close();
  }
});

test('verified as Cloud, then save is accepted (also with a trailing slash)', async () => {
  const { proxy, put, verify } = await setup();
  try {
    assert.equal((await verify('https://acme.atlassian.net')).status, 200);
    assert.equal((await put('https://acme.atlassian.net/')).status, 200);
  } finally {
    await proxy.close();
  }
});

test('a non-Cloud verification does not record the origin', async () => {
  const { proxy, put, verify } = await setup({ deploymentType: 'Server' });
  try {
    assert.equal((await verify('https://onprem.example.com')).status, 422);
    const res = await put('https://onprem.example.com');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'URL_NOT_VERIFIED');
  } finally {
    await proxy.close();
  }
});

test('verifying one origin does not authorize another', async () => {
  const { proxy, put, verify } = await setup();
  try {
    await verify('https://acme.atlassian.net');
    assert.equal((await put('https://other.atlassian.net')).body.error.code, 'URL_NOT_VERIFIED');
  } finally {
    await proxy.close();
  }
});

test('editing other fields with the stored baseUrl unchanged needs no verification', async () => {
  const origins = createVerifiedOrigins();
  const { proxy, put } = await setup({ verifiedOrigins: origins });
  try {
    origins.record('https://acme.atlassian.net');
    assert.equal((await put('https://acme.atlassian.net')).status, 200);
    origins.clear();
    const teams = [{ id: 't1', name: 'Alpha', members: [] }];
    assert.equal((await put('https://acme.atlassian.net', { teams })).status, 200);
    assert.equal((await put('https://acme.atlassian.net/', { teams })).status, 200);
  } finally {
    await proxy.close();
  }
});

test('an invalid URL still fails as a validation error, and an empty one is allowed', async () => {
  const { proxy, put } = await setup();
  try {
    const bad = await put('http://x.atlassian.net');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
    assert.equal((await put('')).status, 200);
  } finally {
    await proxy.close();
  }
});

test('verification expires after the TTL', () => {
  let t = 1_000;
  const origins = createVerifiedOrigins({ ttlMs: 100, now: () => t });
  origins.record('https://acme.atlassian.net');
  assert.equal(origins.has('https://acme.atlassian.net'), true);
  t += 101;
  assert.equal(origins.has('https://acme.atlassian.net'), false);
});
