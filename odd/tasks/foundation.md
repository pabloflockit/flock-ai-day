# Feature: foundation (architecture flow 1)

Goal: a desktop app that starts, connects securely to Jira Cloud, fetches and caches the rows of a
test epic as flat `IssueRow`s, and shows them on a diagnostics page. No business screens yet.

Source of truth: `docs/architecture.md` (private, local only). Exit criteria: its section 12 checklist.
Reference repo (read-only, never write, never read `.env*`, `.cache/`, `*.db`): the reference app.
Branch: `feat/foundation`.

## Tasks

- [ ] 1. Reference audit — `docs/reference-audit.md` (rule → status → evidence → resolution → effort) and `docs/decisions.md` seeded with reference commit and language/stack decisions.
- [ ] 2. Skeleton — package.json, Angular app (standalone, signals, hash routing, lazy pages), Electron main/preload, in-process proxy on 127.0.0.1 with dynamic port, `node --test` setup.
- [ ] 3. Security — session secret (`X-Proxy-Secret`), `safeStorage` token + data key, write-only token endpoint, Jira URL validation, outbound host allowlist, preload bridge (`openInJira`, `copyText`, `saveMarkdown`), CSP, navigation blocking.
- [ ] 4. Cache and config — `node:sqlite` schema, AES-256-GCM payloads and config, dataset read/write, `resolveTarget`, `normalizeConfig`, `validateConfig` base.
- [ ] 5. Jira client and projection — client (pagination via `nextPageToken`, backoff, error codes, injectable fetch), `IssueRow` projection, hierarchy by `epicLinkMode`, delta/full refresh, `PAYLOAD_VERSION`, stale-not-empty degradation, dataset routes.
- [ ] 6. Domain dates — UTC utilities, calendar date vs instant formatters, `businessDaysBetween`, local-calendar weeks, `effectiveCategory`.
- [ ] 7. Diagnostics, demo, validator — signal store with key-based hydration, diagnostics page, `--demo` mode with fixture fetch and separate DB, `tools/validate-scope.mjs`, section 12 checklist pass.

## Evidence

(commit ids and check results recorded per task)
