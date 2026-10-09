// Pure argument validation for the preload bridge. The main process runs every renderer
// argument through these before acting; the renderer is never trusted.

const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const MAX_ISSUE_KEY_LENGTH = 64;
const MAX_COPY_TEXT_LENGTH = 200_000;
const MAX_FILE_NAME_LENGTH = 100;
const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_FILE_NAME = 'report';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** @param {unknown} key */
function validateIssueKey(key) {
  if (
    typeof key !== 'string' ||
    key.length > MAX_ISSUE_KEY_LENGTH ||
    !ISSUE_KEY_PATTERN.test(key)
  ) {
    return { ok: false, error: 'INVALID_ISSUE_KEY' };
  }
  return { ok: true, value: key };
}

/** @param {unknown} text */
function validateCopyText(text) {
  if (typeof text !== 'string' || text.length > MAX_COPY_TEXT_LENGTH) {
    return { ok: false, error: 'INVALID_TEXT' };
  }
  return { ok: true, value: text };
}

/**
 * Reduces a suggested name to a safe base name and forces the given extension (`.md` / `.html`).
 * @param {unknown} input
 * @param {string} extension
 */
function sanitizeFileName(input, extension) {
  let name = typeof input === 'string' ? input : '';
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_');
  name = name.replace(/\.[A-Za-z0-9]{1,8}$/, ''); // drop any existing extension
  name = name.replace(/[. ]+$/, '').trim();
  if (name === '') name = DEFAULT_FILE_NAME;
  if (WINDOWS_RESERVED.test(name)) name = `${name}_`;
  return `${name.slice(0, MAX_FILE_NAME_LENGTH - extension.length)}${extension}`;
}

/** @param {unknown} input */
const sanitizeMarkdownFileName = (input) => sanitizeFileName(input, '.md');

/** @param {unknown} input */
const sanitizeHtmlFileName = (input) => sanitizeFileName(input, '.html');

/**
 * @param {unknown} suggestedName
 * @param {unknown} content
 */
function validateMarkdownRequest(suggestedName, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
    return { ok: false, error: 'INVALID_CONTENT' };
  }
  return { ok: true, value: { fileName: sanitizeMarkdownFileName(suggestedName), content } };
}

/**
 * @param {unknown} suggestedName
 * @param {unknown} content
 */
function validateHtmlRequest(suggestedName, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_HTML_BYTES) {
    return { ok: false, error: 'INVALID_CONTENT' };
  }
  return { ok: true, value: { fileName: sanitizeHtmlFileName(suggestedName), content } };
}

/** @param {unknown} filePath */
function isHtmlPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  return /^.+\.html$/i.test(base);
}

/** @param {unknown} filePath */
function isMarkdownPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const base = filePath.split(/[\\/]/).pop() ?? '';
  return /^.+\.md$/i.test(base);
}

/**
 * Builds the browse URL from the configured Jira origin (task 4 stores it); the renderer only supplies a key.
 * @param {string | null | undefined} jiraBaseUrl
 * @param {unknown} issueKey
 */
function buildIssueUrl(jiraBaseUrl, issueKey) {
  if (!jiraBaseUrl) return { ok: false, error: 'NOT_CONFIGURED' };
  const key = validateIssueKey(issueKey);
  if (!key.ok) return key;
  // The stored base URL was already vetted by shared/jira-url.mjs when it was configured;
  // this re-checks only the scheme (that module is ESM and main is CJS).
  let base;
  try {
    base = new URL(jiraBaseUrl);
  } catch {
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  if (base.protocol !== 'https:') return { ok: false, error: 'NOT_CONFIGURED' };
  return { ok: true, value: `https://${base.host}/browse/${key.value}` };
}

module.exports = {
  MAX_COPY_TEXT_LENGTH,
  MAX_FILE_NAME_LENGTH,
  MAX_MARKDOWN_BYTES,
  MAX_HTML_BYTES,
  validateIssueKey,
  validateCopyText,
  sanitizeMarkdownFileName,
  validateMarkdownRequest,
  isMarkdownPath,
  sanitizeHtmlFileName,
  validateHtmlRequest,
  isHtmlPath,
  buildIssueUrl,
};
