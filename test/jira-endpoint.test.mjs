import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../proxy/cache/db.mjs';
import { createConfigStore } from '../proxy/config/store.mjs';
import { createJiraEndpoint } from '../proxy/config/jira-endpoint.mjs';

const setup = () => {
  const handle = openDatabase({ path: ':memory:' });
  let key = randomBytes(32);
  const store = createConfigStore({ handle, getDataKey: () => key });
  return { store, breakKey: () => (key = randomBytes(32)) };
};

test('no config or no URL: nothing is allowed', () => {
  const { store } = setup();
  const endpoint = createJiraEndpoint(store);
  assert.equal(endpoint.getJiraBaseUrl(), null);
  assert.deepEqual(endpoint.getAllowedHosts(), []);
  assert.deepEqual(createJiraEndpoint(null).getAllowedHosts(), []);
});

test('the stored URL yields its origin and exact host; config changes apply immediately', () => {
  const { store } = setup();
  const endpoint = createJiraEndpoint(store);
  store.save({ jira: { baseUrl: 'https://Acme.atlassian.net/jira/software' } });
  assert.equal(endpoint.getJiraBaseUrl(), 'https://acme.atlassian.net');
  assert.deepEqual(endpoint.getAllowedHosts(), ['acme.atlassian.net']);
  store.save({ jira: { baseUrl: 'https://other.atlassian.net' } });
  assert.deepEqual(endpoint.getAllowedHosts(), ['other.atlassian.net']);
});

test('an undecryptable config fails closed instead of throwing', () => {
  const { store, breakKey } = setup();
  store.save({ jira: { baseUrl: 'https://acme.atlassian.net' } });
  breakKey();
  const endpoint = createJiraEndpoint(store);
  assert.equal(endpoint.getJiraBaseUrl(), null);
  assert.deepEqual(endpoint.getAllowedHosts(), []);
});
