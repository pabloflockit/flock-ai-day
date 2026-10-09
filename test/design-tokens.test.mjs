// Guards the Flock Design System rule: UI styles use only documented tokens through CSS variables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
const tokenFiles = new Set([
  join('src', 'styles', 'flock', 'tokens.css'),
  join('src', 'styles', 'flock', 'tokens-app.css'),
]);

function listStyleFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listStyleFiles(full));
    else if (/\.(s?css)$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('skill tokens define the brand, surface, font and gradient variables', () => {
  const css = readFileSync(join(root, 'src', 'styles', 'flock', 'tokens.css'), 'utf8');
  for (const name of ['--brand', '--accent', '--panel', '--surface', '--nav-gradient', '--font-sans', '--font-mono']) {
    assert.match(css, new RegExp(`${name}\\s*:`), `${name} missing from tokens.css`);
  }
});

test('app tokens name the documented state triplets as variables', () => {
  const css = readFileSync(join(root, 'src', 'styles', 'flock', 'tokens-app.css'), 'utf8');
  for (const state of ['pending', 'progress', 'blocked', 'done']) {
    for (const part of ['bg', 'fg', 'bar']) {
      assert.match(css, new RegExp(`--state-${state}-${part}\\s*:`), `--state-${state}-${part} missing`);
    }
  }
});

test('global styles load the token files', () => {
  const css = readFileSync(join(srcDir, 'styles.scss'), 'utf8');
  assert.match(css, /styles\/flock\/tokens(\.css)?['"]/);
  assert.match(css, /styles\/flock\/tokens-app(\.css)?['"]/);
});

test('styles outside the token files use no raw colors or font stacks', () => {
  const offenders = [];
  for (const file of listStyleFiles(srcDir)) {
    const rel = relative(root, file);
    if (tokenFiles.has(rel) || tokenFiles.has(rel.split('/').join(sep))) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line)) offenders.push(`${rel}:${i + 1} hex color`);
      if (/\b(rgba?|hsla?)\s*\(/.test(line)) offenders.push(`${rel}:${i + 1} color function`);
      const font = line.match(/font-family\s*:\s*([^;]+)/);
      if (font && !/^\s*(var\(--|inherit)/.test(font[1])) offenders.push(`${rel}:${i + 1} font-family`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('dark theme: app tokens have html.dark values and the app starts dark', () => {
  const css = readFileSync(join(root, 'src', 'styles', 'flock', 'tokens-app.css'), 'utf8');
  const dark = css.match(/html\.dark\s*\{([\s\S]*?)\}/);
  assert.ok(dark, 'tokens-app.css needs an html.dark block');
  for (const state of ['pending', 'progress', 'blocked', 'done']) {
    for (const part of ['bg', 'fg']) {
      assert.match(dark[1], new RegExp(`--state-${state}-${part}\\s*:`), `dark --state-${state}-${part} missing`);
    }
  }
  for (const name of ['--text-strong', '--text-label', '--brand-hover', '--brand-soft-hover', '--row-border', '--overlay-backdrop']) {
    assert.match(css, new RegExp(`:root[\\s\\S]*${name}\\s*:`), `${name} missing from :root`);
    assert.match(dark[1], new RegExp(`${name}\\s*:`), `dark ${name} missing`);
  }
  const html = readFileSync(join(srcDir, 'index.html'), 'utf8');
  assert.match(html, /<html[^>]*class="dark"/, 'dark is the default theme (no light flash on start)');
});

test('text never uses --brand-dark, which stays dark in the dark theme', () => {
  const offenders = [];
  for (const file of listStyleFiles(srcDir)) {
    const rel = relative(root, file);
    if (tokenFiles.has(rel) || tokenFiles.has(rel.split('/').join(sep))) continue;
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (/(^|[^-])color\s*:\s*var\(--brand-dark\)/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
  }
  assert.deepEqual(offenders, [], 'use var(--text-strong) for strong text');
});
