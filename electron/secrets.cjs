const nodeCrypto = require('node:crypto');
const path = require('node:path');

const DATA_KEY_BYTES = 32;
const FILES = Object.freeze({
  jiraToken: 'jira-token.enc',
  aiKey: 'ai-key.enc',
  dataKey: 'data-key.enc',
});

/**
 * Secret storage backed by Electron `safeStorage` (OS-bound encryption), one file per secret
 * in `dir` (app.getPath('userData')). Dependencies are injected so it is testable with fakes.
 *
 * There is no plaintext fallback: if `safeStorage` cannot encrypt, every operation fails.
 * Error messages are static and never include secret values.
 *
 * Only the in-process proxy receives this object; it is never exposed to the renderer.
 *
 * @param {{
 *   safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string },
 *   fs: Pick<typeof import('node:fs'), 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync'>,
 *   dir: string,
 *   randomBytes?: (n: number) => Buffer,
 * }} deps
 */
function createSecrets({ safeStorage, fs, dir, randomBytes = nodeCrypto.randomBytes }) {
  function assertAvailable() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Secure storage encryption is not available on this system; secrets cannot be stored.',
      );
    }
  }
  assertAvailable();

  const filePath = (name) => path.join(dir, name);

  /** @returns {string | null} */
  function readSecret(name, label) {
    assertAvailable();
    let encrypted;
    try {
      encrypted = fs.readFileSync(filePath(name));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new Error(`Could not read the stored ${label}.`);
    }
    try {
      return safeStorage.decryptString(encrypted);
    } catch {
      throw new Error(`The stored ${label} could not be decrypted.`);
    }
  }

  function writeSecret(name, value, label) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`The ${label} must be a non-empty string.`);
    }
    assertAvailable();
    let encrypted;
    try {
      encrypted = safeStorage.encryptString(value);
    } catch {
      throw new Error(`The ${label} could not be encrypted.`);
    }
    fs.mkdirSync(dir, { recursive: true });
    // Write-then-rename so a crash never leaves a truncated secret file.
    const target = filePath(name);
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, encrypted, { mode: 0o600 });
    fs.renameSync(temp, target);
  }

  /** @type {Buffer | undefined} */
  let cachedDataKey;

  function getDataKey() {
    if (cachedDataKey) return Buffer.from(cachedDataKey);
    const stored = readSecret(FILES.dataKey, 'data key');
    if (stored !== null) {
      const key = Buffer.from(stored, 'base64');
      // Never regenerate over an existing file: that would orphan the encrypted database.
      if (key.length !== DATA_KEY_BYTES) throw new Error('The stored data key is invalid.');
      cachedDataKey = key;
    } else {
      const key = randomBytes(DATA_KEY_BYTES);
      writeSecret(FILES.dataKey, key.toString('base64'), 'data key');
      cachedDataKey = key;
    }
    return Buffer.from(cachedDataKey);
  }

  return {
    getJiraToken: () => readSecret(FILES.jiraToken, 'Jira token'),
    setJiraToken: (token) => writeSecret(FILES.jiraToken, token, 'Jira token'),
    getAiKey: () => readSecret(FILES.aiKey, 'AI key'),
    setAiKey: (key) => writeSecret(FILES.aiKey, key, 'AI key'),
    getDataKey,
  };
}

module.exports = { createSecrets };
