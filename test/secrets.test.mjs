import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createSecrets } = createRequire(import.meta.url)('../electron/secrets.cjs');

function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    // Reversible, obviously-not-plaintext "encryption" for the fake.
    encryptString: (s) =>
      Buffer.from(Buffer.from(s, 'utf8').toString('hex').split('').reverse().join('')),
    decryptString: (b) =>
      Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString('utf8'),
  };
}

function fakeFs() {
  const files = new Map();
  const enoent = (p) => Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
  return {
    files,
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (!files.has(p)) throw enoent(p);
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, Buffer.from(data)),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

const make = () => {
  const fs = fakeFs();
  const safeStorage = fakeSafeStorage();
  const secrets = createSecrets({ safeStorage, fs, dir: '/user-data' });
  return { fs, safeStorage, secrets };
};

describe('secrets factory', () => {
  test('token and AI key round-trip and are not stored in plaintext', () => {
    const { fs, secrets } = make();
    assert.equal(secrets.getJiraToken(), null);
    assert.equal(secrets.getAiKey(), null);
    secrets.setJiraToken('jira-token-value');
    secrets.setAiKey('ai-key-value');
    assert.equal(secrets.getJiraToken(), 'jira-token-value');
    assert.equal(secrets.getAiKey(), 'ai-key-value');
    for (const content of fs.files.values()) {
      assert.ok(!content.toString().includes('jira-token-value'));
      assert.ok(!content.toString().includes('ai-key-value'));
    }
  });

  test('data key is 256-bit, generated once, persisted and reused across instances', () => {
    const { fs, safeStorage, secrets } = make();
    const first = secrets.getDataKey();
    assert.equal(first.length, 32);
    assert.deepEqual(secrets.getDataKey(), first);
    const second = createSecrets({ safeStorage, fs, dir: '/user-data' });
    assert.deepEqual(second.getDataKey(), first);
    assert.equal(fs.files.size, 1);
  });

  test('data key is not stored in plaintext', () => {
    const { fs, secrets } = make();
    const key = secrets.getDataKey();
    for (const content of fs.files.values()) {
      assert.ok(!content.includes(key));
    }
  });

  test('a corrupt data key file fails clearly and is not overwritten', () => {
    const { fs, safeStorage, secrets } = make();
    secrets.getDataKey();
    const [path] = [...fs.files.keys()];
    fs.files.set(path, Buffer.from('garbage'));
    const restarted = createSecrets({ safeStorage, fs, dir: '/user-data' });
    assert.throws(() => restarted.getDataKey(), /data key/i);
    assert.equal(fs.files.get(path).toString(), 'garbage');
  });

  test('encryption unavailable fails clearly at creation and never writes plaintext', () => {
    const fs = fakeFs();
    assert.throws(
      () => createSecrets({ safeStorage: fakeSafeStorage({ available: false }), fs, dir: '/d' }),
      /encryption is not available/i,
    );
    assert.equal(fs.files.size, 0);
  });

  test('encryption becoming unavailable later also fails (no fallback)', () => {
    const fs = fakeFs();
    const safeStorage = fakeSafeStorage();
    const secrets = createSecrets({ safeStorage, fs, dir: '/d' });
    safeStorage.isEncryptionAvailable = () => false;
    assert.throws(() => secrets.setJiraToken('abc'), /encryption is not available/i);
    assert.equal(fs.files.size, 0);
  });

  test('error messages never contain secret values', () => {
    const { secrets, safeStorage } = make();
    safeStorage.encryptString = (s) => {
      throw new Error(`boom ${s}`);
    };
    try {
      secrets.setJiraToken('very-secret');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(!String(e.message).includes('very-secret'));
    }
  });

  test('rejects empty values', () => {
    const { secrets } = make();
    assert.throws(() => secrets.setJiraToken(''), /non-empty/);
    assert.throws(() => secrets.setAiKey(42), /non-empty/);
  });
});
