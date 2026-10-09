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

## Decisions to confirm at kickoff

- Layer model: per member in the team config (FE / BE / Funcional / other) and whether subtask types also map.
- Period: free date range vs named sprints (the Agile API is listed as evolution).
- Items outside the team's epics: keep out, or add a member-based query.
- HTML export: new `saveHtml` bridge vs HTML preview + copy only.

## Draft tasks (deterministic first)

- [ ] 1. Status transition history in `IssueRow` (proxy projection from the changelog, payload version bump, tests).
- [ ] 2. Member layer in the config (`normalizeConfig`, `validateConfig`, teams screen) and the layer rules.
- [ ] 3. Pure report model: movement in the period, layer -> epic -> primary with its subtasks, "ref." rows, KPIs,
      hygiene notes (test-first).
- [ ] 4. HTML template with the Flock design tokens + `saveHtml` bridge (validated in main) + preview.
- [ ] 5. Close: demo coverage, docs, decisions.
- [ ] 6. (Optional, later) AI-drafted headlines and sprint reading with the figures check of plan §8.2.

## Evidence
