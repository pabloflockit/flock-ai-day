# Leadership Panel

> Flockit AI Day challenge — **"Panel único de liderazgo"** (single leadership panel).
> Unify in one tool what today are several loose projects — sprint reports, client reports,
> team metrics, and MCP queries to Jira/Flocktools — connected to the real APIs of each system.

A Windows desktop app that shows a technical lead the work of their teams, read directly from
a single **Jira Cloud** instance. It replaces scattered scripts and spreadsheets with one
dashboard, one source of truth, and reports generated from the same numbers.

**Status:** planning complete, implementation in progress. Nothing below is shipped yet; this
README describes the target design and the delivery plan.

---

## What it does

- **Teams, projects, and epics.** Teams have members (always pulled from Jira by `accountId`,
  never typed by hand) and projects. A project belongs to exactly one team and groups Jira
  epics. An epic belongs to exactly one project.
- **Team dashboard.** Progress, status distribution, work in progress, load per person, stale
  work, and weekly throughput — all scoped to the selected team.
- **"Outside the team".** Work in the team's epics that is unassigned or assigned to people
  outside the team, kept apart from the main metrics.
- **Reports.** Sprint report (internal) and client report (external, with no people names and
  no internal details), generated as Markdown from the same metrics shown in the dashboard.
- **Configurable measurement per project.** Unit: tasks (default), subtasks, or both side by
  side. Measure: count (default) or any numeric Jira field (story points, original estimate).
- **Generic by design.** Statuses, issue types, and fields come from the Jira API and are
  handled by id. Whatever varies between Jira setups is configured, not hardcoded.
- **Read-only on Jira.** The app never writes to Jira.

## Architecture

```
┌──────────── Electron main process ─────────────────────┐
│  · generates a per-session secret and the data key     │
│  · starts the proxy in-process on 127.0.0.1            │
│                                                        │
│  ┌─ Renderer: Angular ───────┐   ┌─ Proxy: Node ─────┐ │
│  │ standalone + signals      │──▶│ native http       │ │
│  │ hash routing, lazy pages  │   │ Jira → flat rows  │ │
│  │ single signal store       │   │ node:sqlite cache │ │
│  │ pure domain derivations   │   │ (encrypted)       │ │
│  └───────────────────────────┘   └─────────┬─────────┘ │
└────────────────────────────────────────────┼───────────┘
                                             ▼
                                    Jira Cloud REST v3
```

| Layer | Owns | Must not |
|---|---|---|
| **Main (Electron)** | Window, Electron security, secrets via `safeStorage`, proxy startup, a narrow OS bridge | Contain Jira or business logic |
| **Proxy (Node)** | JQL, pagination, bounded concurrency, field resolution, projection to flat rows, cache, encryption, error classification | Expose raw Jira issues or return the token to the client |
| **Cache (`node:sqlite`)** | Datasets keyed by `(scope_id, source, params_key)` and the config document | Store values that can be recomputed |
| **Domain (`shared/domain`)** | Metrics, scope, business days, aggregations as pure functions | Do I/O |
| **Front (Angular)** | Signal store, views, view state | Talk to Jira, re-implement the projection, see the token |

Key design rules:

- **Flat rows contract.** The proxy returns typed `IssueRow` objects; the client never reads
  `customfield_*`. `null` (no value in Jira) and `0` (estimated as zero) are never mixed up.
- **One cache-key function.** `resolveTarget()` in `shared/` is used by both proxy and front.
  Only the parameters that change the Jira query move cache keys.
- **One config normalizer.** `normalizeConfig()` is the single place where config shape migrates.
- **Incremental refresh.** Delta fetches by `updated`, periodic full loads, and a
  `PAYLOAD_VERSION` that forces a full reload when the row shape changes.
- **Degrade to stale, never to empty.** If one epic fails, its cached rows are kept and marked
  as outdated.
- **Dates done right.** UTC arithmetic, separate formatters for calendar dates and instants,
  business days counted on the local calendar date.

### Zero-dependency choices

`node:sqlite` (no native build), native `http` (no Express), native `crypto` (AES-256-GCM),
and `node --test` for proxy, cache, and domain tests.

## Security

- Electron with `contextIsolation`, `sandbox`, no `nodeIntegration`, a strict CSP, and blocked
  navigation. The preload exposes only the proxy URL and secret plus three validated helpers:
  open an issue in Jira, copy text, and save a `.md` file.
- The proxy listens on `127.0.0.1` only and rejects any request without the per-session
  `X-Proxy-Secret` header.
- The Jira API token (and the optional AI key) is encrypted with `safeStorage`, set through a
  write-only endpoint, and **never reaches the renderer**, logs, the database, or the repo.
- Outbound traffic is limited to the configured Jira host (and the AI provider only when AI is
  enabled). The Jira URL must be `https`, Cloud, and not a local or private address.
- **Database readable only by the app.** All content (datasets and config) is encrypted with
  AES-256-GCM using a 256-bit data key protected by Windows through `safeStorage`. If the key is
  missing, the old database is renamed, never deleted.
- Jira text is untrusted data: always escaped, never interpreted as HTML or instructions.

## Metrics

All metrics are pure functions over flat rows, tested with `node --test`.

| # | Metric | Priority |
|---|---|---|
| M1 | Progress by project and epic (done / total, in the project's measure) | P0 |
| M2 | Distribution by status | P0 |
| M3 | Work in progress | P0 |
| M4 | Load per person (capacity view, alphabetical, no ranking) | P0 |
| M5 | Stale work (open and more than N business days in the same status, default 5) | P0 |
| M6 | Weekly throughput (last 8 ISO weeks) | P0 |
| F1 / F2 | Outside the team: unassigned / assigned to other people | P0 |
| M7–M10, F3 | Cycle time, WIP aging, overdue, epic burn-up, closed by others | P1 |

When data is missing (no measure values, no history, no due dates), the card says so instead of
showing a misleading `0`. **No rankings or comparisons between people.**

## Reports

- **Sprint report (internal):** progress, closed in the period, in progress, stale work,
  visible blockers, load per person.
- **Client report (external):** progress, deliverables closed in the period, next steps. No
  people names (enforced by an automated test), no internal details.
- Preview in the app, copy to clipboard, or save as Markdown.
- **Optional AI drafting** (off by default): only the aggregated metrics are sent, through the
  proxy. The model only writes prose; numbers are checked against the template by a pure function.

## Design

The UI follows the **Flock Design System v1.1**: documented tokens only (as CSS variables),
system fonts (no web fonts, matching the CSP), base-4 spacing, the dark brand sidebar,
monospaced tabular numbers for KPIs and dense tables, and status colors shared by badges and
charts. The UI copy is in Spanish (es-AR); code identifiers are in English.

## Delivery plan

**Flow 1 — Technical foundation (≈ 1 h 15)**
Electron shell, in-process proxy with session secret, `safeStorage` secrets, encrypted cache,
Jira client and projection, demo mode with anonymized fixtures, scope validator, and a
diagnostics page that shows the rows of a test epic.

**Flow 2 — Business features (≈ 5 h)**

| Phase | Scope |
|---|---|
| A | Design system base, Jira connection wizard, teams, members, projects, epics |
| B | `projectIssues` datasets, sync of all active projects with progress |
| C | Work units, team scope, metrics M1–M6 and F1–F2, dashboard, drill-down |
| D | Sprint and client reports |
| E | Wrap-up: final README, demo fixtures, screenshots |

**If time allows:** AI drafting, P1 metrics, dark mode, epic search by text, config
export/import, packaging with `electron-builder`.

## Evolution (not in scope for the event)

- MCP queries to Jira and Flocktools from inside the app.
- Sprints through the Jira Agile API.
- Holidays in business-day calculations.
- Full tooling: Biome, Prettier, husky, lint-staged, CI, coverage thresholds.
- Extract the shared pieces into a package reused by related tools.

## Repository layout (target)

```
electron/   main process, preload, secrets
proxy/      http server, routes, Jira client, cache, config
shared/     cache keys, contracts, pure domain functions
src/        Angular app (core store, lazy pages, Flock design tokens)
fixtures/   anonymized Jira responses for demo mode and tests
tools/      validate-scope.mjs (client predicate vs JQL, compared by key sets)
test/       node --test suites
docs/       decisions and audits
```

## Getting started

Installation, Atlassian API token setup (read-only permissions recommended), usage, and
recovery steps will be documented here as the implementation lands.
