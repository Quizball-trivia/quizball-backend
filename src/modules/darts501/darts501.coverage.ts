import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';

const PAGE = 20_000;
const FAILED_RETRY_MS = 5_000;

/**
 * The footballers a coverage set holds complete numbers for (darts501_coverage): only they can be a miss. Loaded once per
 * process and kept (a set is a few MB and there are only a handful); read in pages by id with plain statements.
 */
const held = new Map<string, Promise<ReadonlySet<string>>>();
const failed = new Map<string, { until: number; error: unknown }>();

async function load(id: string): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  let after = '';
  for (;;) {
    const page = await sql<Array<{ pid: string }>>`SELECT pid FROM darts501_coverage WHERE coverage_id = ${id} AND pid > ${after} ORDER BY pid LIMIT ${PAGE}`;
    for (const row of page) out.add(row.pid);
    if (page.length < PAGE) break;
    after = page[page.length - 1].pid;
  }
  // An empty set would turn every real footballer into a free answer: refuse it like an empty release.
  if (out.size === 0) throw new Error(`darts501_coverage_empty:${id}`);
  logger.info({ coverage: id, players: out.size }, 'Darts 501 coverage loaded');
  return out;
}

export const darts501Coverage = {
  get(id: string): Promise<ReadonlySet<string>> {
    const cached = held.get(id);
    if (cached) return cached;
    const failure = failed.get(id);
    if (failure && failure.until > Date.now()) return Promise.reject(failure.error);
    failed.delete(id);
    const loading = load(id);
    held.set(id, loading);
    loading.catch((error: unknown) => {
      if (held.get(id) !== loading) return;
      held.delete(id);
      failed.set(id, { until: Date.now() + FAILED_RETRY_MS, error });
    });
    return loading;
  },
  loaded: (id: string): boolean => held.has(id),
  /** Tests only. */
  set(id: string, pids: Iterable<string>): void {
    held.set(id, Promise.resolve(new Set(pids)));
  },
  /** Tests only. */
  clear(): void {
    held.clear();
    failed.clear();
  },
};
