# Feature: flow2-phase-d (reports)

Goal: close flow 2, phase D of `docs/plan.md` §9 — deterministic sprint and client reports (plan §8.1): Markdown
templates over a date range (default: last 2 weeks), preview in the app, copy to the clipboard (`copyText`) and save
as `.md` (`saveMarkdown`) through the existing preload bridge.

Source of truth: `docs/plan.md` §8.1, §9 (private, local only) and `docs/architecture.md` §4.1, §9.
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: run node/npm/electron with every `JIRA_*` var unset; reports never reach Jira or the AI provider (AI drafting
is plan §8.2, out of scope).

Exit criteria (plan §9 phase D): the client report contains no person name (automated test) and its figures match
the dashboard.

## Design (fixed before code)

- Pure `shared/domain/reports.mjs`, built from the same scoped units and metric functions as the dashboard, so the
  figures cannot drift. `now`, `timeZone` and the period (`from`/`to` calendar dates, inclusive) are parameters.
- "Closed in the period" = local calendar date of the effective `doneAt` within the period (architecture §9).
- Report scope = the current dashboard selection (team, and project/epic filter when set) — simplest option,
  plan §10.7.
- Sprint (internal): progress per project and epic, closed in the period, in progress, stale, visible blockers
  (stale + unassigned open), load per person.
- Client (external): progress per project and epic, deliverables closed in the period, next steps (in progress).
  No person names, no "Fuera del equipo", no stale or internal details.
- Measurement groups stay separate (unit type + measure), as in the dashboard.

## Tasks

- [x] 1. Reports domain — test-first: period helpers, sprint and client Markdown, no-names test, figures equal M1.
- [ ] 2. Reports UI — dashboard buttons, date range (default last 2 weeks), preview, copy and save via the bridge.
- [ ] 3. Phase close — suites, build, demo smoke, `docs/decisions.md` entry, live check by the user.

## Evidence
- Task 1 (worker, test-first): `shared/domain/reports.mjs` — `defaultPeriod`, `closedInPeriod` (local calendar
  date of `doneAt`), `buildSprintReport`, `buildClientReport` (groups as `measurementGroups` returns them plus
  `unassignedOpen`). `test/domain-reports.test.mjs` 10/10, RED observed (module missing); node 467/467. Client
  no-names test (exit criterion): distinctive member/assignee names and accountIds, unassigned data, status names and
  stale units never appear in the client Markdown. Printed figures equal `progress()`. Issue text escaped as data.
  Measure wording duplicated from `src/app/shared/ui/measure-format.ts` (to unify in task 2).
  Commit: `feat(domain): add sprint and client reports`.
