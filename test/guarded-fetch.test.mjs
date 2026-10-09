import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';

function setup(hosts) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return { status: 200 };
  };
  return { calls, guarded: createGuardedFetch({ fetchImpl, getAllowedHosts: () => hosts }) };
}

const blocked = (e) => e.code === 'EGRESS_BLOCKED';

test('allows the configured host and forwards the call', async () => {
  const { guarded, calls } = setup(['acme.atlassian.net']);
  const res = await guarded('https://acme.atlassian.net/rest/api/3/myself', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
});

test('host comparison is case-insensitive but otherwise exact', async () => {
  const { guarded } = setup(['acme.atlassian.net']);
  await guarded('https://ACME.atlassian.net/x');
  for (const url of [
    'https://evil.atlassian.net/x',
    'https://acme.atlassian.net.evil.example/x',
    'https://evil.example/acme.atlassian.net',
    'https://acme.atlassian.net:8443/x',
    'https://user@evil.example/x',
  ]) {
    await assert.rejects(guarded(url), blocked, url);
  }
});

test('blocks foreign hosts without calling fetchImpl', async () => {
  const { guarded, calls } = setup(['acme.atlassian.net']);
  await assert.rejects(guarded('https://evil.example/steal'), blocked);
  assert.equal(calls.length, 0);
});

test('blocks plain http, loopback and unparsable inputs', async () => {
  const { guarded, calls } = setup(['acme.atlassian.net', '127.0.0.1']);
  for (const url of ['http://acme.atlassian.net/x', 'https://127.0.0.1/x', 'not a url', '']) {
    await assert.rejects(guarded(url), blocked, url);
  }
  assert.equal(calls.length, 0);
});

test('nothing is allowed when no hosts are configured', async () => {
  const { guarded, calls } = setup([]);
  await assert.rejects(guarded('https://acme.atlassian.net/x'), blocked);
  assert.equal(calls.length, 0);
});

test('AI host is allowed only while getAllowedHosts returns it', async () => {
  let hosts = ['acme.atlassian.net'];
  const calls = [];
  const guarded = createGuardedFetch({
    fetchImpl: async (input) => calls.push(input),
    getAllowedHosts: () => hosts,
  });
  await assert.rejects(guarded('https://api.ai.example/v1'), blocked);
  hosts = ['acme.atlassian.net', 'api.ai.example'];
  await guarded('https://api.ai.example/v1');
  assert.equal(calls.length, 1);
});

test('accepts URL objects and request-like objects; redirects are never followed', async () => {
  const { guarded, calls } = setup(['acme.atlassian.net']);
  await guarded(new URL('https://acme.atlassian.net/a'));
  await guarded({ url: 'https://acme.atlassian.net/b' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(guarded({ url: 'https://evil.example/b' }), blocked);
});
