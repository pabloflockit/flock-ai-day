import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createDemoSecrets } = createRequire(import.meta.url)('../electron/secrets.cjs');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').toString('hex').split('').reverse().join('')),
  decryptString: (b) => Buffer.from(b.toString().split('').reverse().join(''), 'hex').toString('utf8'),
};

function fakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync: () => {},
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, Buffer.from(data)),
    renameSync: (from, to) => {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

test('demo secrets serve the fixed dummy token and never persist a token or key', () => {
  const fs = fakeFs();
  const secrets = createDemoSecrets({ safeStorage, fs, dir: '/user-data/demo', jiraToken: 'dummy' });
  assert.equal(secrets.getJiraToken(), 'dummy');
  secrets.setJiraToken('real-looking-token');
  secrets.setAiKey('real-looking-key');
  assert.equal(secrets.getJiraToken(), 'dummy');
  assert.equal(secrets.getAiKey(), null);
  assert.deepEqual([...fs.files.keys()], []);
});

test('demo data key is real (safeStorage) but lives in the demo directory only', () => {
  const fs = fakeFs();
  const secrets = createDemoSecrets({ safeStorage, fs, dir: '/user-data/demo', jiraToken: 'dummy' });
  const key = secrets.getDataKey();
  assert.equal(key.length, 32);
  const files = [...fs.files.keys()].map((p) => p.replaceAll('\\', '/'));
  assert.deepEqual(files, ['/user-data/demo/data-key.enc']);
  assert.deepEqual(createDemoSecrets({ safeStorage, fs, dir: '/user-data/demo', jiraToken: 'dummy' }).getDataKey(), key);
});
