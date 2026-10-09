import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PRELOAD = require.resolve('../electron/preload.cjs');

/** Loads the real preload with a stubbed `electron` and returns what it exposes. */
function loadPreload(argv) {
  const exposed = {};
  const invoked = [];
  const stub = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed[name] = api) },
    ipcRenderer: { invoke: (...args) => (invoked.push(args), Promise.resolve({ ok: true })) },
  };
  const originalLoad = Module._load;
  const originalArgv = process.argv;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? stub : originalLoad.call(this, request, ...rest);
  };
  process.argv = [...originalArgv, ...argv];
  delete require.cache[PRELOAD];
  try {
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    process.argv = originalArgv;
    delete require.cache[PRELOAD];
  }
  return { exposed, invoked };
}

test('the preload exposes exactly the five bridge keys under leadershipPanel', () => {
  const { exposed } = loadPreload(['--proxy-port=3101', '--proxy-secret=s3cret']);
  assert.deepEqual(Object.keys(exposed), ['leadershipPanel']);
  assert.deepEqual(Object.keys(exposed.leadershipPanel).sort(), [
    'copyText',
    'openInJira',
    'proxyBaseUrl',
    'proxySecret',
    'saveMarkdown',
  ]);
  assert.equal(exposed.leadershipPanel.proxyBaseUrl, 'http://127.0.0.1:3101');
  assert.equal(exposed.leadershipPanel.proxySecret, 's3cret');
});

test('bridge functions only forward to their own IPC channel', async () => {
  const { exposed, invoked } = loadPreload(['--proxy-port=3101', '--proxy-secret=x']);
  await exposed.leadershipPanel.openInJira('A-1');
  await exposed.leadershipPanel.copyText('t');
  await exposed.leadershipPanel.saveMarkdown('n.md', 'c');
  assert.deepEqual(
    invoked.map(([channel]) => channel),
    ['bridge:openInJira', 'bridge:copyText', 'bridge:saveMarkdown'],
  );
});
