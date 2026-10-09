import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createJiraEndpoint } from '../proxy/config/jira-endpoint.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';

function setup() {
  const handle = openDatabase({ path: ':memory:' });
  const key = randomBytes(32);
  const store = createConfigStore({ handle, getDataKey: () => key });
  const calls = [];
  const endpoint = createJiraEndpoint(store);
  const guarded = createGuardedFetch({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { status: 200 };
    },
    getAllowedHosts: endpoint.getAllowedHosts,
  });
  return { store, guarded, calls, endpoint };
}

const AI_URL = 'https://api.anthropic.com/v1/messages';
const blocked = (e) => e.code === 'EGRESS_BLOCKED';

test('the AI host is allowed only while settings.ai.enabled is true (applies immediately)', async () => {
  const { store, guarded, calls, endpoint } = setup();
  store.save({ jira: { baseUrl: 'https://acme.atlassian.net' } }); // default: disabled
  assert.deepEqual(endpoint.getAllowedHosts(), ['acme.atlassian.net']);
  await assert.rejects(guarded(AI_URL), blocked);
  store.save({ jira: { baseUrl: 'https://acme.atlassian.net' }, settings: { ai: { enabled: true } } });
  assert.deepEqual(endpoint.getAllowedHosts(), ['acme.atlassian.net', 'api.anthropic.com']);
  assert.equal((await guarded(AI_URL)).status, 200);
  store.save({ jira: { baseUrl: 'https://acme.atlassian.net' }, settings: { ai: { enabled: false } } });
  await assert.rejects(guarded(AI_URL), blocked);
  assert.deepEqual(calls, [AI_URL]);
});

test('enabling AI does not open any other host', async () => {
  const { store, guarded } = setup();
  store.save({ jira: { baseUrl: 'https://acme.atlassian.net' }, settings: { ai: { enabled: true } } });
  for (const url of ['https://evil.example/x', 'https://api.anthropic.com.evil.example/x', 'http://api.anthropic.com/x']) {
    await assert.rejects(guarded(url), blocked, url);
  }
});

test('AI enabled without a Jira URL: only the AI host; no store: nothing', () => {
  const { store, endpoint } = setup();
  store.save({ settings: { ai: { enabled: true } } });
  assert.deepEqual(endpoint.getAllowedHosts(), ['api.anthropic.com']);
  assert.deepEqual(createJiraEndpoint(null).getAllowedHosts(), []);
});
