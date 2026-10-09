# Feature: sprint-report (layered sprint close report)

Status: PLANNED — starts after flow 2 phase E closes (user decision).

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

- Layers come from Jira COMPONENTS: per project, the user picks from the component list Jira returns which
  components map to Frontend, Backend or Funcional (VERIFY the components endpoint and the `components` issue field
  with a read-only call before coding; plan rule: never invent Jira endpoints or fields).
- Period: a free date range the user picks (no Jira sprints).
- Work of team members outside the team's epics goes to a SEPARATE section, for tracking.
- HTML export: add a `saveHtml` bridge function (validated in main, `.html` only).
- AI narrative (headlines, sprint reading): only available when the AI key is stored (and AI is enabled in
  settings); the model only drafts, figures come from the deterministic model and are checked.

## Draft tasks (deterministic first)

- [ ] 1. Status transition history in `IssueRow` (proxy projection from the changelog, payload version bump, tests).
- [ ] 2. Components: read-only fetch of each project's components, `components` on `IssueRow`, component -> layer
      mapping in the project config (`normalizeConfig`, `validateConfig`, project screen picker).
- [ ] 3. Outside-the-epics dataset: read-only query for the team members' issues with movement in the period that
      are not under the team's epics (separate section).
- [ ] 4. Pure report model: movement in the period, layer -> epic -> primary with its subtasks, "ref." rows, KPIs,
      hygiene notes, outside-epics section (test-first).
- [ ] 5. HTML template with the Flock design tokens, date-range picker, preview, `saveHtml` bridge (validated in main).
- [ ] 6. Close: demo coverage (components, history, outside epics), docs, decisions.
- [ ] 7. AI-drafted headlines and sprint reading, enabled only with a stored AI key, with the figures check of
      plan §8.2.

## Evidence
