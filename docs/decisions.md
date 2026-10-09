# Decisions log

Append-only log of project decisions. Newest entries go at the end of each section.
Companion document: `docs/reference-audit.md`.

## 1. Reference origin

| Item | Value |
|---|---|
| Reference project (path name) | the reference app |
| Reference commit | `<ref>` |
| Access | Read-only. Nothing in the reference is modified; no secrets, env files, caches or databases from it are read or copied. |
| Scope of reuse | Only the generic pieces listed in the architecture port table (ยง0.2). Domain-specific names, states, labels, rules and copy are not carried over. |

## 2. Stack decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Proxy and Electron main stay **plain JavaScript** with **JSDoc types**. Proxy, shared and tools use ESM (`.mjs`); Electron main and preload use CommonJS (`.cjs`), as in the reference. | The architecture says to keep the reference's language when starting from it. Keeps ported code close to the source and removes a compile step. |
| D2 | **Angular 20** (same major as the reference, which uses `^20.3`). | Eases porting of the store, routing and pipes. |
| D3 | **`node --test`** for proxy, cache, shared and domain tests, with injected `fetchImpl` and in-memory databases. Angular's own runner only for essential UI. | Matches the reference's test setup and the architecture's tooling section. |
| D4 | **Identifiers in English; UI copy in Spanish (es-AR).** Documentation in English. | Architecture ยง3; the reference mixes Spanish identifiers, which are renamed on port. |
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
| Cache with `node:sqlite`, payload version (task 4: storage half) | `scripts/jira-cache-db.mjs` (`initDb`, `upsertDataset`, `getCachedDataset`) | `<ref>` | Pattern only; rebuilt: `proxy/cache/db.mjs` (injected path and clock, `schema_meta` versioned migrations instead of the unused `user_version`, `renameAndRecreate`), `proxy/cache/datasets.mjs` (architecture 5.2 columns, `PAYLOAD_VERSION`, `needsFullRefresh`), `proxy/cache/crypto.mjs` (AES-256-GCM, AAD per row). Dropped: `CHECK(source IN ...)`, `datetime('now')`, plaintext JSON, team tables, `jira_unreachable` and the soft-fail no-op (replaced by `is_current` + `shards_meta`, written by the Jira client in task 5). Delta windows, carry-over of failed epics and refresh orchestration are task 5. |
| `resolveTarget` | No direct equivalent (reference has two divergent copies) | n/a | New `shared/cache-key.mjs`: canonical JSON + 64-bit FNV-1a (BigInt, no `node:crypto`), used by proxy and Angular. `projectIssuesParams` derives the query-changing params only. |
| `normalizeConfig` / `validateConfig` / config store | No direct equivalent | n/a | New `proxy/config/{normalize,validate,store}.mjs`: shape from plan 2.1, rules from plan 2.2. |
| Signals store with `ensureHydrated` | TODO (candidate: `src/app/core/services/team-store.service.ts`) | TODO | TODO |
| Date utilities and formatters | TODO (candidate: `src/app/core/utils/sprint-calendar.utils.ts`, `src/app/core/pipes/*date*.pipe.ts`) | TODO | TODO |
| Predicate vs JQL validator | TODO (does not exist in the reference; build new) | n/a | TODO |
| Electron window configuration and hash routing | `desktop/main.cjs` (`createMainWindow`, `getRendererUrl`), `src/app/app.config.ts` | `<ref>` | Same `contextIsolation`/`nodeIntegration`/`sandbox` flags; `--dev` loads `http://localhost:4200`, otherwise `file://` of `dist/leadership-panel/browser/index.html`. `withHashLocation()` kept; `APP_INITIALIZER`, `provideHttpClient` and migration/prefill not ported (fetch-based proxy client). CSP and navigation blocking are task 3. |
| Preload bridge, window hardening (task 3) | `desktop/preload.cjs`, `desktop/main.cjs` (`setWindowOpenHandler`) | `<ref>` | Not ported literally. Rebuilt from the spec: preload exposes only `proxyBaseUrl`, `proxySecret`, `openInJira`, `copyText`, `saveMarkdown` (IPC `invoke`), all validated in `electron/bridge-validation.cjs`. The reference's `window.open` -> `shell.openExternal` is dropped: `setWindowOpenHandler` always denies; `will-navigate`/`will-redirect` blocked outside the app origin. |
| Env file loader (dev only) | TODO (candidate: `scripts/load-env.mjs`) | TODO | TODO |

## 4. Rules deliberately not carried over

| Reference behaviour | Decision |
|---|---|
| Token stored in browser storage and sent in request headers; token echoed by a dev endpoint | Not ported. Token is stored with `safeStorage` in main, written through a write-only endpoint and read only by the proxy (architecture ยง4.3). |
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
| (initial) | Sections 1โ€“5 seeded from the reference audit. | See `docs/reference-audit.md`. |
| 2026-10-09 | Pinned `electron@~41.10` (resolved 41.10.7, Node 24.18.0). | VERIFY-1. |
| 2026-10-09 | Angular imports `shared/*.mjs` through `allowJs: true` in `tsconfig.json` and relative paths (`../../../shared/contracts.mjs`); no `paths` alias or build step. | Verified with `ng build`: JSDoc typedefs resolve as types. Imports are type-only so far; runtime imports should bundle the same way (esbuild) but are not yet exercised. Implements D5. |
| 2026-10-09 | `test:node` uses the glob `node --test "test/**/*.test.mjs"`. | On Node 24 `node --test test/` treats `test/` as a module path and fails with MODULE_NOT_FOUND. |
| 2026-10-09 | Angular app is zoneless; tests run with `ng test --watch=false --browsers=ChromeHeadless`, and specs provide `provideZonelessChangeDetection()`. | CLI 20 `--zoneless`. |
| 2026-10-09 | Angular scaffolded in a temp directory and copied in. | `ng new --directory .` refuses the non-empty directory (README.md merge conflict). README.md untouched. |
| 2026-10-09 | The Electron binary is not downloaded by `npm install` here (install scripts need approval); run `node node_modules/electron/install.js` once. | Observed on a fresh install. |
| 2026-10-09 | **Packaged renderer origin is `app://leadership-panel`** (custom protocol via `protocol.handle`, registered standard + secure + fetch-capable), not `file://`. CSP is set as a response header: in the protocol handler for packaged mode and with `session.webRequest.onHeadersReceived` for the dev server (`http://localhost:4200`). | `file://` pages send `Origin: null`, which cannot be allowlisted safely, and cannot carry a header-based CSP. Both mechanisms are built from `buildCsp({ proxyPort, dev })` so the real dynamic port is injected. `build:desktop` already uses `--base-href ./`, so assets resolve under `app://`. |
| 2026-10-09 | CSP: `default-src 'self'; connect-src http://127.0.0.1:<port>; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`. Dev adds `'self'` and `ws://localhost:4200` to `connect-src` (live reload). | `'unsafe-inline'` only for styles: Angular injects component styles as `<style>` at runtime. Scripts remain `'self'`-only. Risk: a production build with `optimization.styles.inlineCritical` emits an inline `onload` handler that this CSP would block; `angular.json` currently has `optimization: false` for the desktop build. Revisit when packaging. |
| 2026-10-09 | CORS allowlist = `app://leadership-panel`, plus `http://localhost:4200` only when started with `--dev`. Foreign `Origin` (including `null`) -> 403 `FORBIDDEN_ORIGIN`; allowlisted preflight -> 204 with `X-Proxy-Secret, Content-Type` only; requests with no `Origin` are not CORS-restricted but still need the secret. | Architecture ง4.2. No `Authorization` or `X-Jira-*` is ever allowed. |
| 2026-10-09 | Session secret: `crypto.randomBytes(32)` base64url in main per launch, passed through `--proxy-secret`, checked with `timingSafeEqual` on SHA-256 digests. `createProxyServer` throws without `proxySecret` (fail-closed); the secret guard runs before any other guard and before routing, so unknown routes also return 401. | Required in dev too. Tests use `test/helpers.mjs`. |
| 2026-10-09 | `electron/secrets.cjs` (factory with injected `safeStorage`, `fs`, `dir`): one `safeStorage`-encrypted file per secret in `userData` (`jira-token.enc`, `ai-key.enc`, `data-key.enc`), write-then-rename. Data key is 32 random bytes generated on first start (`getDataKey()` called from main); an existing but undecryptable or wrong-length key is an error and is never regenerated. No plaintext fallback. The `secrets` object goes only to the in-process proxy. | Architecture ง4.3, ง4.5. |
| 2026-10-09 | Write-only endpoints `PUT /api/connection/token` (`{ token }`) and `PUT /api/ai/key` (`{ key }`): string, trimmed, 1..4096 chars, body limit 16 KB (413), invalid JSON 400. Other methods return 405; no route reads them. The router maps only `ApiError` to its own message; any other error becomes a generic 500, so values cannot leak through error text. The proxy does not log. | Architecture ง4.3, ง7. |
| 2026-10-09 | `shared/jira-url.mjs` `validateJiraUrl`: https only, no credentials, no explicit port (default 443 normalised away), blocks `localhost`/`*.localhost`, IPv4 `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `100.64/10`, and **all IPv6 literals** (covers `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped without a hand-written parser). Returns `{ origin: 'https://host' }`. | Jira Cloud is always reached by DNS name. Not covered: a public hostname whose DNS resolves to a private address (DNS rebinding); mitigated only by the egress allowlist. The `serverInfo` / `deploymentType: Cloud` check lands with the Jira client (TODO in the module). |
| 2026-10-09 | `createGuardedFetch` (`proxy/security/guarded-fetch.mjs`): exact `host` match against `getAllowedHosts()` (read per call), https only, no credentials, blocked hosts re-checked, `redirect: 'error'`. Rejection is `ApiError(403, EGRESS_BLOCKED)` before any network call. Main wires it with `getAllowedHosts = () => []` until task 4 provides configuration. | Architecture ง4.4. |
| 2026-10-09 | `electron/bridge-validation.cjs` is CommonJS and does not import `shared/jira-url.mjs`: `buildIssueUrl` only re-checks `https:` on the stored base URL, which task 4 must pass through `validateJiraUrl` before storing. | Main is CJS; avoided relying on `require(esm)`. |
| 2026-10-09 | IPC handlers only answer when `event.senderFrame.url` has the app origin; the session denies all permission requests. | Defence in depth for the bridge. |
| 2026-10-09 | **Task 4 storage.** DB file `leadership-panel.db`: `--dev` -> `<repo>/.cache/`, packaged -> `userData` (main decides; they differ, so switching modes looks like data loss). Default rollback journal (no WAL sidecar files), so recovery renames a single file. Schema = architecture 5.2 via migration v1 recorded in `schema_meta` (`schema_version`, `created_at`); a DB with a newer version is refused. No `CHECK(source ...)`, no `datetime('now')`; every timestamp is ISO `Z` from an injected `now()`, and writes reject non-`Z` timestamps. | `renameAndRecreate()` renames to `<name>.bak-<ISO with : and . replaced by ->` (numeric suffix on collision), never deletes, and is an explicit action only (no UI yet). |
| 2026-10-09 | **Encryption.** AES-256-GCM, data key from `secrets.getDataKey()`, random 12-byte IV per write, iv + 16-byte tag stored in their own columns. AAD = `JSON.stringify(['datasets', scopeId, source, paramsKey])` or `['app_config', '1']`, so a ciphertext copied to another row fails. Any decrypt failure -> `ApiError(409, DATA_KEY_INVALID)` with a static message; reads never write, and `save` decrypts the existing row first, so an unreadable row is never overwritten. | JSON-array AAD instead of a joined string so parts cannot collide. `shards_meta` stays clear text per architecture 5.2 (epic keys, status, error codes; no issue content). |
| 2026-10-09 | **Cache keys.** `paramsKey` = 16-hex FNV-1a 64 of canonical JSON; `cacheKey` = `scope`, `source`, `paramsKey` joined with a pipe. Every array in params is treated as a set and sorted (documented in the module); order-sensitive params must be encoded as strings/objects. The hash is pinned by a test: changing it invalidates every cache. `projectIssuesParams` = active epic keys (sorted), measure field ids, `epicLinkMode`, `epicLinkFieldId` (plan 2.3); `workUnit` is not part of it. | 64-bit is not collision-proof but only names entries inside a `(scope, source)` row key. |
| 2026-10-09 | **Config.** `normalizeConfig` whitelists plan 2.1 with defaults, never invents identity (entries without id / accountId / epic key are dropped), numbers must be integers (>= 1, `maxRetries` >= 0) else default, `version` is always `CONFIG_VERSION` (migrations branch on `raw.version` there). `validateConfig` returns `{ code, path, message }` (Spanish): name uniqueness is case-insensitive, an epic key is unique across and within projects, `jira.baseUrl` goes through `validateJiraUrl` when non-empty. Delete guards `guardDeleteTeam` / `guardDeleteProject` are exported for later UI. | Closes the task-3 carry-over: the stored URL is validated on every save, and `getJiraBaseUrl` / `getAllowedHosts` re-validate on read (fail-closed to `null` / `[]`, including when the data key is wrong). The AI host is not in the allowlist yet (TODO in `proxy/config/jira-endpoint.mjs`). |
| 2026-10-09 | **`PUT /api/config`** returns `{ config, movedKeys }`: `movedKeys` are `cacheKey` strings of ACTIVE projects of the edited config whose `projectIssues` key is new or different from the previous config's. `VALIDATION_FAILED` -> 400 with `error.details.issues`; `ApiError` and `errorEnvelope` gained optional `details`. `/api/config` accepts a 1 MB body (others stay at 16 KB). | A newly created project counts as moved (no previous key). Without a store the routes answer 503 `STORAGE_UNAVAILABLE`. |
| 2026-10-09 | `.gitattributes`: `* text=auto eol=lf` plus binary patterns. Existing files are not renormalized in task 4. | Stops the CRLF warnings. |
| 2026-10-09 | VERIFY-1 follow-up: `node:sqlite` works inside the real Electron main process (dev smoke created `.cache/leadership-panel.db` and served `GET`/`PUT /api/config`). | The packaged `app://` path was smoked in task 3. |
