import { formatCalendarDate, formatInstant } from './format.mjs';

/**
 * Pure renderer of the sprint close model (`buildSprintClose`) into ONE standalone HTML document:
 * all CSS inline (Flock tokens as custom properties), no scripts, no external resources. Every
 * value that comes from Jira or from the caller is HTML-escaped. Deterministic: no clock reads.
 *
 * @typedef {import('./sprint-close.mjs').SprintClose} SprintClose
 * @typedef {import('./sprint-close.mjs').ItemView} ItemView
 * @typedef {import('./sprint-close.mjs').PrimaryEntry} PrimaryEntry
 * @typedef {import('./sprint-close.mjs').EpicGroup} EpicGroup
 * @typedef {import('./sprint-close.mjs').Kpis} Kpis
 * @typedef {{
 *   title: string, teamName: string, generatedAt: string, timeZone: string, jiraBaseUrl?: string | null,
 * }} SprintCloseHtmlOptions
 */

const LAYER_LABEL = { frontend: 'Frontend', backend: 'Backend', functional: 'Funcional' };
const NO_LAYER_LABEL = 'Sin capa';

const STYLE = `
:root{--brand:#7800C0;--brand-dark:#300840;--brand-2:#9D2BD6;--accent:#F85000;--brand-soft:#f3e6fb;--brand-softer:#faf5fe;--surface:#f8f3fc;--panel:#ffffff;--bg:#ffffff;--text:#2c0b3a;--text-soft:#6b5a78;--text-faint:#9b8aa8;--border:#e9ddf4;--border-strong:#d9c7ec;--radius:12px;--shadow:0 1px 3px rgba(48,8,64,.08),0 1px 2px rgba(48,8,64,.05);--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--brand-gradient:linear-gradient(120deg,#300840 0%,#7800C0 100%);--pending-bg:#f1ecf6;--pending-fg:#6b5a78;--doing-bg:#f3e6fb;--doing-fg:#7800C0;--blocked-bg:#fde7ee;--blocked-fg:#be123c;--done-bg:#dcf7e6;--done-fg:#15803d}
*{box-sizing:border-box}
body{margin:0;background:var(--brand-softer);color:var(--text);font-family:var(--font-sans);font-size:14px;line-height:1.5}
main{max-width:1040px;margin:0 auto;padding:24px 16px 48px}
header.top{background:var(--brand-gradient);color:#fff;border-radius:var(--radius);padding:24px;margin-bottom:16px}
header.top h1{margin:0 0 4px;font-size:24px;font-weight:700}
header.top p{margin:0;font-size:14px;opacity:.9}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.kpi{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:12px 16px}
.kpi .n{display:block;font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:28px;font-weight:700;color:var(--brand)}
.kpi .l{font-size:12px;color:var(--text-soft)}
section.layer{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px;margin-bottom:16px}
section.layer h2{margin:0;font-size:18px;color:var(--brand-dark)}
.layer-kpis{margin:0 0 12px;font-size:12px;color:var(--text-soft)}
.epic{margin-top:12px}
.epic h3{margin:0 0 4px;font-size:14px;color:var(--brand-dark);border-bottom:1px solid var(--border);padding-bottom:4px}
.epic h3 .key{font-family:var(--font-mono)}
.row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding:6px 0;border-bottom:1px solid var(--border)}
.row .key{font-family:var(--font-mono);font-size:12px;font-weight:600}
.row .key a{color:var(--brand);text-decoration:none}
.row .type{font-size:11px;color:var(--text-faint)}
.row .summary{flex:1 1 240px;min-width:0}
.row .who{font-size:12px;color:var(--text-soft)}
.row .moves{font-size:11px;color:var(--text-faint);font-family:var(--font-mono);flex-basis:100%}
.sub{margin-left:24px}
.dim{opacity:.55}
.chip{display:inline-block;border-radius:50px;padding:1px 8px;font-size:11px;font-weight:600;white-space:nowrap}
.chip-todo{background:var(--pending-bg);color:var(--pending-fg)}
.chip-doing{background:var(--doing-bg);color:var(--doing-fg)}
.chip-done{background:var(--done-bg);color:var(--done-fg)}
.chip-blocked{background:var(--blocked-bg);color:var(--blocked-fg);box-shadow:inset 0 0 0 1px var(--blocked-fg)}
.mark{font-size:11px;font-weight:600;color:var(--done-fg)}
.ref{display:inline-block;border:1px solid var(--border-strong);border-radius:50px;padding:0 6px;font-size:11px;color:var(--text-soft);background:var(--surface)}
.hygiene{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:var(--radius);padding:16px;margin-bottom:16px}
.hygiene h2{margin:0 0 8px;font-size:18px;color:var(--brand-dark)}
.hygiene ul{margin:0;padding-left:20px}
.empty{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:24px;text-align:center;color:var(--text-soft)}
@media print{body{background:#fff;font-size:12px}main{max-width:none;padding:0}header.top{background:#fff;color:var(--text);border:1px solid var(--border-strong)}.kpi,section.layer,.hygiene{box-shadow:none;break-inside:avoid-page}.row{break-inside:avoid}}
`;

/** @param {unknown} value */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Origin-only https base, or null. @param {unknown} raw */
function safeBase(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? `https://${url.host}` : null;
  } catch {
    return null;
  }
}

/**
 * @param {SprintClose} report
 * @param {SprintCloseHtmlOptions} options
 * @returns {string}
 */
export function renderSprintCloseHtml(report, options) {
  const base = safeBase(options.jiraBaseUrl);

  /** @param {string} key */
  const keyHtml = (key) =>
    base === null
      ? `<span class="key">${esc(key)}</span>`
      : `<span class="key"><a href="${esc(`${base}/browse/${encodeURIComponent(key)}`)}" rel="noopener noreferrer">${esc(key)}</a></span>`;

  /** @param {ItemView} item */
  const chipHtml = (item) => {
    const cls = item.blocked ? 'chip-blocked' : `chip-${item.category}`;
    return `<span class="chip ${cls}">${esc(item.statusName)}</span>`;
  };

  /** @param {ItemView} item */
  const movesHtml = (item) => {
    if (item.periodChanges.length === 0) return '';
    const text = item.periodChanges.map((c) => `${c.fromStatusName ?? '—'} → ${c.toStatusName ?? c.toStatusId}`).join(', ');
    return `<span class="moves">${esc(text)}</span>`;
  };

  /** @param {ItemView} item @param {boolean} sub */
  const itemRow = (item, sub) =>
    `<div class="row${sub ? ' sub' : ''}">${keyHtml(item.key)}<span class="type">${esc(item.issueTypeName)}</span>` +
    `<span class="summary">${esc(item.summary)}</span>${chipHtml(item)}` +
    (item.closedInPeriod ? '<span class="mark">cerrado</span>' : '') +
    `<span class="who">${esc(item.assigneeName ?? 'Sin asignar')}</span>${movesHtml(item)}</div>`;

  /** @param {PrimaryEntry} primary */
  const primaryHtml = (primary) => {
    const subs = primary.subtasks.map((s) => itemRow(s, true)).join('');
    if (primary.item === null) {
      return `<div class="primary dim"><div class="row">${keyHtml(primary.key)}<span class="ref">ref.</span></div>${subs}</div>`;
    }
    const row = itemRow(primary.item, false);
    if (primary.counted) return `<div class="primary">${row}${subs}</div>`;
    const dimmed = row.replace('<span class="type">', '<span class="ref">ref.</span><span class="type">');
    return `<div class="primary dim">${dimmed}${subs}</div>`;
  };

  /** @param {EpicGroup} epic */
  const epicHtml = (epic) => {
    const head =
      epic.epicKey === null
        ? 'Sin épica'
        : `${keyHtml(epic.epicKey)}${epic.epicSummary ? ` ${esc(epic.epicSummary)}` : ''}`;
    return `<div class="epic"><h3>${head}</h3>${epic.primaries.map(primaryHtml).join('')}</div>`;
  };

  /** @param {Kpis} kpis */
  const kpiCards = (kpis) =>
    [
      ['Ítems con movimiento', kpis.withMovement],
      ['Primarias', kpis.primaries],
      ['Secundarias', kpis.secondaries],
      ['Cerrados', kpis.closed],
      ['Bloqueados', kpis.blocked],
    ]
      .map(([label, n]) => `<div class="kpi"><span class="n">${n}</span><span class="l">${label}</span></div>`)
      .join('');

  const layerSections = report.layers
    .map((section) => {
      const label = section.layer === null ? NO_LAYER_LABEL : LAYER_LABEL[section.layer];
      const k = section.kpis;
      return (
        `<section class="layer"><h2>${esc(label)}</h2>` +
        `<p class="layer-kpis">${k.counted} contados · ${k.closed} cerrados · ${k.blocked} bloqueados</p>` +
        `${section.epics.map(epicHtml).join('')}</section>`
      );
    })
    .join('');

  const outside =
    report.outside.epics.length === 0
      ? ''
      : `<section class="layer"><h2>Fuera de las épicas del equipo</h2>` +
        `<p class="layer-kpis">${report.outside.kpis.withMovement} con movimiento · ${report.outside.kpis.closed} cerrados · ${report.outside.kpis.blocked} bloqueados</p>` +
        `${report.outside.epics.map(epicHtml).join('')}</section>`;

  /** @param {import('./sprint-close.mjs').HygieneNote} note */
  const noteText = (note) => {
    switch (note.code) {
      case 'multiple_layers':
        return `${keyHtml(note.key)} figura en más de una capa (${note.layers.map((l) => LAYER_LABEL[l]).join(', ')})`;
      case 'parent_open_all_subtasks_done':
        return `${keyHtml(note.key)} sigue abierta con todas sus subtareas cerradas`;
      case 'subtask_open_under_done_parent':
        return `${keyHtml(note.key)} sigue abierta bajo ${keyHtml(note.parentKey)}, que ya está cerrada`;
      default:
        return '';
    }
  };

  const hygiene =
    report.hygiene.length === 0
      ? ''
      : `<section class="hygiene"><h2>Notas de higiene de Jira</h2><ul>${report.hygiene
          .map((n) => `<li>${noteText(n)}</li>`)
          .join('')}</ul></section>`;

  const empty =
    report.layers.length === 0 && report.outside.epics.length === 0
      ? '<div class="empty">No hubo movimiento de estados en el período.</div>'
      : '';

  const period = `del ${formatCalendarDate(report.period.from)} al ${formatCalendarDate(report.period.to)}`;
  const generated = formatInstant(options.generatedAt, 'es-AR', options.timeZone);

  return (
    `<!doctype html>\n<html lang="es"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(options.title)}</title><style>${STYLE}</style></head><body><main>` +
    `<header class="top"><h1>${esc(options.title)}</h1>` +
    `<p>${esc(options.teamName)} · ${period}</p><p>Generado el ${esc(generated)}</p></header>` +
    `<div class="kpis">${kpiCards(report.kpis)}</div>` +
    `${empty}${layerSections}${outside}${hygiene}</main></body></html>\n`
  );
}
