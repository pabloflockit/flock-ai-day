import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findAvailablePort } from '../proxy/find-available-port.mjs';

/** @returns {Promise<{ port: number, close: () => Promise<void> }>} */
function occupyEphemeralPort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('returns the start port when it is free', async () => {
  const held = await occupyEphemeralPort();
  const start = held.port;
  await held.close();
  assert.equal(await findAvailablePort(start), start);
});

test('skips an occupied port and returns the next free one', async () => {
  const held = await occupyEphemeralPort();
  try {
    const found = await findAvailablePort(held.port);
    assert.ok(found > held.port, `expected a port above ${held.port}, got ${found}`);
  } finally {
    await held.close();
  }
});

test('rejects when no port is free within maxAttempts', async () => {
  const held = await occupyEphemeralPort();
  try {
    await assert.rejects(findAvailablePort(held.port, { maxAttempts: 1 }), /No free port/);
  } finally {
    await held.close();
  }
});
