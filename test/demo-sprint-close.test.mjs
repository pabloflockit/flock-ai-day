import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemoFetch } from '../fixtures/demo/demo-fetch.mjs';
import { DEMO_BASE_URL, DEMO_HOST, DEMO_TOKEN, buildDemoConfig } from '../fixtures/demo/index.mjs';
import { createJiraClient } from '../proxy/jira/client.mjs';
import { createGuardedFetch } from '../proxy/security/guarded-fetch.mjs';
import { fetchProjectIssues } from '../proxy/jira/hierarchy.mjs';
import { fetchMemberIssues } from '../proxy/jira/member-issues.mjs';
import { buildSprintClose } from '../shared/domain/sprint-close.mjs';
import { renderSprintCloseHtml } from '../shared/domain/sprint-close-html.mjs';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const TZ = 'America/Argentina/Buenos_Aires';
const CATEGORY = { new: 'todo', indeterminate: 'doing', done: 'done' };

async function demoReport() {
  const config = buildDemoConfig();
  const guarded = createGuardedFetch({ fetchImpl: createDemoFetch({ now: () => NOW, failingEpics: [] }), getAllowedHosts: () => [DEMO_HOST] });
  const client = createJiraClient({
    getConfig: () => config,
    secrets: { getJiraToken: () => DEMO_TOKEN },
    fetchImpl: guarded,
    sleep: async () => {},
  });
  const shards = await fetchProjectIssues({ client, project: config.projects[0], config, sinceMinutes: null, failingEpics: [] });
  const epicRows = shards.flatMap((s) => s.rows);
  const members = config.teams[0].members.map((m) => m.accountId);
  const memberOut = await fetchMemberIssues({ client, accountIds: members, since: '2026-09-01', config, sinceMinutes: null });
  assert.equal(memberOut.status, 'ok');
  const statuses = (await client.statuses()).map((s) => ({
    id: String(s.id),
    name: s.name,
    statusCategory: CATEGORY[s.statusCategory.key] ?? null,
  }));
  const report = buildSprintClose({
    teamId: 'demo-team',
    config,
    period: { from: '2026-09-01', to: '2026-10-09' },
    timeZone: TZ,
    statuses,
    blockedStatusIds: config.jira.blockedStatusIds,
    epicRows,
    memberRows: memberOut.rows,
  });
  return { report, config };
}

test('the demo sprint close shows layers, ref. rows, hygiene, blocked and outside work', async () => {
  const { report } = await demoReport();
  const layers = report.layers.map((l) => l.layer);
  for (const layer of ['frontend', 'backend', 'functional']) assert.ok(layers.includes(layer), `layer ${layer}: ${layers}`);
  const entries = report.layers.flatMap((l) => l.epics.flatMap((e) => e.primaries));
  assert.ok(entries.some((p) => p.counted === false && p.item && p.subtasks.length > 0), 'a ref. primary');
  const codes = new Set(report.hygiene.map((n) => n.code));
  for (const code of ['multiple_layers', 'parent_open_all_subtasks_done', 'subtask_open_under_done_parent']) {
    assert.ok(codes.has(code), `${code}: ${JSON.stringify(report.hygiene)}`);
  }
  assert.ok(report.kpis.blocked >= 1);
  const outside = new Set(report.outside.epics.flatMap((e) => e.primaries.flatMap((p) => [p.key, ...p.subtasks.map((s) => s.key)])));
  assert.ok(outside.has('DEMO-25') || report.outside.epics.some((e) => e.epicKey === 'DEMO-25'));
  assert.ok(outside.has('DEMO-28'));
});

test('the demo sprint close renders the layer labels and the hygiene section', async () => {
  const { report } = await demoReport();
  const html = renderSprintCloseHtml(report, {
    title: 'Cierre de sprint',
    teamName: 'Demo team',
    generatedAt: '2026-10-09T12:00:00.000Z',
    timeZone: TZ,
    jiraBaseUrl: DEMO_BASE_URL,
  });
  for (const label of ['Frontend', 'Backend', 'Funcional', 'Notas de higiene de Jira']) assert.ok(html.includes(label), label);
});
