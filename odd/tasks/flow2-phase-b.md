# Feature: flow2-phase-b (business datasets)

Goal: close flow 2, phase B of `docs/plan.md` §9 — `projectIssues` per project (active epics -> children ->
subtasks, project measurement fields, `IssueRow` projection), refresh of the sync-maintained fields (members and
epic data, `architecture.md` §6.7), and `POST /api/sync` over all active projects with progress.

Source of truth: `docs/plan.md` §9 and `docs/architecture.md`.
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: real Jira is reached only read-only by `tools/validate-scope.mjs`, with the user's go-ahead
("continuá con el cierre de la phase B"); the app database is opened read-only to read plaintext metadata
(`fetched_at`, `full_fetched_at`, `shards_meta`), never payloads.

Exit criteria (plan §9 phase B): `validate-scope.mjs` matches the equivalent JQL by key set for a real project, and a
second refresh uses delta.

## Tasks

- [x] 1. Scope audit — every phase B bullet already exists from flow 1 (tasks 5b and 7e); no code to write.
- [x] 2. `validate-scope` against the real project — all four active epics, predicates `open` and `all`.
- [x] 3. Second refresh uses delta — the user runs "Sincronizar ahora" (delta) once more; read the dataset metadata before and after.
- [x] 4. Phase B close — `docs/decisions.md` entry, evidence here, commit and push.

## Evidence

- Task 1: `projectIssues` source, hierarchy by `epicLinkMode`, measurement fields and `IssueRow` projection, delta/full
  refresh with per-epic windows (flow 1 task 5b, `docs/decisions.md` "Task 5b hierarchy/refresh/dataset routes");
  sync of members and epic summaries/link method plus `POST /api/sync` and `GET /api/sync/status` (flow 1 task 7e);
  sync screen with progress (flow 2 phase A task 7). Live state before task 2: the real project
  (`<project id>`, epics `ABC-101`, `ABC-102`, `ABC-103`, `ABC-104`) has one `projectIssues` entry, all four
  shards `ok`, `fetched_at == full_fetched_at == 2026-10-09T18:02:53.265Z` — only the first (full) load so far.
- Task 2 (live, read-only, shell `JIRA_*`): `node tools/validate-scope.mjs --epic ABC-101 --epic ABC-102
  --epic ABC-103 --epic ABC-104` — `open`: 248/248 common, `onlyPredicate=0 onlyJql=0`, exit 0; `all`: 912/912
  common, `onlyPredicate=0 onlyJql=0`, exit 0. Exit criterion 1 met (four epics, children and subtasks).
- Task 3 (live, user ran "Sincronizar ahora" in the real app): the same entry now has `fetched_at =
  2026-10-09T18:11:45.107Z` while `full_fetched_at` stays `2026-10-09T18:02:53.265Z`; all four shards `ok` with
  `lastOkAt` at the new run, `is_current = 1`; `app_config.updated_at` moved to 18:11:47 (sync merge saved). A full
  load advances `full_fetched_at`, so the second refresh was a delta. Exit criterion 2 met.
- Task 4: `docs/decisions.md` entry "Flow 2 phase B close". No code changed since phase A close (`0c3a70f`: node
  430/430, Karma 123/123, `build:desktop` OK), so suites were not re-run. Commit: see git log `docs: close flow 2 phase B`.
