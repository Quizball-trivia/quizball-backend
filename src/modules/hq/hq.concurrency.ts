/**
 * HQ endpoints read many small aggregates per request. Submitting them all at
 * once trips the DB admission gate (DB_INFLIGHT_LIMIT / DB_QUEUE_LIMIT →
 * queue_full → 503) and starves game traffic, so every HQ request keeps at
 * most this many queries in flight.
 */
export const HQ_DB_CONCURRENCY = 2;

type Task = () => Promise<unknown>;
type Results<T extends readonly Task[]> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/** Like Promise.all over thunks, with at most `limit` running at a time; results keep input order. */
export async function boundedAll<const T extends readonly Task[]>(tasks: T, limit = HQ_DB_CONCURRENCY): Promise<Results<T>> {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results as Results<T>;
}
