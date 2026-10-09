import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJiraUrl } from '../shared/jira-url.mjs';

const good = [
  ['https://acme.atlassian.net', 'https://acme.atlassian.net'],
  ['https://ACME.atlassian.net/', 'https://acme.atlassian.net'],
  ['  https://acme.atlassian.net/jira/software  ', 'https://acme.atlassian.net'],
  ['https://acme.atlassian.net:443', 'https://acme.atlassian.net'],
  ['https://jira.example.com?x=1#y', 'https://jira.example.com'],
  ['https://172.32.0.1', 'https://172.32.0.1'],
  ['https://100.128.0.1', 'https://100.128.0.1'],
  ['https://8.8.8.8', 'https://8.8.8.8'],
];

const bad = [
  'http://acme.atlassian.net',
  'ftp://acme.atlassian.net',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'acme.atlassian.net',
  '',
  '   ',
  null,
  undefined,
  42,
  'https://user:pw@acme.atlassian.net',
  'https://user@acme.atlassian.net',
  'https://acme.atlassian.net:8443',
  'https://acme.atlassian.net@evil.example:8443',
  'https://localhost',
  'https://LOCALHOST',
  'https://localhost.',
  'https://foo.localhost',
  'https://127.0.0.1',
  'https://127.255.255.254',
  'https://2130706433',
  'https://0x7f.0.0.1',
  'https://0.0.0.0',
  'https://[::1]',
  'https://[::]',
  'https://10.0.0.1',
  'https://172.16.0.1',
  'https://172.31.255.255',
  'https://192.168.1.1',
  'https://169.254.169.254',
  'https://100.64.0.1',
  'https://100.127.255.255',
  'https://[fc00::1]',
  'https://[fd12:3456::1]',
  'https://[fe80::1]',
  'https://[febf::1]',
  'https://[::ffff:127.0.0.1]',
  'https://[::ffff:10.0.0.1]',
  'https://[::ffff:8.8.8.8]',
  `https://${'a'.repeat(3000)}.com`,
];

for (const [input, origin] of good) {
  test(`accepts ${JSON.stringify(input)}`, () => {
    const result = validateJiraUrl(input);
    assert.equal(result.ok, true);
    assert.equal(result.origin, origin);
    assert.equal(result.host, new URL(origin).host);
  });
}

for (const input of bad) {
  test(`rejects ${JSON.stringify(input)?.slice(0, 60)}`, () => {
    const result = validateJiraUrl(input);
    assert.equal(result.ok, false);
    assert.equal(typeof result.reason, 'string');
  });
}
