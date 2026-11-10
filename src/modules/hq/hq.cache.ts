// Per-replica TTL cache with single-flight: concurrent callers for the same key
// share one computation, and a value is reused until it is `ttlMs` old. Only
// successful results are cached. For dashboard aggregates that change slowly
// and are polled by several open tabs.
export function ttlCache<K, V>(ttlMs: number, now: () => number = Date.now) {
  const values = new Map<K, { at: number; value: V }>();
  const inflight = new Map<K, Promise<V>>();
  return {
    get(key: K, compute: () => Promise<V>): Promise<V> {
      const hit = values.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
      const running = inflight.get(key);
      if (running) return running;
      const p = compute()
        .then((value) => {
          values.set(key, { at: now(), value });
          if (values.size > 200) values.delete(values.keys().next().value as K);
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
    clear(): void {
      values.clear();
      inflight.clear();
    },
  };
}
