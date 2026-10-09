# Feature: flow2-phase-e (close)

Goal: close flow 2, phase E of `docs/plan.md` §9 — README (installation, Atlassian API token, recommended read-only
permissions, usage, architecture summary, database security and recovery, decisions, limitations and evolution),
anonymized fixtures for `--demo` that show every screen, and screenshots for the demo.

Source of truth: `docs/plan.md` §9 and `docs/architecture.md`.
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: every command with all `JIRA_*` vars unset; never list environment variables; demo never reaches Jira.

## Decisions

- `docs/architecture.md` and `docs/plan.md` get public versions without any reference to the read-only reference
  project (its name, its path, comparisons with it); the originals move to `docs/private/` (gitignored). Every other
  mention is removed from tracked files and the reference audit is retired from the repo (kept in `docs/private/`). Client data (site name, epic keys) stays as is (user decision).
  Git history still contains the old text; rewriting history is not planned. The README links to the public
  `architecture.md` and `decisions.md`.
- Demo fixtures stay hand-written and fictional (flow 1); they are extended, not re-recorded.
- The "Algunos datos no están al día" notice in demo is by design: epic `DEMO-3` fails on purpose to show the
  stale-not-empty degradation. The README says so.

## Tasks

- [x] 1. Demo fixtures — a fictional non-member with open work (F2, "Agregar al equipo" searchable in demo), a To Do
      unit assigned to a member (todo segment), tests and fixture lint green.
- [x] 1b. Public docs — sanitized `docs/architecture.md` and `docs/plan.md` tracked; originals and the
      reference audit in `docs/private/`; no reference-project mention left in tracked files.
- [x] 1c. Dashboard refresh after sync — the dashboard must show new data after a sync without a reload.
- [x] 2. Screenshots — demo mode, dark and light, into `docs/screenshots/` (dashboard, outside view, drill-down,
      report, teams, sync).
- [x] 3. README — rewrite per plan §9 phase E, with the screenshots.
- [x] 4. Phase and flow 2 close — suites, build, `docs/decisions.md` entry.

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
- Task 1b (worker + parent review): private originals copied to `docs/private/` (SHA-256 identical), `.gitignore`
  now ignores `docs/private/` instead of the two docs; `docs/architecture.md` and `docs/plan.md` rewritten to stand
  alone (decisions justified on their own; flow 1 estimate restated as 2 h 30 to 3 h); `docs/decisions.md` sections
  1, 3, 4 and log rows reworded; `odd/tasks/foundation.md` neutralized; reference audit removed from the repo.
  Parent checks: no tokens, emails, local paths or reference-project names in the public docs; "(private, local
  only)" notes removed from the phase task docs. Git history still holds the old text (no rewrite, user informed).
  Commit: `docs: publish architecture and plan without reference-project details`.
- Task 2 (worker): 8 PNGs in `docs/screenshots/` from demo mode only (dashboard dark 1440x1800 and light, outside,
  drill-down, client report, team, sync, connection), 80–168 KB each. Demo DB refreshed with "Carga completa"; the
  dashboard picked up the new fixtures without a reload (confirms task 1c in the real app). Privacy: worker and
  parent checked the images — only demo names, `DEMO-*` keys, `example.com` emails and `demo.example.atlassian.net`;
  the token field is empty. No console errors. Commit: `docs: add demo screenshots`.
- Task 3 (worker + parent review): `README.md` rewritten for the delivered app (pitch + hero screenshot, features and
  gallery, getting started with the real scripts and demo mode, Atlassian API token and read-only permissions, usage,
  architecture summary linking `docs/architecture.md`, database security and recovery, decisions, limitations,
  evolution incl. the planned layered sprint report, layout, testing). Parent fixes: removed an unverifiable claim
  about Electron's embedded Node; "Integrantes" marked as a team tab. All relative links resolve; no client data.
  Commit: `docs: rewrite README for the delivered app`.
- Task 4: no code changed since `b1d854a` (last verified: node 468/468, Karma 169/169, `build:desktop` OK), so the
  suites were not re-run. `docs/decisions.md` entry "Flow 2 phase E close". Flow 2 (phases A–E) closed.
  Commit: `docs: close flow 2`.
