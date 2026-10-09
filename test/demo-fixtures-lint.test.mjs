import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const DIR = new URL('../fixtures/demo/', import.meta.url);
const files = readdirSync(DIR)
  .filter((name) => statSync(new URL(name, DIR)).isFile())
  .map((name) => ({ name, text: readFileSync(new URL(name, DIR), 'utf8') }));

test('the demo fixture directory is not empty', () => {
  assert.ok(files.length >= 3);
});

test('fixtures contain no email except example-domain ones', () => {
  for (const { name, text } of files) {
    for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)/g)) {
      assert.match(match[1], /(^|\.)example\.(com|org|net)$|\.example\./, `${name}: ${match[0]}`);
    }
  }
});

test('fixtures contain no issue key outside DEMO-<n>', () => {
  for (const { name, text } of files) {
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]+-\d+\b/g)) {
      assert.match(match[0], /^DEMO-\d+$/, `${name}: ${match[0]}`);
    }
  }
});

test('fixtures only reference the demo site or example domains', () => {
  for (const { name, text } of files) {
    for (const match of text.matchAll(/https?:\/\/([^/"'\s)]+)/g)) {
      assert.match(
        match[1],
        /(^|\.)example\.(com|org|net)$|^demo\.example\.atlassian\.net$/,
        `${name}: ${match[0]}`,
      );
    }
  }
});
