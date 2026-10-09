import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const p = createRequire(import.meta.url)('../electron/security-policy.cjs');

test('CSP: self only, connect-src pinned to the dynamic proxy port, no remote sources', () => {
  const csp = p.buildCsp({ proxyPort: 3123 });
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src http:\/\/127\.0\.0\.1:3123(;|$)/);
  assert.doesNotMatch(csp, /https?:\/\/(?!127\.0\.0\.1:3123)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /\*/);
});

test('CSP: dev mode additionally allows the dev server websocket for live reload', () => {
  const csp = p.buildCsp({ proxyPort: 3123, dev: true });
  assert.match(csp, /connect-src 'self' http:\/\/127\.0\.0\.1:3123 ws:\/\/localhost:4200/);
});

test('CSP rejects an invalid port', () => {
  assert.throws(() => p.buildCsp({ proxyPort: 'x' }));
  assert.throws(() => p.buildCsp({ proxyPort: 0 }));
});

test('navigation allowed only inside the app origin', () => {
  const origin = 'app://leadership-panel';
  assert.equal(p.isAllowedNavigation('app://leadership-panel/index.html#/x', origin), true);
  assert.equal(p.isAllowedNavigation('app://other/index.html', origin), false);
  assert.equal(p.isAllowedNavigation('https://evil.example', origin), false);
  assert.equal(p.isAllowedNavigation('file:///c:/x.html', origin), false);
  assert.equal(p.isAllowedNavigation('not a url', origin), false);
  assert.equal(p.isAllowedNavigation('http://localhost:4200/#/a', 'http://localhost:4200'), true);
  assert.equal(p.isAllowedNavigation('http://localhost:4201/', 'http://localhost:4200'), false);
});

test('allowed CORS origins: packaged always, dev origin only in dev', () => {
  assert.deepEqual(p.getAllowedOrigins({ dev: false }), ['app://leadership-panel']);
  assert.deepEqual(p.getAllowedOrigins({ dev: true }), [
    'app://leadership-panel',
    'http://localhost:4200',
  ]);
});

test('resolveAppFile maps app:// paths inside the root and blocks traversal', () => {
  const root = process.platform === 'win32' ? 'C:\\app\\dist' : '/app/dist';
  const ok = p.resolveAppFile('app://leadership-panel/main.js', root);
  assert.ok(ok && ok.startsWith(root) && ok.endsWith('main.js'));
  assert.ok(p.resolveAppFile('app://leadership-panel/', root).endsWith('index.html'));
  assert.equal(p.resolveAppFile('app://leadership-panel/..%2F..%2Fsecret', root), null);
  // WHATWG URL folds %2e%2e into the path before we see it; it must still stay inside the root.
  const dotted = p.resolveAppFile('app://leadership-panel/%2e%2e/x', root);
  assert.ok(dotted === null || dotted.startsWith(root));
  assert.equal(p.resolveAppFile('app://other-host/main.js', root), null);
  // The URL parser may fold backslash tricks into the path; either way it must stay in the root.
  const folded = p.resolveAppFile('app://leadership-panel/a\\..\\..\\x', root);
  assert.ok(folded === null || folded.startsWith(root));
});

test('production build never relies on inline event handlers the CSP blocks', async () => {
  // `inlineCritical` loads the global stylesheet with `onload="this.media='all'"`; the CSP has no
  // `script-src 'unsafe-inline'`, so the handler never runs and the styles stay `media="print"`.
  const { readFile } = await import('node:fs/promises');
  const angular = JSON.parse(await readFile(new URL('../angular.json', import.meta.url), 'utf8'));
  const project = Object.values(angular.projects)[0];
  const optimization = project.architect.build.configurations.production.optimization;
  assert.equal(optimization?.styles?.inlineCritical, false);
});
