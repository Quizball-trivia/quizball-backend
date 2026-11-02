/**
 * Work that may never settle (a query on a connection that stopped answering), bounded by a deadline without letting
 * abandoned work pile up. A run that passes its deadline is rejected with `timeout(key)` but keeps running; until it
 * settles, every later run for the same key is refused at once with the same error instead of starting more work.
 *
 * Why: a JavaScript deadline only stops the wait, not the work. A database call keeps its admission slot
 * (src/db/admission.ts) until it settles, so a cache that retried after every deadline would stack one more stuck call
 * per retry until the process's whole admission budget was gone and unrelated queries were refused. With this guard no
 * run starts for a key while any of its abandoned runs is still pending: runs that overlapped (two callers at once) are
 * all tracked, and the key is released only when every one of them has settled.
 */
export function createDeadlineGuard(timeout: (key: string) => Error) {
  const abandoned = new Map<string, Set<Promise<unknown>>>();
  return {
    run<T>(key: string, ms: number, start: () => Promise<T>): Promise<T> {
      if (abandoned.has(key)) return Promise.reject(timeout(key));
      const work = start();
      // A late rejection of abandoned work must not surface as an unhandled rejection.
      work.catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const pending = abandoned.get(key) ?? new Set<Promise<unknown>>();
          pending.add(work);
          abandoned.set(key, pending);
          const settle = () => {
            pending.delete(work);
            if (pending.size === 0 && abandoned.get(key) === pending) abandoned.delete(key);
          };
          work.then(settle, settle);
          reject(timeout(key));
        }, ms);
        timer.unref?.();
      });
      return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
    },
    /** An abandoned run for `key` has not settled yet. */
    stuck: (key: string): boolean => abandoned.has(key),
  };
}
