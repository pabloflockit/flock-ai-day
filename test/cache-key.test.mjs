import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, projectIssuesParams, hash64 } from '../shared/cache-key.mjs';
import { normalizeConfig } from '../proxy/config/normalize.mjs';

test('resolveTarget is stable and has the documented shape', () => {
  const a = resolveTarget('p1', 'projectIssues', { b: 1, a: [2, 1] });
  assert.match(a.paramsKey, /^[0-9a-f]{16}$/);
  assert.equal(a.cacheKey, `p1|projectIssues|${a.paramsKey}`);
  assert.deepEqual(a, resolveTarget('p1', 'projectIssues', { a: [1, 2], b: 1 }));
  assert.equal(a.paramsKey, resolveTarget('other', 'other', { a: [1, 2], b: 1 }).paramsKey);
});

test('the hash is pinned (changing it invalidates every cache)', () => {
  assert.equal(hash64('a'), 'af63dc4c8601ec8c', 'published FNV-1a 64 test vector');
  assert.equal(resolveTarget('s', 'x', {}).paramsKey, '08f44b07b5901a25'); // FNV-1a 64 of "{}"
  assert.equal(resolveTarget('s', 'x', undefined).paramsKey, resolveTarget('s', 'x', {}).paramsKey);
});

test('different params, scope or source change the cache key', () => {
  const base = resolveTarget('p1', 'a', { k: 1 });
  assert.notEqual(base.paramsKey, resolveTarget('p1', 'a', { k: 2 }).paramsKey);
  assert.notEqual(base.cacheKey, resolveTarget('p2', 'a', { k: 1 }).cacheKey);
  assert.notEqual(base.cacheKey, resolveTarget('p1', 'b', { k: 1 }).cacheKey);
  assert.notEqual(
    resolveTarget('p', 's', { v: '1' }).paramsKey,
    resolveTarget('p', 's', { v: 1 }).paramsKey,
  );
  assert.notEqual(
    resolveTarget('p', 's', { v: null }).paramsKey,
    resolveTarget('p', 's', {}).paramsKey,
  );
});

test('rejects values that cannot be canonicalised', () => {
  assert.throws(() => resolveTarget('p', 's', { v: NaN }));
  assert.throws(() => resolveTarget('p', 's', { v: () => 1 }));
});

const config = () =>
  normalizeConfig({
    jira: { epicLinkMode: 'epic_link', epicLinkFieldId: 'customfield_9' },
    teams: [{ id: 't1', name: 'T', members: [{ accountId: 'm1' }] }],
    projects: [
      {
        id: 'p1',
        teamId: 't1',
        name: 'P',
        measure: { kind: 'field', fieldId: 'customfield_5', fieldName: 'SP', valueType: 'number' },
        epics: [
          { key: 'E-2', active: true },
          { key: 'E-1', active: true },
          { key: 'E-3', active: false },
        ],
      },
    ],
  });
const keyOf = (c) => {
  const p = c.projects[0];
  return resolveTarget(p.id, 'projectIssues', projectIssuesParams(p, c)).cacheKey;
};

test('projectIssuesParams only holds query-changing params', () => {
  const c = config();
  assert.deepEqual(projectIssuesParams(c.projects[0], c), {
    epicKeys: ['E-1', 'E-2'],
    measureFieldIds: ['customfield_5'],
    epicLinkMode: 'epic_link',
    epicLinkFieldId: 'customfield_9',
  });
  const count = config();
  count.projects[0].measure = { kind: 'count' };
  assert.deepEqual(projectIssuesParams(count.projects[0], count).measureFieldIds, []);
});

test('key is invariant to order, members, names, descriptions, synced fields, overrides, inactive epics', () => {
  const before = keyOf(config());
  const c = config();
  c.projects[0].epics.reverse();
  c.teams[0].members.push({ ...c.teams[0].members[0], accountId: 'm2' });
  c.teams[0].name = 'Renamed';
  c.teams[0].description = 'd';
  c.projects[0].name = 'Renamed';
  c.projects[0].description = 'd';
  c.projects[0].epics[0].summary = 'synced';
  c.projects[0].epics[0].linkMethodUsed = 'parent';
  c.projects[0].epics.find((e) => e.key === 'E-3').key = 'E-99'; // inactive epic
  c.jira.statusCategoryOverrides = { 10: 'done' };
  c.settings.staleBusinessDays = 99;
  c.jira.timeoutMs = 1;
  assert.equal(keyOf(c), before);
});

test('key changes with active epics, measure field, link mode and link field', () => {
  const before = keyOf(config());
  const mutations = [
    (c) => c.projects[0].epics.push({ key: 'E-7', active: true }),
    (c) => (c.projects[0].epics.find((e) => e.key === 'E-3').active = true),
    (c) => (c.projects[0].epics.find((e) => e.key === 'E-1').active = false),
    (c) => (c.projects[0].measure.fieldId = 'customfield_6'),
    (c) => (c.projects[0].measure = { kind: 'count' }),
    (c) => (c.jira.epicLinkMode = 'parent'),
    (c) => (c.jira.epicLinkFieldId = 'customfield_10'),
  ];
  const seen = new Set([before]);
  for (const mutate of mutations) {
    const c = config();
    mutate(c);
    const key = keyOf(c);
    assert.ok(!seen.has(key), String(mutate));
    seen.add(key);
  }
});

test('the dataset cache key does not move with the component layers (rows carry every component)', () => {
  const before = keyOf(config());
  const c = config();
  c.jira.componentLayers = [{ projectKey: 'E', componentId: '1', componentName: 'FE', layer: 'frontend' }];
  assert.equal(keyOf(c), before);
  c.jira.componentLayers.push({ projectKey: 'E', componentId: '2', componentName: 'BE', layer: 'backend' });
  assert.equal(keyOf(c), before);
});

test('the dataset cache key does not move with the blocked statuses (applied when the report is built)', () => {
  const before = keyOf(config());
  const c = config();
  c.jira.blockedStatusIds = ['10', '11'];
  assert.equal(keyOf(c), before);
});
