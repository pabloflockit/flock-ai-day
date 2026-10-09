import { loadByMember, progress, staleUnits } from './metrics.mjs';
import { addDays, compareCalendarDates, toCalendarDate } from './dates.mjs';
import { formatCalendarDate, formatInstant } from './format.mjs';

/**
 * Deterministic Markdown reports (plan §8.1) built from the same scoped units and metric functions
 * as the dashboard, so the figures cannot drift. Pure: no clock (`now`, `timeZone` and the period are
 * parameters), no I/O, inputs are not mutated. Issue text is data: it is escaped, never interpreted.
 *
 * @typedef {import('./work-units.mjs').WorkUnit} WorkUnit
 * @typedef {import('./work-units.mjs').Measure} Measure
 * @typedef {import('../../proxy/config/normalize.mjs').Project} Project
 * @typedef {import('../../proxy/config/normalize.mjs').Member} Member
 * @typedef {{ from: string, to: string }} Period calendar dates, inclusive
 * @typedef {{ unitType: 'task' | 'subtask', measure: Measure, units: WorkUnit[], unassignedOpen?: WorkUnit[] }} ReportGroup
 * @typedef {{
 *   teamName: string,
 *   scopeLabel: string,
 *   groups: ReportGroup[],
 *   projects: Pick<Project, 'id' | 'name' | 'epics'>[],
 *   members: Pick<Member, 'accountId' | 'displayName' | 'active'>[],
 *   staleBusinessDays: number,
 *   period: Period,
 *   now: string,
 *   timeZone: string,
 *   generatedAt: string,
 * }} ReportInput
 */

const PERIOD_DAYS = 14;
const LOCALE = 'es-AR';
const numberFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });

/**
 * Last two weeks inclusive: `to` is the local today, `from` is 13 days earlier.
 *
 * @param {{ now: string, timeZone: string }} clock
 * @returns {Period}
 */
export function defaultPeriod({ now, timeZone }) {
  const to = toCalendarDate(now, timeZone);
  return { from: addDays(to, -(PERIOD_DAYS - 1)), to };
}

/**
 * Units whose effective `doneAt` falls, on the LOCAL calendar of `timeZone`, within [from, to].
 *
 * @param {WorkUnit[]} units
 * @param {Period & { timeZone: string }} options
 * @returns {WorkUnit[]}
 */
export function closedInPeriod(units, { from, to, timeZone }) {
  return units.filter((u) => {
    if (u.doneAt === null) return false;
    const day = toCalendarDate(u.doneAt, timeZone);
    return compareCalendarDates(day, from) >= 0 && compareCalendarDates(day, to) <= 0;
  });
}

/** Escapes Markdown-sensitive characters of issue text (single line). @param {string | null | undefined} text */
function esc(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>|]/g, '\\$&')
    .replace(/^(#|[-+]|\d+[.)])/, '\\$1');
}

/** @param {Measure} measure */
const fieldName = (measure) => (measure.kind === 'field' ? measure.fieldName : 'Cantidad');

/** @param {ReportGroup} group */
function groupTitle(group) {
  const label = group.measure.kind === 'count' ? 'Cantidad' : group.measure.valueType === 'time_seconds' ? `${group.measure.fieldName} (h)` : group.measure.fieldName;
  return `${group.unitType === 'task' ? 'Tareas' : 'Subtareas'} · ${label}`;
}

/** @param {'task' | 'subtask'} unitType @param {number} n */
const unitCount = (unitType, n) => `${n} ${unitType === 'task' ? 'tarea' : 'subtarea'}${n === 1 ? '' : 's'}`;
/** @param {'task' | 'subtask'} unitType */
const unitNoun = (unitType) => (unitType === 'task' ? 'tareas' : 'subtareas');

/** @param {number} value @param {Measure} measure */
function measureText(value, measure) {
  const text = numberFormat.format(value);
  return measure.kind === 'field' && measure.valueType === 'time_seconds' ? `${text} h` : text;
}

/** @param {{ count: number, measure: number, missingMeasure: WorkUnit[] }} done @param {{ count: number, measure: number, missingMeasure: WorkUnit[] }} total @param {ReportGroup} group */
function progressText(done, total, group) {
  const { measure, unitType } = group;
  const base = measure.kind === 'count' ? done.count : done.measure;
  const whole = measure.kind === 'count' ? total.count : total.measure;
  const percent = whole > 0 ? `(${Math.round((base / whole) * 100)}%)` : '(sin porcentaje)';
  const parts = [];
  if (measure.kind === 'count') {
    parts.push(`${done.count} de ${total.count} ${unitNoun(unitType)} ${percent}`);
  } else {
    parts.push(`${measureText(done.measure, measure)} de ${measureText(total.measure, measure)} ${fieldName(measure)} ${percent}`);
    parts.push(`${done.count} de ${total.count} ${unitNoun(unitType)}`);
    if (total.missingMeasure.length > 0) parts.push(`${total.missingMeasure.length} sin ${fieldName(measure)}`);
  }
  return parts.join(' · ');
}

/** @param {ReportGroup} group @param {ReportInput} input */
function progressSection(group, input) {
  const rows = progress(group.units, input.projects);
  const lines = ['### Avance', ''];
  if (rows.length === 0) return [...lines, 'Sin datos de avance.', ''];
  for (const p of rows) {
    lines.push(`- **${esc(p.projectName)}**: ${progressText(p.done, p.total, group)}`);
    for (const e of p.epics) lines.push(`  - ${esc(e.epicKey)} — ${esc(e.epicSummary)}: ${progressText(e.done, e.total, group)}`);
  }
  return [...lines, ''];
}

/** @param {string} title @param {string[]} items @param {string} empty */
const listSection = (title, items, empty) => [`### ${title}`, '', ...(items.length > 0 ? items.map((i) => `- ${i}`) : [empty]), ''];

/** @param {WorkUnit} a @param {WorkUnit} b */
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** @param {ReportGroup} group @param {ReportInput} input */
function closedUnits(group, input) {
  return closedInPeriod(group.units, { ...input.period, timeZone: input.timeZone }).sort(
    (a, b) => Date.parse(/** @type {string} */ (a.doneAt)) - Date.parse(/** @type {string} */ (b.doneAt)) || byKey(a, b),
  );
}

/** @param {ReportGroup} group */
const doingUnits = (group) => group.units.filter((u) => u.statusCategory === 'doing').sort(byKey);

/** @param {ReportInput} input @param {string} kind */
function header(input, kind) {
  const { from, to } = input.period;
  return [
    `# ${kind} — ${esc(input.teamName)}`,
    '',
    `- Alcance: ${esc(input.scopeLabel)}`,
    `- Período: ${formatCalendarDate(from, LOCALE)} al ${formatCalendarDate(to, LOCALE)}`,
    `- Generado: ${formatInstant(input.generatedAt, LOCALE, input.timeZone)}`,
    '',
  ];
}

const NO_DATA = 'Sin datos para el alcance seleccionado.';
const NO_CLOSED = 'Sin cierres en el período.';

/**
 * Internal sprint report: progress, closed, in progress, stale, visible blockers and load per person.
 *
 * @param {ReportInput} input
 * @returns {string}
 */
export function buildSprintReport(input) {
  const clock = { now: input.now, timeZone: input.timeZone };
  const lines = header(input, 'Informe de sprint');
  if (input.groups.length === 0) lines.push(NO_DATA, '');
  for (const group of input.groups) {
    const noun = unitNoun(group.unitType);
    const stale = staleUnits(group.units, input.staleBusinessDays, clock);
    const unassigned = (group.unassignedOpen ?? []).filter((u) => u.statusCategory !== 'done').sort(byKey);
    const who = (/** @type {WorkUnit} */ u) => esc(u.assigneeName ?? 'Sin asignar');
    const staleItem = (/** @type {{ unit: WorkUnit, days: number }} */ { unit, days }) =>
      `${esc(unit.key)} — ${esc(unit.summary)} — ${esc(unit.statusName)} — ${who(unit)} — ${days} ${days === 1 ? 'día hábil' : 'días hábiles'}`;
    lines.push(`## ${groupTitle(group)}`, '', ...progressSection(group, input));
    lines.push(...listSection('Cerrado en el período', closedUnits(group, input).map((u) => `${esc(u.key)} — ${esc(u.summary)} — ${who(u)}`), NO_CLOSED));
    lines.push(...listSection('En curso', doingUnits(group).map((u) => `${esc(u.key)} — ${esc(u.summary)} — ${esc(u.statusName)} — ${who(u)}`), `Sin ${noun} en curso.`));
    lines.push(...listSection('Estancadas', stale.map(staleItem), `Sin ${noun} estancadas (más de ${input.staleBusinessDays} días hábiles en el mismo estado).`));
    const blockers = [
      ...stale.map(({ unit, days }) => `${esc(unit.key)} — ${esc(unit.summary)} — estancada ${days} ${days === 1 ? 'día hábil' : 'días hábiles'}`),
      ...unassigned.map((u) => `${esc(u.key)} — ${esc(u.summary)} — sin asignar`),
    ];
    lines.push(...listSection('Bloqueos visibles', blockers, 'Sin bloqueos visibles.'));
    lines.push('### Carga por persona', '');
    const load = loadByMember(group.units, input.members);
    if (load.length === 0) lines.push('Sin integrantes activos.', '');
    else {
      const field = group.measure.kind === 'field';
      lines.push(`| Persona | Abiertas |${field ? ` ${esc(fieldName(group.measure))} |` : ''}`, `| --- | ---: |${field ? ' ---: |' : ''}`);
      for (const m of load) {
        const missing = m.open.missingMeasure.length > 0 ? ` (${m.open.missingMeasure.length} sin ${esc(fieldName(group.measure))})` : '';
        const cells = [esc(m.displayName), unitCount(group.unitType, m.open.count)];
        if (field) cells.push(`${measureText(m.open.measure, group.measure)}${missing}`);
        lines.push(`| ${cells.join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * External client report: progress, deliverables closed in the period and next steps. Never includes
 * people, status names, stale or unassigned information.
 *
 * @param {ReportInput} input
 * @returns {string}
 */
export function buildClientReport(input) {
  const lines = header(input, 'Informe de avance');
  if (input.groups.length === 0) lines.push(NO_DATA, '');
  for (const group of input.groups) {
    lines.push(`## ${groupTitle(group)}`, '', ...progressSection(group, input));
    lines.push(...listSection('Entregables del período', closedUnits(group, input).map((u) => `${esc(u.key)} — ${esc(u.summary)}`), NO_CLOSED));
    lines.push(...listSection('Próximos pasos', doingUnits(group).map((u) => `${esc(u.key)} — ${esc(u.summary)}`), 'Sin trabajo en curso.'));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
