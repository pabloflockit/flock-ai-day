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
- [ ] 4. Cache and config — `node:sqlite` schema, AES-256-GCM payloads and config, dataset read/write, `resolveTarget`, `normalizeConfig`, `validateConfig` base.
- [ ] 5. Jira client and projection — client (pagination via `nextPageToken`, backoff, error codes, injectable fetch), `IssueRow` projection, hierarchy by `epicLinkMode`, delta/full refresh, `PAYLOAD_VERSION`, stale-not-empty degradation, dataset routes.
- [ ] 6. Domain dates — UTC utilities, calendar date vs instant formatters, `businessDaysBetween`, local-calendar weeks, `effectiveCategory`.
- [ ] 7. Diagnostics, demo, validator — signal store with key-based hydration, diagnostics page, `--demo` mode with fixture fetch and separate DB, `tools/validate-scope.mjs`, section 12 checklist pass.

## Evidence

(commit ids and check results recorded per task)

- Task 1: `d21241d` — audit and decisions written; grep confirmed no hostnames, emails, or tokens. Reference left untouched (clean `git status`).
- Task 2: `a260761` — `node --test` 8/8, Karma 3/3, `ng build` ok, Electron smoke: `/api/health` ok on 127.0.0.1:3100. VERIFY-1: Electron 41.10.7 embeds Node 24.18.0; `node:sqlite` loads without flags (checked with `ELECTRON_RUN_AS_NODE`). Note: npm 12 blocks install scripts, so the Electron binary needs `node node_modules/electron/install.js` (document in README).
- Task 3: `node --test` 153/153, Karma 5/5, `ng build` ok. Packaged smoke: renderer on `app://leadership-panel`, `/api/health` 200 with secret / 401 without / 403 foreign origin, CSP blocks remote fetch, `window.open` denied, bridge exposes exactly 5 keys. Dev mode not smoked. Carry-overs to task 4: wire `getJiraBaseUrl` / `getAllowedHosts` to config and run `validateJiraUrl` before storing; `serverInfo` Cloud check lands with the Jira client (task 5). Packaging risk: `inlineCritical` would emit an inline `onload` blocked by CSP.
