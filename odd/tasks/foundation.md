# Feature: foundation (architecture flow 1)

Goal: a desktop app that starts, connects securely to Jira Cloud, fetches and caches the rows of a
test epic as flat `IssueRow`s, and shows them on a diagnostics page. No business screens yet.

Source of truth: `docs/architecture.md` (private, local only). Exit criteria: its section 12 checklist.
Reference repo (read-only, never write, never read `.env*`, `.cache/`, `*.db`): the reference app.
Branch: `main` (user decision: commit each task directly on `main` and push right away to keep the history on GitHub).

## Tasks

- [x] 1. Reference audit — `docs/reference-audit.md` (rule → status → evidence → resolution → effort) and `docs/decisions.md` seeded with reference commit and language/stack decisions.
- [x] 2. Skeleton — package.json, Angular app (standalone, signals, hash routing, lazy pages), Electron main/preload, in-process proxy on 127.0.0.1 with dynamic port, `node --test` setup.
- [x] 3. Security — session secret (`X-Proxy-Secret`), `safeStorage` token + data key, write-only token endpoint, Jira URL validation, outbound host allowlist, preload bridge (`openInJira`, `copyText`, `saveMarkdown`), CSP, navigation blocking.
- [x] 4. Cache and config — `node:sqlite` schema, AES-256-GCM payloads and config, dataset read/write, `resolveTarget`, `normalizeConfig`, `validateConfig` base.
- [x] 5. Jira client and projection (split for review size: 5a client, metadata, connection routes; 5b projection, hierarchy, refresh, dataset routes) — client (pagination via `nextPageToken`, backoff, error codes, injectable fetch), `IssueRow` projection, hierarchy by `epicLinkMode`, delta/full refresh, `PAYLOAD_VERSION`, stale-not-empty degradation, dataset routes.
- [x] 6. Domain dates — UTC utilities, calendar date vs instant formatters, `businessDaysBetween`, local-calendar weeks, `effectiveCategory`.
- [ ] 7. Diagnostics, demo, validator (split: 7a store hydration + diagnostics page + `epicIssues` source; 7b demo mode, fixtures, `validate-scope`; 7c independent section 12 checklist verification) — signal store with key-based hydration, diagnostics page, `--demo` mode with fixture fetch and separate DB, `tools/validate-scope.mjs`, section 12 checklist pass.

## Evidence

(commit ids and check results recorded per task)

- Task 1: `d21241d` — audit and decisions written; grep confirmed no hostnames, emails, or tokens. Reference left untouched (clean `git status`).
- Task 2: `a260761` — `node --test` 8/8, Karma 3/3, `ng build` ok, Electron smoke: `/api/health` ok on 127.0.0.1:3100. VERIFY-1: Electron 41.10.7 embeds Node 24.18.0; `node:sqlite` loads without flags (checked with `ELECTRON_RUN_AS_NODE`). Note: npm 12 blocks install scripts, so the Electron binary needs `node node_modules/electron/install.js` (document in README).
- Task 3: `node --test` 153/153, Karma 5/5, `ng build` ok. Packaged smoke: renderer on `app://leadership-panel`, `/api/health` 200 with secret / 401 without / 403 foreign origin, CSP blocks remote fetch, `window.open` denied, bridge exposes exactly 5 keys. Dev mode not smoked. Carry-overs to task 4: wire `getJiraBaseUrl` / `getAllowedHosts` to config and run `validateJiraUrl` before storing; `serverInfo` Cloud check lands with the Jira client (task 5). Packaging risk: `inlineCritical` would emit an inline `onload` blocked by CSP.
- Task 4: `node --test` 207/207, `ng build` ok (shared `cache-key.mjs` compiled in Angular via a reverted probe), dev Electron smoke: DB created in `.cache/`, `GET`/`PUT /api/config` ok. Raw `.db` bytes contain no plaintext; wrong key → `DATA_KEY_INVALID` (409) with rows byte-identical. `getJiraBaseUrl`/`getAllowedHosts` read config and fail closed. Packaged mode not smoked. `workUnit` does not move keys (subtasks are always fetched by the hierarchy).
- Task 5a: `node --test` 241/241, `ng build` ok, fake fetch only (no live Jira). Verify route uses a one-shot `forHost` fetch without auth; non-Cloud → 422 `NOT_CLOUD`. VERIFY against Atlassian OpenAPI: `/search/jql` POST with `nextPageToken`, no total, `changelog` expand valid; epic level 1, standard 0, subtask -1. Still open: changelog truncation (VERIFY-2) and the real instance type table (VERIFY-4). Also fixed stray Latin-1 `§` bytes in `docs/decisions.md`.
- Task 5a commit: `dee153e`.
- Task 5b: `node --test` 291/291, `ng build` ok, fake client only. Per-epic delta window from each epic's `lastOkAt` + 5 min; failed epics keep cached rows, `is_current = 0`; metadata failure marks all shards failed instead of throwing; refresh coalescing per key. Known limits for flow 2: `doneAt` is not cleared on reopen (domain must read it with the current category); `firstDoingAt` is `null` for issues created directly in a doing status; changelog completion can peak at ~36 concurrent requests. VERIFY-2/3/4 handled in code, not probed live.
- Task 5b commit: `f6963bd`.
- Task 6: `node --test` 322/322, `ng build` ok (pipes compile, not yet used in a template). Conventions: business days counted in `(from, to]` on local calendar dates, reversed args negate, `isStale` strict `>`, `timeZone` required in pure functions, `effectiveDoneAt` returns `null` unless the effective category is done.
- Task 6 commit: `d1977c7`.
- Task 7a: `node --test` 330/330, Karma 14/14, `ng build` and `build:desktop` ok; `shared/cache-key.mjs` runtime import confirmed in the Angular bundle. Packaged smoke over CDP: diagnostics renders on `app://leadership-panel/#/diagnostics`, health ok, bridge has 5 keys, unconfigured epic shows `JIRA_NOT_CONFIGURED`. Not exercised live: verify, save token, test connection, real epic (no token). Follow-ups: `epicIssues` rows have no TTL/cleanup; a few proxy messages still English.
- Task 7a commit: `f7c4582`.
- Task 7b: `node --test` 362/362 (run with `JIRA_*` unset), `ng build` ok. `validate-scope --demo --epic DEMO-1 --predicate open` → 7/7, `onlyPredicate=0 onlyJql=0`; DEMO-1+DEMO-2 `all` → 17/17. Electron `--demo` smoke via API: DEMO-3 shard `failed:BAD_QUERY`, separate DB and data key under `demo/`. Incident: one worker sanity run of `validate-scope` without `--demo` used the user's shell `JIRA_*` variables and made read-only requests to the real site (FORBIDDEN, nothing printed or written); the worker was stopped from repeating it and later runs unset those variables. Rule from now on: never run tools that can reach Jira without `--demo` unless the user asks. Open: packaging must include `fixtures/` for packaged `--demo`; VERIFY-2/3 still need a live probe.
