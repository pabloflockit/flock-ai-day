const {
  buildIssueUrl,
  isHtmlPath,
  isMarkdownPath,
  validateCopyText,
  validateHtmlRequest,
  validateIssueKey,
  validateMarkdownRequest,
} = require('./bridge-validation.cjs');

/**
 * Main-process implementations of the preload bridge functions. Every argument is validated
 * here; results are plain `{ ok, error? }` objects so nothing sensitive crosses IPC.
 *
 * @param {{
 *   shell: { openExternal(url: string): Promise<void> },
 *   clipboard: { writeText(text: string): void },
 *   dialog: { showSaveDialog(win: any, options: any): Promise<{ canceled: boolean, filePath?: string }> },
 *   fs: { writeFileSync(path: string, content: string): void },
 *   getJiraBaseUrl: () => string | null | undefined,
 *   getWindow: () => any,
 * }} deps
 */
function createBridgeHandlers({ shell, clipboard, dialog, fs, getJiraBaseUrl, getWindow }) {
  return {
    async openInJira(issueKey) {
      const key = validateIssueKey(issueKey);
      if (!key.ok) return key;
      const url = buildIssueUrl(getJiraBaseUrl(), key.value);
      if (!url.ok) return url;
      await shell.openExternal(url.value);
      return { ok: true };
    },

    async copyText(text) {
      const valid = validateCopyText(text);
      if (!valid.ok) return valid;
      clipboard.writeText(valid.value);
      return { ok: true };
    },

    async saveMarkdown(suggestedName, content) {
      const valid = validateMarkdownRequest(suggestedName, content);
      if (!valid.ok) return valid;
      const result = await dialog.showSaveDialog(getWindow(), {
        defaultPath: valid.value.fileName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      // The user picks the folder, but only .md files are ever written.
      if (!isMarkdownPath(result.filePath)) return { ok: false, error: 'INVALID_PATH' };
      fs.writeFileSync(result.filePath, valid.value.content);
      return { ok: true };
    },

    async saveHtml(suggestedName, content) {
      const valid = validateHtmlRequest(suggestedName, content);
      if (!valid.ok) return valid;
      const result = await dialog.showSaveDialog(getWindow(), {
        defaultPath: valid.value.fileName,
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      // The user picks the folder, but only .html files are ever written.
      if (!isHtmlPath(result.filePath)) return { ok: false, error: 'INVALID_PATH' };
      fs.writeFileSync(result.filePath, valid.value.content);
      return { ok: true };
    },
  };
}

module.exports = { createBridgeHandlers };
