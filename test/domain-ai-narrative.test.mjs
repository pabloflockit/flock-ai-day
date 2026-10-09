import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HEADLINES,
  MAX_READING_CHARS,
  checkNarrativeFigures,
  narrativeInput,
  parseNarrative,
} from '../shared/domain/ai-narrative.mjs';

const item = (key, o = {}) => ({
  key,
  summary: `Resumen ${key}`,
  issueTypeName: 'Story',
  isSubtask: false,
  statusId: '2',
  statusName: 'En curso',
  category: 'doing',
  assigneeName: 'Zulema Quiroga',
  layers: [],
  moved: true,
  closedInPeriod: false,
  blocked: false,
  periodChanges: [],
  ...o,
});
const kpis = (o = {}) => ({ withMovement: 7, primaries: 4, secondaries: 3, closed: 2, blocked: 1, ...o });

function report() {
  const closed = item('ABC-12', { closedInPeriod: true });
  const blocked = item('ABC-13', { blocked: true });
  const epic = {
    epicKey: 'ABC-1',
    epicSummary: 'Épica uno',
    primaries: [
      { key: 'ABC-12', item: closed, counted: true, subtasks: [item('ABC-14', { isSubtask: true })] },
      { key: 'ABC-13', item: blocked, counted: true, subtasks: [] },
    ],
  };
  return {
    period: { from: '2026-09-01', to: '2026-09-14' },
    kpis: kpis(),
    layers: [{ layer: 'frontend', kpis: { counted: 5, closed: 2, blocked: 1 }, epics: [epic] }],
    outside: {
      kpis: kpis({ withMovement: 1, primaries: 1, secondaries: 0, closed: 0, blocked: 0 }),
      epics: [{ epicKey: null, epicSummary: null, primaries: [{ key: 'X-9', item: item('X-9'), counted: true, subtasks: [] }] }],
    },
    hygiene: [{ code: 'multiple_layers', key: 'ABC-12', layers: ['frontend', 'backend'] }],
  };
}

test('narrativeInput: figures, epics, closed/blocked keys; no people', () => {
  const input = narrativeInput(report(), { teamName: 'Equipo Uno' });
  assert.equal(input.team, 'Equipo Uno');
  assert.deepEqual(input.period, { from: '2026-09-01', to: '2026-09-14' });
  assert.equal(input.kpis.closed, 2);
  assert.deepEqual(input.layers[0].epics, [{ key: 'ABC-1', summary: 'Épica uno', items: 3 }]);
  assert.deepEqual(input.closedItems, [{ key: 'ABC-12', summary: 'Resumen ABC-12' }]);
  assert.deepEqual(input.blockedItems, [{ key: 'ABC-13', summary: 'Resumen ABC-13' }]);
  assert.equal(input.hygiene[0].code, 'multiple_layers');
  assert.equal(input.outside.kpis.withMovement, 1);
  const text = JSON.stringify(input);
  assert.ok(!text.includes('Zulema') && !/assignee/i.test(text));
});

test('checkNarrativeFigures passes for report figures, dates and issue keys', () => {
  const narrative = {
    headlines: ['Se cerraron 2 ítems de 7', 'ABC-12 y ABC-13 lideraron'],
    reading: 'Del 1 al 14 de septiembre de 2026 hubo 4 primarias y 3 secundarias; 1 bloqueado, 5 en frontend.',
  };
  assert.deepEqual(checkNarrativeFigures(narrative, report()), { ok: true, unknownNumbers: [] });
});

test('checkNarrativeFigures reports unknown numbers once each', () => {
  const result = checkNarrativeFigures(
    { headlines: ['Se cerraron 99 ítems'], reading: 'Fueron 99, o 3,5 mejor dicho, y 2 de ellos ABC-777' },
    report(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownNumbers, ['99', '3,5']);
});

test('text without numbers is ok', () => {
  assert.equal(checkNarrativeFigures({ headlines: ['Buen sprint'], reading: 'Sin cifras.' }, report()).ok, true);
});

test('parseNarrative: plain JSON, fences and surrounding prose', () => {
  const json = JSON.stringify({ titulares: ['A', ' B '], lectura: ' Texto ' });
  const expected = { headlines: ['A', 'B'], reading: 'Texto' };
  assert.deepEqual(parseNarrative(json), expected);
  assert.deepEqual(parseNarrative('```json\n' + json + '\n```'), expected);
  assert.deepEqual(parseNarrative('Acá va: ' + json + ' ¡listo!'), expected);
});

test('parseNarrative: garbage and wrong shapes are null', () => {
  for (const bad of ['', 'nada', '{', '[]', '{"titulares":[],"lectura":""}', '{"otro":1}', null, 5]) {
    assert.equal(parseNarrative(bad), null, String(bad));
  }
});

test('parseNarrative caps counts and lengths and drops non-strings', () => {
  const titulares = [...Array.from({ length: 9 }, (_, i) => `T${i}`), 7, ''];
  const parsed = parseNarrative(JSON.stringify({ titulares, lectura: 'x'.repeat(MAX_READING_CHARS + 50) }));
  assert.equal(parsed.headlines.length, MAX_HEADLINES);
  assert.equal(parsed.reading.length, MAX_READING_CHARS);
  assert.deepEqual(parseNarrative('{"titulares":"no","lectura":"ok"}'), { headlines: [], reading: 'ok' });
});
