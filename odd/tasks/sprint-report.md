# Feature: sprint-report (layered sprint close report)

Status: CLOSED 2026-10-09 (pending the user's check against the real instance). Branch: `main`, one commit per task, pushed.

Goal: a "Sprint close" report like the reference HTML the user shared (a team's sprint close: work with real status
movement in the period, split by layer — Frontend, Backend, functional follow-up — and by issue level, grouped by
epic, with KPIs and Jira hygiene notes), exported as a styled HTML file.

## Gap analysis (from the reference report)

| Report element | Today |
|---|---|
| Primary / secondary (story vs subtask), several projects, grouping by epic | Exists (work units, projects, epics) |
| Real status names in chips colored by category | Exists |
| KPIs: items with movement, primary/secondary, closed, blocked | Easy on top of units |
| "Real status movement in the period" | Only the last status change is kept; needs the transition history per issue |
| Layers (FE / BE / functional) | Missing: a layer per team member, maybe a subtask-type -> layer map |
| "ref." primary of the other layer shown for context, not counted twice | Follows from the layer rule |
| Jira hygiene notes (parent open with all subtasks closed, subtask in progress under a closed parent) | Deterministic rules, to add |
| Items outside the team's epics | Out of scope today (scope is per epic) |
| Headlines and "Lectura del sprint" narrative | Narrative: optional AI drafting (plan §8.2), never computing figures |
| Styled HTML output | Reports are Markdown; the bridge saves only `.md` — needs `saveHtml` with validation in main |

## Decisions (user, 2026-10-09)

- Layers come ONLY from Jira COMPONENTS (user decision after the kickoff verification): per Jira project, the user
  picks from the component list Jira returns which components map to Frontend, Backend or Funcional (stored by Jira
  project key + component id). An issue without a mapped component goes to a "Sin capa" section. A primary without
  its own mapped component is still shown as context ("ref.", not counted) above its subtasks in their layers.
  An issue mapped to two layers is listed in each and flagged as a hygiene note.
- Period: a free date range the user picks (no Jira sprints).
- Work of team members outside the team's epics goes to a SEPARATE section, for tracking.
- HTML export: add a `saveHtml` bridge function (validated in main, `.html` only).
- AI narrative (headlines, sprint reading): only available when the AI key is stored (and AI is enabled in
  settings); the model only drafts, figures come from the deterministic model and are checked.

- Report figures (user, 2026-10-09): an item "has movement" when it has at least one status transition inside
  [start, end] (inclusive days); "closed" = its last transition into a Done-category status (status overrides
  applied) falls inside the period; "blocked" = its current status is in a CONFIGURABLE list of blocked statuses.

## Draft tasks (deterministic first)

- [x] 1. `IssueRow` gets `statusChanges` (transition history from the changelog) and `components` (`{ id, name }[]`):
      search fields, projection, payload version bump, demo fixtures, tests.
- [x] 2. Component -> layer mapping: read-only `GET /api/jira/projects/:key/components` route, mapping per Jira
      project key + component id in the config (`normalizeConfig`, `validateConfig`), picker screen.
- [x] 3. Outside-the-epics dataset: read-only query for the team members' issues with movement in the period that
      are not under the team's epics (separate section). Design: source `memberIssues`, scope = team
      (`{ type: 'team', id }`), required `since=YYYY-MM-DD`; JQL `assignee in (<active member ids>) AND updated >=
      "<since>"` with changelog; epic resolved from the parent (subtasks via their parent, missing parents fetched
      with a batched `key in (...)`); the dataset is ALL member work, the report model (task 4) leaves out the team's
      active epics like `scope.mjs`; one shard, delta + degradation like `projectIssues`; demo answers the new JQL.
- [x] 4. Pure report model: movement in the period, layer -> epic -> primary with its subtasks, "ref." rows, KPIs,
      hygiene notes, outside-epics section (test-first).
- [x] 4b. Blocked statuses: `jira.blockedStatusIds` in the config (normalize, validate, does not move cache keys) and
      a picker in Conexión -> Particularidades.
- [x] 5a. Pure HTML renderer (`renderSprintCloseHtml`, Flock tokens, escaped, no scripts) + `saveHtml` bridge
      (validated in main, `.html` only).
- [x] 5b. Report UI: date-range picker, hydrate `memberIssues` + team datasets + statuses, preview, export.
- [x] 6a. Demo coverage: components mapped to layers, blocked statuses, hygiene cases (parallel with task 7).
- [ ] 6b. Close: merge task 7, docs, README, decisions, final demo smoke.
- [x] 7. AI-drafted headlines and sprint reading, enabled only with a stored AI key, with the figures check of
      plan §8.2.

## Evidence
- Kickoff verification (read-only, real instance, user go-ahead "arranquemos"; scripts in `%TEMP%lock-verify`,
  outside the repo, credentials never printed):
  - `GET /rest/api/3/project/{key}/components` -> 200, a plain array (not paginated) of
    `{ self, id, name, assigneeType, realAssigneeType, isAssigneeTypeValid, project, projectId }`; two team projects
    returned 47 and 45 components.
  - Issue field `components` (via `/rest/api/3/search/jql?fields=components`) -> array of `{ self, id, name }`;
    issues often carry SEVERAL components.
  - Development subtasks (type "Subtarea") carry a layer component (`FRONTEND`/`BACKEND` in one project,
    `Frontend`/`Backend` in the other: names differ per project -> map by Jira project + component id).
  - "Analisis" subtasks have no components; primaries (Historia, Mejora, Error) usually carry only an area component.
    In the user's reference report those rows sit in a layer by their ASSIGNEE (e.g. "Primaria asignada a FE").
  - Consequence: components alone cannot place primaries, analysis subtasks or functional follow-up; a fallback
    by assignee was offered; the user chose components only, with a "Sin capa" section.
- Task 1 (worker, test-first): `IssueRow.statusChanges` (`{ at, fromStatusId, toStatusId }[]`, oldest first, from the
  same changelog walk as `statusSince`/`firstDoingAt`/`doneAt`) and `IssueRow.components` (`{ id, name }[]`, Jira
  order); `components` added to the search fields; `PAYLOAD_VERSION` 1 -> 2 (cached datasets reload fully).
  Demo: fictional components 20001 FRONTEND, 20002 BACKEND, 20003 Onboarding, 20004 Reporting on project DEMO;
  demo-fetch serves `GET /rest/api/3/project/DEMO/components`. RED observed for the projection tests (`undefined`
  fields). node 474/474, Karma 169/169, `build:desktop` OK. `validate-scope` not re-run (projection shape only grew).
  Commit: `feat(jira): project status history and components into issue rows`.
- Task 2 (worker + parent): `jira.componentLayers` (`{ projectKey, componentId, componentName, layer }[]`, normalize +
  validate codes, does not move cache keys), `setComponentLayer` op, `componentLayerRows` view, client
  `projectComponents` (metadata-cached), route `GET /api/jira/projects/:key/components` (400 on invalid key, works in
  demo), "Capas por componente" section in Conexión -> Particularidades (components loaded on demand, each select saves
  at once). Parent fix: saving a layer reloaded the config and wiped unsaved status-mapping edits; the overrides draft
  now resets only when the saved overrides change by content (RED observed, then GREEN). `docs/plan.md` §2.1 and
  `docs/architecture.md` updated. RED observed for the node tests. Two verifier runs failed with an internal subagent
  error; suites run by the parent: node 488/488, Karma 175/175, `build:desktop` OK.
  Commit: `feat(config): map Jira components to report layers`.
- Task 3 (parent, inline: every subagent run, even a one-word probe, failed with "assistant reported an error" and
  0 tool calls): source `memberIssues` = `proxy/jira/member-issues.mjs` (`fetchMemberIssues`, batches of 50 ids,
  parent lookup with `key in`), `refreshMemberIssues` + `readMembers`/`refreshMembers` in `proxy/jira/refresh.mjs`
  (one `members` shard), `memberIssuesParams` in `shared/cache-key.mjs`, `isIsoDate` in `shared/contracts.mjs`, routes
  with required `since`. Demo: parser accepts `assignee in`, `updated >= "YYYY-MM-DD"`, `key in`; new fictional
  DEMO-25 (unconfigured epic) with DEMO-26 (non-member parent), DEMO-27 (member subtask, needs the parent lookup) and
  DEMO-28 (no epic). Docs: `docs/architecture.md` §7, `docs/plan.md` §2.3. RED observed (missing module, route 400s,
  demo clauses). node 503/503, `build:desktop` OK; Karma not run (no front change).
  Membership is by CURRENT assignee (an issue reassigned away from a member is not in the dataset).
  Commit: `feat(jira): add the memberIssues dataset for the sprint report` (3cf0c5e).
- Task 4 (parent, inline, same subagent incident): `shared/domain/sprint-close.mjs` `buildSprintClose({ teamId, config,
  period, timeZone, statuses, blockedStatusIds, epicRows, memberRows })` -> `{ period, kpis, layers, outside, hygiene }`.
  Transition categories from the `/api/jira/statuses` catalog with the overrides applied; layers via
  `layersOf(row, componentLayers)`; in-epic scope = the team's active epics, ALL assignees (the team's epics are the
  team's work); outside = member rows with movement whose epic is not a team active epic, grouped by epic, no layers,
  unknown parents shown as a ref. without item. Hygiene: `multiple_layers`, `parent_open_all_subtasks_done`,
  `subtask_open_under_done_parent` (over the items the report shows). RED observed (missing module); 11 tests,
  node 514/514. Demo end-to-end check (script in %TEMP%/flock-verify, outside the repo): 16 moved items, FE 2, BE 2,
  Sin capa 12, outside DEMO-25 (DEMO-26 ref + DEMO-27) and DEMO-28; no hygiene notes in the demo yet (task 6).
  Commit: `feat(domain): build the layered sprint close model`.
- Task 4b (worker; subagents worked again): `jira.blockedStatusIds` (normalize: trimmed, deduped, ordered; validate
  `BLOCKED_STATUS_INVALID`; no cache key move), `setBlockedStatus` op, "Estados bloqueados" checkboxes in Conexión ->
  Particularidades (saves on toggle, unsaved status-mapping edits survive via the task 2 fix). RED observed for node
  (Karma spec written with the code, no RED). node 519/519, Karma 178/178, `build:desktop` OK.
  Commit: `feat(config): configure blocked statuses for the sprint report`.
- Task 5a (worker): `shared/domain/sprint-close-html.mjs` `renderSprintCloseHtml(report, { title, teamName,
  generatedAt, timeZone, jiraBaseUrl })`: standalone document, inline CSS with Flock tokens, `@media print`, no
  `<script>`, everything escaped, issue links only with an https origin (`/browse/<KEY>`). `saveHtml` bridge mirrors
  `saveMarkdown` (5 MB, `.html` filter, main rejects any other extension with `INVALID_PATH`). The reference report
  was not read; no real data in the repo. RED observed for the renderer (bridge tests written after the code).
  node 547/547, Karma 178/178, `build:desktop` OK.
  Commit: `feat(reports): render the sprint close as standalone HTML`.
- Task 5b (worker): page "Cierre de sprint" (`/sprint-close`, nav after Dashboard; user chose a page over the reports
  modal). Own team select (there is no shared sidebar team selection; first active team by default), Desde/Hasta
  (default last 14 days, browser time zone like the dashboard), KPIs, dataset warnings, statuses catalog (failure
  tolerated), no-layer-mapping hint, preview = sandboxed `<iframe sandbox="" srcdoc>` of the exact exported HTML,
  "Exportar HTML" via `saveHtml`. Store: `memberIssues` source keyed by `since`, `refreshProjectIssues`.
  Demo smoke (verifier, CDP, screenshots in %TEMP%/flock-smoke): after a full sync 14 moved items (10/4, 6 closed),
  2 outside (DEMO-25), preview OK, invalid range message OK, 0 console errors. BUG found: project rows cached
  before 737ab11 lack `statusChanges`/`components` -> `buildSprintClose` threw and the page was blank, and
  "Actualizar datos" only refreshed member rows. Fix: the model tolerates missing arrays, "Actualizar datos" also
  refreshes the team's projects (the proxy upgrades the payload-version mismatch to a full load) and a warning
  asks to refresh when legacy rows are present. RED observed (domain TypeError; store compile error). node
  548/548, Karma 194/194, `build:desktop` OK. Not smoked: saving the exported file, switching teams.
  Commit: `feat(reports): add the sprint close page`.
- Tasks 6a and 7 ran in PARALLEL (user approval): task 7 in the linked worktree `../flock-ai-day-ai` (branch
  `feat/sprint-close-ai`), task 6a on main; disjoint edit surfaces, docs deferred to 6b.
- Task 6a (worker): demo config maps 20001 FRONTEND -> frontend, 20002 BACKEND -> backend, new 20005 QA ->
  functional; `blockedStatusIds: ['5']`. Existing rows adjusted (no new rows): DEMO-4/13 (open subtask under a done
  parent), DEMO-6/11/12 (open parent with all subtasks done), DEMO-15/19/20 (counted backend primary + ref. in
  frontend), DEMO-18 (two layers), DEMO-7/17 (functional), DEMO-10 (blocked with movement). New
  `test/demo-sprint-close.test.mjs` runs the real client over the demo fetch -> `buildSprintClose` ->
  `renderSprintCloseHtml`. RED observed (no layers). node 550/550.
  Commit: `test(demo): cover every sprint close feature in the demo`.
- Task 7 (worker, worktree `feat/sprint-close-ai`, commit baaef71, merged into main with `--no-ff` 6bd5a54):
  `shared/domain/ai-narrative.mjs` (`narrativeInput` without people, `checkNarrativeFigures`, `parseNarrative`),
  `proxy/ai/{prompt,anthropic,demo-narrative}.mjs`, `POST /api/reports/ai` (AI enabled + key stored; Anthropic
  `/v1/messages`, model `claude-sonnet-4-5`; stable error codes; key never echoed), egress to `api.anthropic.com` only
  while AI is enabled, demo canned narrative wired in `electron/main.cjs` (dummy key only under `--demo`), page
  "Redactar con IA" with confirmation, editable result, figures warning; narrative block in the exported HTML.
  RED partly reconstructed (renderer block, egress); domain/route/Karma tests written after the code.
  Branch: node 570, Karma 199, build OK. After the merge on main: node 572/572.
