import { createServer } from 'node:net';

/**
 * Finds the first TCP port that can be bound on `host`, scanning upward from
 * `startPort`, so the proxy does not fail with EADDRINUSE when another process
 * already holds the default port.
 *
 * @param {number} startPort
 * @param {{ host?: string, maxAttempts?: number }} [options]
 * @returns {Promise<number>}
 */
export function findAvailablePort(startPort, { host = '127.0.0.1', maxAttempts = 200 } = {}) {
  return attempt(startPort);

  /** @param {number} port @returns {Promise<number>} */
  function attempt(port) {
    if (port >= startPort + maxAttempts) {
      return Promise.reject(
        new Error(`No free port found between ${startPort} and ${startPort + maxAttempts - 1}.`),
      );
    }

    return new Promise((resolve, reject) => {
      const probe = createServer();

      probe.once('error', (/** @type {NodeJS.ErrnoException} */ error) => {
        if (error.code === 'EADDRINUSE') {
          resolve(attempt(port + 1));
          return;
        }
        reject(error);
      });

      probe.listen(port, host, () => {
        probe.close(() => resolve(port));
      });
    });
  }
}
