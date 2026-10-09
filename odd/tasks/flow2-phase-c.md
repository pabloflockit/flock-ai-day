# Feature: flow2-phase-c (dashboard and "Fuera del equipo")

Goal: close flow 2, phase C of `docs/plan.md` §9 — `work-units`, `teamScope`/`teamOutside`, metrics M1–M6 and
F1–F2 as pure functions with tests, the team dashboard UI with drill-down, the notice for tasks without subtasks,
and the "Fuera del equipo" screen with "Agregar al equipo".

Source of truth: `docs/plan.md` §3, §4, §6.2, §6.3, §7, §9 (private, local only) and `docs/architecture.md`.
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: run node/npm/electron with `env -u JIRA_*`; real Jira only read-only and with the user's go-ahead.

Exit criteria (plan §9 phase C): figures hand-verified against Jira for one epic; every number opens its list;
work not assigned to the team appears only in its own section; statuses and charts use the system status colors.

## Design (fixed before code)

- `businessDaysBetween` already exists (`shared/domain/business-days.mjs`, flow 1) — reused, not rewritten.
- `shared/domain/work-units.mjs`: `buildWorkUnits(rows, project, config)` -> `{ units, tasksWithoutSubtasks }`.
  Unit type `task` = `!isSubtask && (hierarchyLevel ?? 0) === 0`; `subtask` = `isSubtask`. `both` emits both sets,
  never summed. Unit carries effective status category (overrides applied) and effective `doneAt`.
  `measureValue`: count -> 1; field -> `measures[fieldId]` (`null` kept as missing, `0` valid);
  `time_seconds` -> hours. Implementation order: task+count -> field measure -> subtask -> both.
- `shared/domain/scope.mjs`: `teamScope(units, team, config)` and `teamOutside(...)` -> `{ unassigned, others }`
  (plan §4): active epic, active project of the team; in scope only when the assignee is an active member.
- `shared/domain/metrics.mjs`: M1 progress (project = sum of its active epics' units), M2 status distribution,
  M3 WIP, M4 load per member (alphabetical, no ranking), M5 stale, M6 ISO-week throughput (last 8 weeks),
  F1 unassigned open, F2 open assigned to others grouped by person. `now` and `timeZone` are parameters.
  Missing data is reported, never a misleading 0.

## Tasks

- [x] 1. `work-units` domain — test-first, the four measurement steps in plan order.
- [x] 2. `teamScope` / `teamOutside` domain — test-first.
- [x] 3. Metrics M1–M6 and F1–F2 domain — test-first.
- [ ] 4. Dashboard data — store loads `projectIssues` for the team's active projects; team -> project -> epic view state; route and nav.
- [ ] 5. Dashboard UI — header, M1–M6 cards/charts with system status colors, drill-down lists with `openInJira`, tasks-without-subtasks notice.
- [ ] 6. "Fuera del equipo" — F1–F2 with the same filters, header counter, "Agregar al equipo" opening the preloaded member search.
- [ ] 7. Phase close — suites, build, demo smoke, `docs/decisions.md` entry, live checklist (hand-verify one epic against Jira).

## Evidence

- Task 1 (worker, test-first): `shared/domain/work-units.mjs` `buildWorkUnits(rows, project, config)` ->
  `{ units, tasksWithoutSubtasks }`; `test/domain-work-units.test.mjs` 11/11; node suite 441/441. RED observed for
  step 1 (module missing) and steps 3–4 (3 failing subtask/both tests); step 2 had no genuine RED (helper written
  early) — mutation check (forced `measureValue = 1`) made 2 tests fail. Commit: `feat(domain): add work units`.
- Task 2 (worker, test-first): `shared/domain/scope.mjs` `teamScope` / `teamOutside`; `test/domain-scope.test.mjs`
  5/5, RED observed (module missing). Covers a member in two teams and inactive members going to `others`.
  Commit: `feat(domain): add team scope and outside`.
- Task 3 (worker, test-first): `shared/domain/metrics.mjs` (`aggregate`, `measurementGroups`, M1 `progress`,
  M2 `statusDistribution`, M3 `workInProgress`, M4 `loadByMember`, M5 `staleUnits`, M6 `weeklyThroughput` with
  `hasDoneData`, F1 `unassignedOpen`, F2 `othersOpenByPerson`); `test/domain-metrics.test.mjs` 11/11, RED observed;
  node suite 457/457. Decisions: `progress` sums the units it receives (scope filtering is `teamScope`'s job) and
  lists only active epics with units; buckets are `{ count, measure, missingMeasure, units }` for drill-down.
  Commit: `feat(domain): add dashboard metrics`.
