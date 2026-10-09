# Decisions log

Append-only log of project decisions. Newest entries go at the end of each section.
Companion document: `docs/reference-audit.md`.

## 1. Reference origin

| Item | Value |
|---|---|
| Reference project (path name) | the reference app |
| Reference commit | `<ref>` |
| Access | Read-only. Nothing in the reference is modified; no secrets, env files, caches or databases from it are read or copied. |
| Scope of reuse | Only the generic pieces listed in the architecture port table (§0.2). Domain-specific names, states, labels, rules and copy are not carried over. |

## 2. Stack decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Proxy and Electron main stay **plain JavaScript** with **JSDoc types**. Proxy, shared and tools use ESM (`.mjs`); Electron main and preload use CommonJS (`.cjs`), as in the reference. | The architecture says to keep the reference's language when starting from it. Keeps ported code close to the source and removes a compile step. |
| D2 | **Angular 20** (same major as the reference, which uses `^20.3`). | Eases porting of the store, routing and pipes. |
| D3 | **`node --test`** for proxy, cache, shared and domain tests, with injected `fetchImpl` and in-memory databases. Angular's own runner only for essential UI. | Matches the reference's test setup and the architecture's tooling section. |
| D4 | **Identifiers in English; UI copy in Spanish (es-AR).** Documentation in English. | Architecture §3; the reference mixes Spanish identifiers, which are renamed on port. |
| D5 | `shared/` modules are plain `.mjs` with JSDoc so that both the proxy and Angular can import them without duplication. | One implementation of `resolveTarget` and domain functions. |
| D6 | Electron **41.x**, as in the reference (`^41.3.0`; lockfile resolves `41.3.0`). | Same runtime as the reference, which already runs `node:sqlite` in the main process. Embedded Node version confirmed in VERIFY-1. |

## 3. Ported pieces

Fill one row per piece when it is ported. Record the reference commit used, and what was adapted. Keep adaptations and new behaviour in separate commits.

| Piece | Reference path | Reference commit | Adaptations |
|---|---|---|---|
| In-process proxy start-up and dynamic port | `desktop/main.cjs` (`startJiraProxy`, `createMainWindow`, `before-quit`), `scripts/find-available-port.mjs` | `<ref>` | `findAvailablePort` ported to `proxy/find-available-port.mjs` with the same logic (English error message, JSDoc). `electron/main.cjs` dynamically imports `proxy/server.mjs`, picks the first free port from 3100 and closes the server on `before-quit`. Dropped: `.env` loading, DB path, icon, dev-server env var, did-fail-load recovery. Plain `require('electron')` instead of the string-join trick (VERIFY-7). |
| Preload and port hand-off | `desktop/preload.cjs`; `webPreferences.additionalArguments` in `desktop/main.cjs` | `<ref>` | Argument renamed `--proxy-port`; exposes only `{ proxyBaseUrl }` (`http://127.0.0.1:<port>`) as `window.leadershipPanel`. Secret and OS bridge functions come in task 3. |
| Native `http` server and routing | Pattern only (`createServer`, `dispatchGetRequest` in `scripts/jira-proxy-server.mjs`); that file was not read for this task | `<ref>` | Rebuilt from the architecture contract: `proxy/server.mjs` + `proxy/router.mjs`, `{ ok, data } | { ok, error }` envelope, 404/405, host locked to `127.0.0.1`, `guards` extension point for the future secret check. |
| Jira client (pagination, concurrency, TTL, injectable fetch) | TODO (candidate: `jiraRequest`, `buscarIssues`, `mapWithConcurrency`, `createFieldMetadataCache`) | TODO | TODO |
| Projection to flat rows | TODO (candidate: `projectToAuditRow`, `findNumericFieldOrNull`) | TODO | TODO |
| Cache with `node:sqlite`, delta, payload version, stale degradation | TODO (candidate: `scripts/jira-cache-db.mjs`, delta and carry-over functions in the proxy) | TODO | TODO |
| `resolveTarget` | TODO (no direct equivalent; reference has two divergent copies) | TODO | TODO |
| `normalizeConfig` | TODO (no direct equivalent) | TODO | TODO |
| Signals store with `ensureHydrated` | TODO (candidate: `src/app/core/services/team-store.service.ts`) | TODO | TODO |
| Date utilities and formatters | TODO (candidate: `src/app/core/utils/sprint-calendar.utils.ts`, `src/app/core/pipes/*date*.pipe.ts`) | TODO | TODO |
| Predicate vs JQL validator | TODO (does not exist in the reference; build new) | n/a | TODO |
| Electron window configuration and hash routing | `desktop/main.cjs` (`createMainWindow`, `getRendererUrl`), `src/app/app.config.ts` | `<ref>` | Same `contextIsolation`/`nodeIntegration`/`sandbox` flags; `--dev` loads `http://localhost:4200`, otherwise `file://` of `dist/leadership-panel/browser/index.html`. `withHashLocation()` kept; `APP_INITIALIZER`, `provideHttpClient` and migration/prefill not ported (fetch-based proxy client). CSP and navigation blocking are task 3. |
| Env file loader (dev only) | TODO (candidate: `scripts/load-env.mjs`) | TODO | TODO |

## 4. Rules deliberately not carried over

| Reference behaviour | Decision |
|---|---|
| Token stored in browser storage and sent in request headers; token echoed by a dev endpoint | Not ported. Token is stored with `safeStorage` in main, written through a write-only endpoint and read only by the proxy (architecture §4.3). |
| `CHECK(source IN (...))` in the cache schema | Not ported. Sources are data. |
| `datetime('now')` timestamps | Not ported. Timestamps are produced in code as ISO with `Z`. |
| State-changing operations as GET with query strings | Not ported. Writes use PUT/POST. |
| Name-based type, status and field identification | Not ported. Identity is by id. |
| Swallowing a Jira 400 as an empty result | Not ported. Shard failure is recorded in `shards_meta`; cached rows are kept. |

## 5. VERIFY items to resolve

Do not assume; resolve against current vendor documentation or the real instance, and record the outcome here.

| ID | Item | How to resolve | Outcome |
|---|---|---|---|
| VERIFY-1 | `node:sqlite` available, without flags, in the Node embedded in the chosen Electron version. The reference declares Electron `^41.3.0` and resolves `41.3.0` in its lockfile; the embedded Node version cannot be read from the lockfile. Reference code imports `DatabaseSync` from `node:sqlite` in the main-process-hosted proxy, which suggests it works, but this is an inference. | Check the Electron release notes for the chosen version, then run `process.versions.node` and `require('node:sqlite')` from the new app's main process. Confirm no experimental warning or flag is required. | **Resolved.** Electron 41.10.7 embeds Node 24.18.0 (`ELECTRON_RUN_AS_NODE=1 npx electron -e "..."`); `require('node:sqlite')` loaded with no flag and no warning (`sqlite ok`). Checked with `ELECTRON_RUN_AS_NODE`, i.e. the Electron-embedded Node runtime, not inside the real main process; task 4 exercises it there. |
| VERIFY-2 | Whether `/rest/api/3/search/jql` supports `expand=changelog`, and whether it truncates history entries. | Probe against the real instance with a known multi-transition issue; compare to `/issue/{key}/changelog`. Fall back to per-issue changelog for delta issues if not supported or truncated. | TODO |
| VERIFY-3 | JQL syntax for filtering children by the Epic Link custom field (`cf[<id>] = KEY`), including quoting and which id to use. | Probe on the instance with a classic project; record the working form and the field id lookup. | TODO |
| VERIFY-4 | `hierarchyLevel` values returned by `/issuetype` (expected 1 epic, 0 standard, -1 subtask) and the reliability of the subtask flag. | Call `/issuetype` on the instance and tabulate id, name, `hierarchyLevel`, `subtask`. | TODO |
| VERIFY-5 | Name of the status-category-change date field (fallback for state history when changelog is unavailable). | List `/field` on the instance and search by schema, not by display name. | TODO |
| VERIFY-6 | Whether the reference's `parentEpic` JQL function is available and equivalent on the target instance (the reference relied on it for all child queries). | Probe; if not, rely on `epicLinkMode`. | TODO |
| VERIFY-7 | Reason for the string-join trick used to require `electron` in the reference main and preload (`['elec','tron'].join('')`). | Not documented in the reference source read. Decide whether the new project needs it; default to a plain `require('electron')` and check packaging. | TODO |

## 6. Log

| Date | Decision | Notes |
|---|---|---|
| (initial) | Sections 1–5 seeded from the reference audit. | See `docs/reference-audit.md`. |
| 2026-10-09 | Pinned `electron@~41.10` (resolved 41.10.7, Node 24.18.0). | VERIFY-1. |
| 2026-10-09 | Angular imports `shared/*.mjs` through `allowJs: true` in `tsconfig.json` and relative paths (`../../../shared/contracts.mjs`); no `paths` alias or build step. | Verified with `ng build`: JSDoc typedefs resolve as types. Imports are type-only so far; runtime imports should bundle the same way (esbuild) but are not yet exercised. Implements D5. |
| 2026-10-09 | `test:node` uses the glob `node --test "test/**/*.test.mjs"`. | On Node 24 `node --test test/` treats `test/` as a module path and fails with MODULE_NOT_FOUND. |
| 2026-10-09 | Angular app is zoneless; tests run with `ng test --watch=false --browsers=ChromeHeadless`, and specs provide `provideZonelessChangeDetection()`. | CLI 20 `--zoneless`. |
| 2026-10-09 | Angular scaffolded in a temp directory and copied in. | `ng new --directory .` refuses the non-empty directory (README.md merge conflict). README.md untouched. |
| 2026-10-09 | The Electron binary is not downloaded by `npm install` here (install scripts need approval); run `node node_modules/electron/install.js` once. | Observed on a fresh install. |
