/**
 * Pure helpers for the AI-drafted sprint close narrative (plan §8.2). The model only DRAFTS text:
 * every figure comes from the deterministic model (`buildSprintClose`) and the text is CHECKED
 * against it. No I/O, no clock.
 *
 * @typedef {import('./sprint-close.mjs').SprintClose} SprintClose
 * @typedef {import('./sprint-close.mjs').EpicGroup} EpicGroup
 * @typedef {import('./sprint-close.mjs').ItemView} ItemView
 * @typedef {{ headlines: string[], reading: string }} Narrative
 */

export const MAX_HEADLINES = 5;
export const MAX_HEADLINE_CHARS = 300;
export const MAX_READING_CHARS = 4000;

/** Distinct work items shown in an epic group: counted primaries and every moved subtask. @param {EpicGroup} g */
function itemsOf(g) {
  return g.primaries.flatMap((p) => [...(p.counted && p.item ? [p.item] : []), ...p.subtasks]);
}

/** @param {EpicGroup} g */
const epicOf = (g) => ({ key: g.epicKey, summary: g.epicSummary, items: itemsOf(g).length });

/**
 * The ONLY data that leaves the machine for the AI draft: period, KPIs, per-layer KPIs, counts per
 * epic, keys + summaries of closed and blocked items, hygiene notes and the outside KPIs. People
 * (assignees, team members) are never included.
 *
 * @param {SprintClose} report
 * @param {{ teamName?: string }} [options]
 */
export function narrativeInput(report, { teamName } = {}) {
  /** @type {Map<string, { key: string, summary: string }>} */
  const closed = new Map();
  /** @type {Map<string, { key: string, summary: string }>} */
  const blocked = new Map();
  /** @param {EpicGroup[]} groups */
  const collect = (groups) => {
    for (const group of groups) {
      for (const item of group.primaries.flatMap((p) => [...(p.item ? [p.item] : []), ...p.subtasks])) {
        const brief = { key: item.key, summary: item.summary };
        if (item.closedInPeriod) closed.set(item.key, brief);
        if (item.blocked) blocked.set(item.key, brief);
      }
    }
  };
  collect(report.layers.flatMap((l) => l.epics));
  collect(report.outside.epics);

  return {
    team: teamName ?? '',
    period: { from: report.period.from, to: report.period.to },
    kpis: { ...report.kpis },
    layers: report.layers.map((l) => ({ layer: l.layer, kpis: { ...l.kpis }, epics: l.epics.map(epicOf) })),
    closedItems: [...closed.values()],
    blockedItems: [...blocked.values()],
    hygiene: report.hygiene.map((n) => {
      switch (n.code) {
        case 'multiple_layers':
          return { code: n.code, key: n.key, layers: [...n.layers] };
        case 'parent_open_all_subtasks_done':
          return { code: n.code, key: n.key, subtaskCount: n.subtaskKeys.length };
        default:
          return { code: n.code, key: n.key, parentKey: n.parentKey };
      }
    }),
    outside: { kpis: { ...report.outside.kpis }, epics: report.outside.epics.map(epicOf) },
  };
}

/** Numeric tokens of a text, without the digits of issue keys (`ABC-12`). @param {string} text */
function numbersIn(text) {
  const stripped = text.replace(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g, ' ');
  return stripped.match(/\d+(?:[.,]\d+)?/g) ?? [];
}

/** @param {SprintClose} report @returns {Set<string>} */
function allowedFigures(report) {
  const allowed = new Set();
  /** @param {unknown} n */
  const add = (n) => {
    if (typeof n === 'number' && Number.isFinite(n)) allowed.add(String(n));
  };
  /** @param {Record<string, unknown>} kpis */
  const addAll = (kpis) => Object.values(kpis).forEach(add);
  addAll(report.kpis);
  addAll(report.outside.kpis);
  report.layers.forEach((l) => {
    addAll(l.kpis);
    add(l.epics.length);
    l.epics.forEach((g) => add(itemsOf(g).length));
  });
  add(report.layers.length);
  add(report.outside.epics.length);
  report.outside.epics.forEach((g) => add(itemsOf(g).length));
  add(report.hygiene.length);
  report.hygiene.forEach((n) => {
    if (n.code === 'parent_open_all_subtasks_done') add(n.subtaskKeys.length);
  });
  // Period date parts: 2026-09-01 -> 2026, 9, 1 (also the zero-padded forms).
  for (const date of [report.period.from, report.period.to]) {
    for (const part of String(date).split('-')) {
      allowed.add(part);
      allowed.add(String(Number(part)));
    }
  }
  return allowed;
}

/**
 * Every number written in the narrative must be a figure of the report.
 * @param {Narrative} narrative
 * @param {SprintClose} report
 * @returns {{ ok: boolean, unknownNumbers: string[] }}
 */
export function checkNarrativeFigures(narrative, report) {
  const allowed = allowedFigures(report);
  const text = [...(narrative?.headlines ?? []), narrative?.reading ?? ''].join('\n');
  const unknown = [];
  for (const token of numbersIn(text)) {
    if (allowed.has(token) || allowed.has(String(Number(token.replace(',', '.'))))) continue;
    if (!unknown.includes(token)) unknown.push(token);
  }
  return { ok: unknown.length === 0, unknownNumbers: unknown };
}

/**
 * Parses the model answer (asked for `{ "titulares": string[], "lectura": string }`) defensively:
 * code fences and surrounding prose are tolerated, lengths are capped. `null` when unusable.
 *
 * @param {unknown} text
 * @returns {Narrative | null}
 */
export function parseNarrative(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    let data;
    try {
      data = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const headlines = (Array.isArray(data.titulares) ? data.titulares : [])
      .filter((h) => typeof h === 'string')
      .map((h) => h.trim().slice(0, MAX_HEADLINE_CHARS))
      .filter((h) => h !== '')
      .slice(0, MAX_HEADLINES);
    const reading = typeof data.lectura === 'string' ? data.lectura.trim().slice(0, MAX_READING_CHARS) : '';
    if (headlines.length === 0 && reading === '') continue;
    return { headlines, reading };
  }
  return null;
}
