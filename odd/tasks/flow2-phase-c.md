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
- [x] 4. Dashboard data — store loads `projectIssues` for the team's active projects; team -> project -> epic view state; route and nav.
- [x] 5. Dashboard UI — header, M1–M6 cards/charts with system status colors, drill-down lists with `openInJira`, tasks-without-subtasks notice.
- [x] 6. "Fuera del equipo" — F1–F2 with the same filters, header counter, "Agregar al equipo" opening the preloaded member search.
- [ ] 7. Phase close — suites, build, demo smoke, `docs/decisions.md` entry, live checklist (hand-verify one epic against Jira).

## Live checklist (user, against the real instance)

1. Sync first ("Sincronización" -> "Sincronizar ahora"), then open "Panel" -> "Dashboard".
2. Pick the real team and one epic. Hand-verify against Jira (same epic): total tasks, done tasks, and the measure
   sum (M1); count per status (M2); "En curso" (M3). Only issues assigned to active team members count.
3. Click several numbers (KPI, progress, a status segment, a person's load, a week bar): each opens its list, and a
   key opens the issue in Jira.
4. "Fuera del equipo": unassigned and other people's open work appear there and NOT in the "Equipo" view.
5. "Agregar al equipo" on a person: the search opens preloaded; adding moves their work into the team view.
6. If a project measures subtasks: the "N tareas no tienen subtareas" notice and its list.
7. Status/chart colors (todo grey, doing purple, done green) in dark and light mode.

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
- Task 4 (worker): store `ensureProjectIssues(projectId)` / `projectIssues(projectId)` (reads the proxy's dataset,
  never syncs); `src/app/pages/dashboard/dashboard.state.ts` (linkedSignal team -> project -> epic, units, scoped,
  outside, `outsideOpenCount`, metric `groups`, `dataAsOf` / `missingDatasets` / `notCurrent`); `/dashboard` route and
  nav section "Panel". Karma 136/136, node 457/457, `build:desktop` OK. RED not observed (first visible run was
  already green after a truncated heredoc run); no mutation check. The `''` redirect stays on `connection` (no
  "configured" notion). Pending for task 5: scope `tasksWithoutSubtasks` to the team.
  Commit: `feat(dashboard): add dashboard data and view state`.
- Task 5 (worker + parent): `dashboard-group` (one section per measurement group: KPIs M3/M5, M1 progress per
  project/epic, M2 stacked status bars, M3 per member, M4 load bars, M5 table, M6 weekly bars, tasks-without-subtasks
  notice), reusable `shared/ui/unit-list-modal` drill-down (key opens Jira via `openInJira`), `measure-format`
  (hours for `time_seconds`), state `tasksWithoutSubtasksScoped` and per-group lists. Status colors: todo
  `--state-pending-*`, doing `--state-progress-*`, done `--state-done-*`. Parent review: exported `measureKeyOf`
  from `metrics.mjs` instead of a duplicate in the state. Verify (gentle-ai-verify): node 457/457, Karma 150/150,
  `build:desktop` OK, no warnings. Specs were written after the code (no RED). Demo dark screenshot by the worker:
  one group renders correctly; two side-by-side groups and the todo grey were not seen rendered.
  Commit: `feat(dashboard): add metrics UI with drill-down`.
- Task 6 (worker): in-page view switch "Equipo" | "Fuera del equipo (N)" (header counter switches too; same
  selection, no refetch); `dashboard-outside` with F1 "Sin asignar" and F2 "Asignado a otras personas" per
  measurement group (state `outsideGroups`); "Agregar al equipo" = `add-member-modal` wrapping the team
  `MemberSearch` with a new `initialQuery` input; shared `addJiraUser` op now used by the team screen too (member data
  always from Jira's result); inactive members get "Reactivar" (`setMemberActive`). Karma 157/157 (7 new, RED observed
  7/7 before the code), node 457/457, `build:desktop` OK. Outside-only Karma spec: unassigned and other-person units
  absent from `groups()` and shown only in the outside view. No screenshot taken.
  Commit: `feat(dashboard): add outside-the-team view with add to team`.
- Task 7 (in progress): demo smoke in Electron via CDP (`electron . --demo --remote-debugging-port=9333`, scripts
  outside the repo): dashboard dark/light, outside view, drill-down modal; no console errors. "Agregar al equipo" not
  reachable in demo (no outside person in the fixtures). Fixes from the screenshots: `.num-link.missing` moved to the
  global styles (the outside view lacked the warning color) and the header counter uses `btn-ghost btn-small`
  (commit `fix(dashboard): style missing-measure counters and outside counter`). Verify after the fix: node 457/457,
  Karma 157/157, `build:desktop` OK, computed styles checked. `docs/decisions.md` entries "Flow 2 phase C domain" and
  "Flow 2 phase C UI". Pending: the user's live checklist (hand-verify one epic against Jira).
