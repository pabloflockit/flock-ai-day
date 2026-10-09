import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnvContent, loadDevEnv } from '../proxy/dev/load-env.mjs';

function withDir(files, run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lp-env-'));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseEnvContent: comments, blanks, quotes and = inside values', () => {
  const out = parseEnvContent('# c\n\nA=1\nB = "two words"\nC=\'x\'\nD=a=b\r\nbad line\n=novalue\n');
  assert.deepEqual(out, { A: '1', B: 'two words', C: 'x', D: 'a=b' });
});

test('real environment wins over files; .env.local wins over .env', () => {
  const files = {
    '.env': 'JIRA_EMAIL=file@example.com\nJIRA_BASE_URL=https://a.example.net\n',
    '.env.local': 'JIRA_BASE_URL=https://b.example.net\n',
  };
  withDir(files, (dir) => {
    const env = { JIRA_EMAIL: 'real@example.com' };
    const result = loadDevEnv({ rootDir: dir, env, packaged: false });
    assert.equal(env.JIRA_EMAIL, 'real@example.com');
    assert.equal(env.JIRA_BASE_URL, 'https://b.example.net');
    assert.deepEqual(result.loaded, ['JIRA_BASE_URL']);
  });
});

test('ignored entirely when packaged', () => {
  withDir({ '.env': 'JIRA_API_TOKEN=should-not-load\n' }, (dir) => {
    const env = {};
    const result = loadDevEnv({ rootDir: dir, env, packaged: true });
    assert.deepEqual(env, {});
    assert.deepEqual(result.loaded, []);
  });
});

test('missing files are skipped and values are never part of the result', () => {
  withDir({ '.env': 'JIRA_API_TOKEN=super-secret-value\n' }, (dir) => {
    const result = loadDevEnv({ rootDir: dir, env: {}, packaged: false });
    assert.doesNotMatch(JSON.stringify(result), /super-secret-value/);
  });
  const missing = loadDevEnv({ rootDir: path.join(tmpdir(), 'lp-does-not-exist'), env: {}, packaged: false });
  assert.deepEqual(missing.loaded, []);
});
