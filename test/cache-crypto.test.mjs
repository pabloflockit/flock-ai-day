import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptJson, decryptJson } from '../proxy/cache/crypto.mjs';

const key = randomBytes(32);
const aad = 'datasets|p1|projectIssues|abc';

test('roundtrip returns the original value, with a fresh 12-byte IV per write', () => {
  const a = encryptJson(key, { hello: 'wörld', n: [1, 2] }, aad);
  const b = encryptJson(key, { hello: 'wörld', n: [1, 2] }, aad);
  assert.equal(a.iv.length, 12);
  assert.equal(a.tag.length, 16);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.payloadEnc, b.payloadEnc);
  assert.deepEqual(decryptJson(key, a, aad), { hello: 'wörld', n: [1, 2] });
});

test('ciphertext does not contain the plaintext', () => {
  const sealed = encryptJson(key, { marker: 'PLAINTEXT-MARKER-123' }, aad);
  assert.ok(!Buffer.from(sealed.payloadEnc).includes('PLAINTEXT-MARKER-123'));
});

const expectInvalid = (fn) =>
  assert.throws(fn, (error) => error.code === 'DATA_KEY_INVALID' && !/PLAINTEXT/.test(error.message));

test('tampered ciphertext, tag or iv fail as DATA_KEY_INVALID', () => {
  const sealed = encryptJson(key, { a: 1 }, aad);
  for (const field of ['payloadEnc', 'tag', 'iv']) {
    const copy = { ...sealed, [field]: Buffer.from(sealed[field]) };
    copy[field][0] ^= 0xff;
    expectInvalid(() => decryptJson(key, copy, aad));
  }
});

test('AAD mismatch (ciphertext moved to another row) fails', () => {
  const sealed = encryptJson(key, { a: 1 }, aad);
  expectInvalid(() => decryptJson(key, sealed, 'datasets|p2|projectIssues|abc'));
});

test('wrong key fails as DATA_KEY_INVALID', () => {
  const sealed = encryptJson(key, { a: 1 }, aad);
  expectInvalid(() => decryptJson(randomBytes(32), sealed, aad));
});

test('a key that is not 32 bytes is rejected up front', () => {
  assert.throws(() => encryptJson(Buffer.alloc(16), {}, aad), /32 bytes/);
});
