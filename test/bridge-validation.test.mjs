import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const v = createRequire(import.meta.url)('../electron/bridge-validation.cjs');

describe('validateIssueKey', () => {
  for (const key of ['ABC-1', 'A-10', 'PROJ_X2-12345', 'A1-9']) {
    test(`accepts ${key}`, () =>
      assert.deepEqual(v.validateIssueKey(key), { ok: true, value: key }));
  }
  const bad = [
    'abc-1',
    'ABC-0',
    'ABC-01',
    'ABC',
    '-1',
    '1ABC-1',
    'ABC-1 ',
    'ABC-1\n',
    'A B-1',
    'ABC-1/../x',
    'ABC-1?x=1',
    'ABC-1#x',
    'https://evil',
    '',
    null,
    undefined,
    5,
    {},
    `${'A'.repeat(300)}-1`,
  ];
  for (const key of bad) {
    test(`rejects ${JSON.stringify(key)?.slice(0, 40)}`, () =>
      assert.equal(v.validateIssueKey(key).ok, false));
  }
});

describe('validateCopyText', () => {
  test('accepts strings within bounds, including empty', () => {
    assert.deepEqual(v.validateCopyText('hello'), { ok: true, value: 'hello' });
    assert.equal(v.validateCopyText('').ok, true);
  });
  test('rejects non-strings and oversized text', () => {
    assert.equal(v.validateCopyText(1).ok, false);
    assert.equal(v.validateCopyText(null).ok, false);
    assert.equal(v.validateCopyText('x'.repeat(v.MAX_COPY_TEXT_LENGTH + 1)).ok, false);
    assert.equal(v.validateCopyText('x'.repeat(v.MAX_COPY_TEXT_LENGTH)).ok, true);
  });
});

describe('sanitizeMarkdownFileName', () => {
  const cases = [
    ['report', 'report.md'],
    ['report.md', 'report.md'],
    ['Report.MD', 'Report.md'],
    ['informe semanal.txt', 'informe semanal.md'],
    ['../../etc/passwd', 'passwd.md'],
    ['..\\..\\Windows\\system32\\evil.exe', 'evil.md'],
    ['C:\\temp\\a.md', 'a.md'],
    ['bad<>:"|?*name', 'bad_______name.md'],
    ['con', 'con_.md'],
    ['NUL.md', 'NUL_.md'],
    ['', 'report.md'],
    ['   ', 'report.md'],
    ['...', 'report.md'],
    [null, 'report.md'],
    [42, 'report.md'],
    ['a\u0000b\nc', 'a_b_c.md'],
    ['trailing dot.', 'trailing dot.md'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () =>
      assert.equal(v.sanitizeMarkdownFileName(input), expected));
  }
  test('long names are bounded and still end with .md', () => {
    const out = v.sanitizeMarkdownFileName('a'.repeat(500));
    assert.ok(out.length <= v.MAX_FILE_NAME_LENGTH && out.endsWith('.md'));
  });
});

describe('validateMarkdownRequest', () => {
  test('returns sanitized name and content', () => {
    assert.deepEqual(v.validateMarkdownRequest('x.txt', '# hi'), {
      ok: true,
      value: { fileName: 'x.md', content: '# hi' },
    });
  });
  test('rejects non-string and oversized content', () => {
    assert.equal(v.validateMarkdownRequest('x', 5).ok, false);
    assert.equal(v.validateMarkdownRequest('x', 'a'.repeat(v.MAX_MARKDOWN_BYTES + 1)).ok, false);
  });
});

describe('isMarkdownPath', () => {
  test('only .md paths', () => {
    assert.equal(v.isMarkdownPath('C:\\a\\b.md'), true);
    assert.equal(v.isMarkdownPath('/a/b.MD'), true);
    assert.equal(v.isMarkdownPath('/a/b.exe'), false);
    assert.equal(v.isMarkdownPath('/a/b.md.exe'), false);
    assert.equal(v.isMarkdownPath('/a/.md'), false);
    assert.equal(v.isMarkdownPath(''), false);
    assert.equal(v.isMarkdownPath(undefined), false);
  });
});

describe('buildIssueUrl', () => {
  test('builds from a configured origin and a valid key', () => {
    assert.deepEqual(v.buildIssueUrl('https://acme.atlassian.net', 'ABC-12'), {
      ok: true,
      value: 'https://acme.atlassian.net/browse/ABC-12',
    });
  });
  test('errors when not configured or invalid', () => {
    assert.deepEqual(v.buildIssueUrl(null, 'ABC-12'), { ok: false, error: 'NOT_CONFIGURED' });
    assert.equal(v.buildIssueUrl('https://acme.atlassian.net', 'x').ok, false);
    assert.equal(v.buildIssueUrl('http://acme.atlassian.net', 'ABC-1').ok, false);
  });
});
