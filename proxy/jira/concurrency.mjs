export const DEFAULT_CONCURRENCY = 6;

/**
 * Runs `fn` over `items` with at most `limit` calls in flight. Results keep the input order and
 * are settled-style (`{ status: 'fulfilled', value } | { status: 'rejected', reason }`), so one
 * failing item never hides the others.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {number | undefined} limit
 * @param {(item: T, index: number) => Promise<R> | R} fn
 * @returns {Promise<Array<PromiseSettledResult<R>>>}
 */
export async function mapWithConcurrency(items, limit = DEFAULT_CONCURRENCY, fn) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be an integer >= 1.');
  }
  /** @type {Array<PromiseSettledResult<R>>} */
  const results = new Array(items.length);
  let cursor = 0;

  async function drain() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}
