# Feature: flow2-phase-a (visual base, connection and administration)

Goal: flow 2, phase A of `docs/plan.md` §9 — Flock Design System base, app shell, connection wizard,
and the administration screens (teams, members, projects with measurement, epics) over the flow 1 proxy.

Source of truth: `docs/plan.md` §2, §5, §6.1, §9 (private, local only) and `docs/architecture.md`.
UI rule: only the `flock-design-system` skill (tokens via CSS variables, system fonts, base-4 spacing,
components/patterns from `references/design-system.md`; no hex, no external component/icon libraries).
Branch: `main` (user decision: one Conventional Commit per task, pushed right away).
Safety: never reach real Jira from tools or tests; run child processes with
`env -u JIRA_BASE_URL -u JIRA_EMAIL -u JIRA_API_TOKEN -u JIRA_URL -u JIRA_USERNAME`; live checks are the user's.

Exit criteria (plan §9 phase A): the app uses only system tokens; against the real instance a team is created with
two members searched in Jira and a project with two validated epics and configured measurement; it persists after
restart; adding an epic already owned by another project offers to move it.

## Tasks

- [x] 1. Design system base — copy `tokens.css` and logos into `src/styles/flock/`, `references/design-system.md` into `docs/design/`; tokens in `:root`, system font, base styles, `.text-mono`; restyle the diagnostics page with tokens only.
- [ ] 2. App shell and base components — dark brand sidebar (`--nav-gradient`, white mark) with admin navigation and routes; line icons (24 px grid, stroke 1.7, `currentColor`); button, field, card, table, tabs, modal/confirm, toast per reference §5/§6.
- [ ] 3. Integrity rules and config editing — audit `validateConfig` against plan §2.2 (unique team/project names, one epic per project, no duplicate member per team, delete guards, project reassignment) and add missing rules with tests; client config-editing service (load, mutate, save through `/api/config`, surface validation errors).
- [ ] 4. Connection wizard — first-run steps: URL "Verificar", email + token "Probar", particularities (epic link mode proposed in `auto`, status category overrides); later an editable screen where the token is only replaced; fix the flow 1 "save before test" UX carry-over.
- [ ] 5. Teams and members — team list with member/project/epic counts; create, edit, activate/deactivate, delete with guard; team detail with tabs Integrantes / Proyectos; member search against `/api/jira/users` (min 2 chars, ~300 ms debounce) with initials, name, email, other-team note and Jira-deactivated flag.
- [ ] 6. Projects and epics — create, edit, activate/deactivate, reassign team (confirm), delete with guard; measurement (unit task/subtask/both, measure count or numeric field from `/api/jira/fields`); epics by key validated via `/api/jira/epics/:key`, offer to move when owned elsewhere, activate/deactivate/move/remove, last sync, failure state and detected link method.
- [ ] 7. General settings and sync screen — stale/aging business days, status overrides, AI enable + write-only key (`PUT /api/ai/key`); sync now / full refresh, progress (`/api/sync/status`), failed epics and data date; diagnostics reachable from admin.
- [ ] 8. Phase A close — node + Karma suites, build, demo-mode smoke, `docs/decisions.md` entry, live checklist handed to the user.

## Evidence

(commit ids and check results recorded per task)

- Note: package subagents (gentle-ai-worker / gentle-ai-explore) fail at model level with 0 tool calls; tasks run inline (fallback).
- Task 1: RED `test/design-tokens.test.mjs` 2/4 failing (missing `tokens-app.css` triplets, tokens not imported) -> GREEN. `npm run test:node` 401/401, Karma 16/16, `ng build` OK. Decision: `src/styles/flock/tokens-app.css` names values the reference documents only as hex in comments/specs (state triplets, hovers, type scale, spacing, radii); `tokens.css` stays a verbatim skill copy. Logos served from `public/brand/`. Commit: see git log `feat(ui): add Flock Design System base`.
