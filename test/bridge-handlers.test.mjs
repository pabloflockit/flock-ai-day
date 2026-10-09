import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createBridgeHandlers } = createRequire(import.meta.url)('../electron/bridge-handlers.cjs');

function setup({ jiraBase = 'https://acme.atlassian.net', savePath = '/home/u/out.md' } = {}) {
  const log = { opened: [], copied: [], written: [], dialogs: [] };
  const handlers = createBridgeHandlers({
    shell: { openExternal: async (u) => log.opened.push(u) },
    clipboard: { writeText: (t) => log.copied.push(t) },
    dialog: {
      showSaveDialog: async (_win, opts) => {
        log.dialogs.push(opts);
        return { canceled: savePath === null, filePath: savePath };
      },
    },
    fs: { writeFileSync: (p, c) => log.written.push([p, c]) },
    getJiraBaseUrl: () => jiraBase,
    getWindow: () => undefined,
  });
  return { log, handlers };
}

describe('openInJira', () => {
  test('opens the URL built from the configured base', async () => {
    const { handlers, log } = setup();
    assert.deepEqual(await handlers.openInJira('ABC-7'), { ok: true });
    assert.deepEqual(log.opened, ['https://acme.atlassian.net/browse/ABC-7']);
  });
  test('not configured -> error, nothing opened', async () => {
    const { handlers, log } = setup({ jiraBase: null });
    assert.deepEqual(await handlers.openInJira('ABC-7'), { ok: false, error: 'NOT_CONFIGURED' });
    assert.equal(log.opened.length, 0);
  });
  test('an URL passed as key is rejected', async () => {
    const { handlers, log } = setup();
    assert.equal((await handlers.openInJira('https://evil.example')).ok, false);
    assert.equal(log.opened.length, 0);
  });
});

describe('copyText', () => {
  test('copies valid text, rejects invalid', async () => {
    const { handlers, log } = setup();
    assert.deepEqual(await handlers.copyText('hi'), { ok: true });
    assert.equal((await handlers.copyText({})).ok, false);
    assert.deepEqual(log.copied, ['hi']);
  });
});

describe('saveMarkdown', () => {
  test('shows a .md-filtered dialog with a sanitized name and writes the file', async () => {
    const { handlers, log } = setup();
    assert.deepEqual(await handlers.saveMarkdown('../x.txt', '# hi'), { ok: true });
    assert.equal(log.dialogs[0].defaultPath, 'x.md');
    assert.deepEqual(log.dialogs[0].filters, [{ name: 'Markdown', extensions: ['md'] }]);
    assert.deepEqual(log.written, [['/home/u/out.md', '# hi']]);
  });
  test('canceled dialog writes nothing', async () => {
    const { handlers, log } = setup({ savePath: null });
    assert.deepEqual(await handlers.saveMarkdown('x', 'c'), { ok: true, canceled: true });
    assert.equal(log.written.length, 0);
  });
  test('a non-.md chosen path is never written', async () => {
    const { handlers, log } = setup({ savePath: 'C:\\Users\\u\\evil.exe' });
    assert.equal((await handlers.saveMarkdown('x', 'c')).ok, false);
    assert.equal(log.written.length, 0);
  });
  test('invalid content is rejected before any dialog', async () => {
    const { handlers, log } = setup();
    assert.equal((await handlers.saveMarkdown('x', 5)).ok, false);
    assert.equal(log.dialogs.length, 0);
  });
});

describe('saveHtml', () => {
  test('shows an .html-filtered dialog with a sanitized name and writes the file', async () => {
    const { handlers, log } = setup({ savePath: '/home/u/out.HTML' });
    assert.deepEqual(await handlers.saveHtml('../x.txt', '<p>hi</p>'), { ok: true });
    assert.equal(log.dialogs[0].defaultPath, 'x.html');
    assert.deepEqual(log.dialogs[0].filters, [{ name: 'HTML', extensions: ['html'] }]);
    assert.deepEqual(log.written, [['/home/u/out.HTML', '<p>hi</p>']]);
  });
  test('canceled dialog writes nothing', async () => {
    const { handlers, log } = setup({ savePath: null });
    assert.deepEqual(await handlers.saveHtml('x', 'c'), { ok: true, canceled: true });
    assert.equal(log.written.length, 0);
  });
  test('a non-.html chosen path is never written', async () => {
    for (const savePath of ['C:\\Users\\u\\evil.exe', '/home/u/out.md', '/home/u/a.html.exe']) {
      const { handlers, log } = setup({ savePath });
      assert.deepEqual(await handlers.saveHtml('x', 'c'), { ok: false, error: 'INVALID_PATH' });
      assert.equal(log.written.length, 0);
    }
  });
  test('invalid content is rejected before any dialog', async () => {
    const { handlers, log } = setup();
    assert.equal((await handlers.saveHtml('x', 5)).ok, false);
    assert.equal((await handlers.saveHtml('x', 'a'.repeat(5 * 1024 * 1024 + 1))).ok, false);
    assert.equal(log.dialogs.length, 0);
  });
});
