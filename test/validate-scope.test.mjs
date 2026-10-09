import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareKeySets,
  createDemoValidationContext,
  parseArgs,
  validateScope,
} from '../tools/validate-scope.mjs';

test('compareKeySets: equal sets', () => {
  const r = compareKeySets(['A-1', 'A-2'], ['A-2', 'A-1']);
  assert.deepEqual(r, { onlyPredicate: [], onlyJql: [], common: 2, predicateCount: 2, jqlCount: 2, ok: true });
});

test('compareKeySets: equal counts but different keys are a mismatch', () => {
  const r = compareKeySets(['A-1', 'A-2'], ['A-2', 'A-3']);
  assert.equal(r.predicateCount, r.jqlCount);
  assert.deepEqual(r.onlyPredicate, ['A-1']);
  assert.deepEqual(r.onlyJql, ['A-3']);
  assert.equal(r.common, 1);
  assert.equal(r.ok, false);
});

test('compareKeySets: one-sided differences, duplicates and empty input', () => {
  assert.deepEqual(compareKeySets(['A-1', 'A-1'], []).onlyPredicate, ['A-1']);
  assert.equal(compareKeySets(['A-1', 'A-1'], []).predicateCount, 1);
  assert.deepEqual(compareKeySets([], ['B-2']).onlyJql, ['B-2']);
  assert.equal(compareKeySets([], []).ok, true);
});

test('parseArgs reads epics, predicate and demo', () => {
  assert.deepEqual(parseArgs(['--epic', 'DEMO-1', '--epic', 'DEMO-2', '--predicate', 'done', '--demo']), {
    epics: ['DEMO-1', 'DEMO-2'],
    predicate: 'done',
    demo: true,
    epicLinkField: null,
  });
  assert.equal(parseArgs(['--epic', 'DEMO-1']).predicate, 'open');
  assert.throws(() => parseArgs(['--predicate', 'weird', '--epic', 'DEMO-1']), /predicate/);
  assert.throws(() => parseArgs([]), /--epic/);
  assert.throws(() => parseArgs(['--epic', 'not a key']), /key/);
});

for (const predicate of ['open', 'all', 'doing', 'done']) {
  test(`validateScope --demo has zero diff for "${predicate}"`, async () => {
    const ctx = createDemoValidationContext();
    const r = await validateScope({ ...ctx, epicKeys: ['DEMO-1', 'DEMO-2'], predicate });
    assert.deepEqual(r.onlyPredicate, []);
    assert.deepEqual(r.onlyJql, []);
    assert.equal(r.ok, true);
    if (predicate === 'all') assert.ok(r.predicateCount >= 12);
  });
}

test('validateScope: "open" is a strict subset of "all" and keeps subtasks of done children', async () => {
  const ctx = createDemoValidationContext();
  const all = await validateScope({ ...ctx, epicKeys: ['DEMO-1'], predicate: 'all' });
  const open = await validateScope({ ...ctx, epicKeys: ['DEMO-1'], predicate: 'open' });
  assert.ok(open.predicateCount > 0 && open.predicateCount < all.predicateCount);
});

test('validateScope surfaces a failing epic instead of comparing empty sets', async () => {
  const ctx = createDemoValidationContext();
  await assert.rejects(() => validateScope({ ...ctx, epicKeys: ['DEMO-3'], predicate: 'all' }), /DEMO-3/);
});

test('validateScope detects a mismatch (a status override makes the client disagree with JQL)', async () => {
  const ctx = createDemoValidationContext();
  const config = structuredClone(ctx.config);
  config.jira.statusCategoryOverrides = { 1: 'done' };
  const r = await validateScope({ ...ctx, config, epicKeys: ['DEMO-1'], predicate: 'open' });
  assert.equal(r.ok, false);
  assert.ok(r.onlyJql.length > 0);
  assert.deepEqual(r.onlyPredicate, []);
});

test('validateScope hints to suspect the script when both sides are empty', async () => {
  const ctx = createDemoValidationContext();
  const r = await validateScope({ ...ctx, epicKeys: ['DEMO-9'], predicate: 'open' });
  assert.equal(r.predicateCount, 0);
  assert.equal(r.jqlCount, 0);
  assert.match(r.hint, /script/i);
});

test('without --demo and without credentials it fails fast (exit 2), makes no request and prints no values', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { main } = await import('../tools/validate-scope.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'lp-scope-'));
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('network is off in this test');
  };
  try {
    const lines = [];
    const env = { JIRA_BASE_URL: 'https://secret-site.example.net' }; // partial: token and email missing
    const code = await main(['--epic', 'DEMO-1'], { out: (l) => lines.push(l), env, rootDir: dir });
    assert.equal(code, 2);
    assert.equal(requests, 0);
    const text = lines.join('\n');
    assert.match(text, /JIRA_EMAIL/);
    assert.match(text, /JIRA_API_TOKEN/);
    assert.doesNotMatch(text, /secret-site/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
