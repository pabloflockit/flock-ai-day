# Feature: flow2-phase-e (close)

Goal: close flow 2, phase E of `docs/plan.md` §9 — README (installation, Atlassian API token, recommended read-only
permissions, usage, architecture summary, database security and recovery, decisions, limitations and evolution),
anonymized fixtures for `--demo` that show every screen, and screenshots for the demo.

Source of truth: `docs/plan.md` §9 and `docs/architecture.md` (both private, local only).
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: every command with all `JIRA_*` vars unset; never list environment variables; demo never reaches Jira.

## Decisions

- `docs/architecture.md` and `docs/plan.md` get public versions without any reference to the read-only reference
  project (the reference app, its path, "proyecto anterior" comparisons); the originals move to `docs/private/`
  (gitignored). Every other the reference app mention is removed from tracked files and `docs/reference-audit.md` is
  retired from the repo (kept in `docs/private/`). Client data (site name, epic keys) stays as is (user decision).
  Git history still contains the old text; rewriting history is not planned. The README links to the public
  `architecture.md` and `decisions.md`.
- Demo fixtures stay hand-written and fictional (flow 1); they are extended, not re-recorded.
- The "Algunos datos no están al día" notice in demo is by design: epic `DEMO-3` fails on purpose to show the
  stale-not-empty degradation. The README says so.

## Tasks

- [x] 1. Demo fixtures — a fictional non-member with open work (F2, "Agregar al equipo" searchable in demo), a To Do
      unit assigned to a member (todo segment), tests and fixture lint green.
- [ ] 1b. Public docs — sanitized `docs/architecture.md` and `docs/plan.md` tracked; originals and
      `reference-audit.md` in `docs/private/`; no the reference app / `repoFedPat` left in tracked files.
- [x] 1c. Dashboard refresh after sync — the dashboard must show new data after a sync without a reload.
- [ ] 2. Screenshots — demo mode, dark and light, into `docs/screenshots/` (dashboard, outside view, drill-down,
      report, teams, sync).
- [ ] 3. README — rewrite per plan §9 phase E, with the screenshots.
- [ ] 4. Phase and flow 2 close — suites, build, `docs/decisions.md` entry.

## Evidence
- Task 1 (worker): fictional "Carla Demo" (`demo-account-003`, not a team member, searchable, active) assigned
  DEMO-8 (To Do) and new DEMO-24 (In Progress, 3 SP, epic DEMO-2); DEMO-9 (To Do) assigned to Ben (todo segment);
  DEMO-13/DEMO-16 stay unassigned (F1). `users.json`: Carla active with `carla.demo@example.com`; new inactive
  `demo-account-005` "Dario Demo (inactive)" keeps the inactive-user case. New test in `test/demo-fetch.test.mjs`
  pins the demo coverage; no existing expectation changed. node 468/468, Karma 166/166, `build:desktop` OK. Smoke:
  todo/doing/done segments, Carla under "Asignado a otras personas", "Agregar al equipo" search preloaded and finds
  her. Finding: after "Carga completa" the dashboard showed the new data only after a page reload (bug, see task 1c).
  Commit: `test(demo): extend demo fixtures to cover every dashboard block`.
- Task 1c (worker, test-first): root cause in `AppStore` — `#hydratedKeys` never cleared after a sync, and the
  `ensureHydrated` guard dropped any read when rows existed. Fix: the guard now skips only reads that are not strictly
  newer (`isNewer` on `fetchedAt`); new `invalidateDatasets()` clears hydrated keys except refreshing ones (rows stay
  visible); `SyncPage` calls it when a run ends, next to `reloadConfig()`. RED observed for the two new behaviors
  (TS2339: `invalidateDatasets` missing); the "older read never overwrites a newer refresh" spec passed before and
  after (regression guard). Karma 169/169, node 468/468, `build:desktop` OK.
  Commit: `fix(store): re-read datasets after a sync run`.
