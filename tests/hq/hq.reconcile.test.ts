import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// The linked-guest reconcile batch (hq.reconcile_linked_guest_days) runs after the HQ pulse read, in its own
// transaction: the read never waits for it or fails with it.
const db = vi.hoisted(() => {
  const state = {
    log: [] as string[],
    reconcile: vi.fn(async (_maxDays: unknown): Promise<number> => 0),
  };
  const text = (s: TemplateStringsArray) => s.join('$').replace(/\s+/g, ' ').trim();
  const tx = (s: TemplateStringsArray, ...values: unknown[]) => {
    const q = text(s);
    state.log.push(`tx: ${q}`);
    if (q.includes('hq.reconcile_linked_guest_days')) return state.reconcile(values[0]).then((n) => [{ n }]);
    return Promise.resolve([]);
  };
  const sql = Object.assign(
    (s: TemplateStringsArray) => {
      state.log.push(text(s));
      return Promise.resolve([{ pulse: { days: 7 } }]);
    },
    {
      begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
        state.log.push('BEGIN');
        try {
          const out = await fn(tx);
          state.log.push('COMMIT');
          return out;
        } catch (err) {
          state.log.push('ROLLBACK');
          throw err;
        }
      },
    }
  );
  return { state, sql };
});
const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const env = vi.hoisted(() => ({ NODE_ENV: 'local' }));

vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));
vi.mock('../../src/core/logger.js', () => ({ logger }));
vi.mock('../../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...actual, config: new Proxy(actual.config, { get: (t, k) => (k === 'NODE_ENV' ? env.NODE_ENV : Reflect.get(t, k)) }) };
});

type RepoModule = typeof import('../../src/modules/hq/hq.repo.js');
let repo: RepoModule;

beforeEach(async () => {
  vi.useRealTimers();
  vi.resetModules();
  env.NODE_ENV = 'local';
  db.state.log.length = 0;
  db.state.reconcile.mockReset();
  db.state.reconcile.mockResolvedValue(0);
  logger.warn.mockReset();
  repo = await import('../../src/modules/hq/hq.repo.js');
});

describe('linked-guest reconcile batch', () => {
  it('runs in its own transaction with a bounded statement_timeout', async () => {
    db.state.reconcile.mockResolvedValue(3);
    expect(await repo.hqRepo.reconcileLinkedGuestDays(4)).toBe(3);
    expect(db.state.log).toEqual([
      'BEGIN',
      "tx: SET LOCAL statement_timeout = '15s'",
      'tx: SELECT hq.reconcile_linked_guest_days($::int) AS n',
      'COMMIT',
    ]);
    expect(db.state.reconcile).toHaveBeenCalledWith(4);
  });

  it('the pulse read returns without waiting for the batch it starts', async () => {
    db.state.reconcile.mockReturnValue(new Promise<number>(() => {}));
    expect(await repo.hqRepo.pulse(7)).toEqual({ days: 7 });
    expect(db.state.log[0]).toBe('SELECT hq.pulse($) AS pulse');
    expect(db.state.reconcile).toHaveBeenCalledTimes(1);
    expect(db.state.reconcile).toHaveBeenCalledWith(4);
  });

  it('a batch that fails (e.g. statement timeout) is only logged; the read still succeeds', async () => {
    const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    db.state.reconcile.mockRejectedValue(timeout);
    expect(await repo.hqRepo.pulse(7)).toEqual({ days: 7 });
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith({ err: timeout }, 'hq: linked-guest reconcile failed'));
    expect(db.state.log).toContain('ROLLBACK');
  });

  it('starts at most one batch a minute per replica, never two at once', async () => {
    let finish!: (n: number) => void;
    db.state.reconcile.mockReturnValueOnce(new Promise<number>((resolve) => { finish = resolve; }));
    const first = repo.reconcileLinkedGuestsInBackground(1_000);
    expect(first).not.toBeNull();
    expect(repo.reconcileLinkedGuestsInBackground(70_000)).toBeNull();
    finish(4);
    await first;
    expect(repo.reconcileLinkedGuestsInBackground(60_999)).toBeNull();
    const second = repo.reconcileLinkedGuestsInBackground(61_000);
    expect(second).not.toBeNull();
    await second;
    expect(db.state.reconcile).toHaveBeenCalledTimes(2);
  });

  it('pulse reads for other windows in the same minute do not start more batches', async () => {
    await repo.hqRepo.pulse(7);
    await repo.hqRepo.pulse(14);
    await repo.hqRepo.pulse(90);
    expect(db.state.log.filter((q) => q.startsWith('SELECT hq.pulse'))).toHaveLength(3);
    expect(db.state.reconcile).toHaveBeenCalledTimes(1);
  });

  it('after a batch that found nothing stale, the next one waits ten minutes', async () => {
    await repo.reconcileLinkedGuestsInBackground(1_000);
    expect(repo.reconcileLinkedGuestsInBackground(61_000)).toBeNull();
    expect(repo.reconcileLinkedGuestsInBackground(600_999)).toBeNull();
    await repo.reconcileLinkedGuestsInBackground(601_000);
    expect(db.state.reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('linked-guest worker', () => {
  type WorkerModule = typeof import('../../src/modules/hq/hq.linked-guests.worker.js');
  const load = async (nodeEnv: string): Promise<WorkerModule> => {
    env.NODE_ENV = nodeEnv;
    vi.useFakeTimers({ now: 0 });
    return import('../../src/modules/hq/hq.linked-guests.worker.js');
  };

  it('runs a batch every minute on staging and prod while days are stale, without any HQ read', async () => {
    db.state.reconcile.mockResolvedValue(4);
    const worker = await load('prod');
    worker.startHqLinkedGuestWorker();
    expect(db.state.reconcile).not.toHaveBeenCalled();
    for (let minute = 1; minute <= 3; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(db.state.reconcile).toHaveBeenCalledTimes(minute);
    }
    expect(db.state.log.filter((q) => q.startsWith('SELECT hq.pulse'))).toHaveLength(0);
    await worker.stopHqLinkedGuestWorker();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(db.state.reconcile).toHaveBeenCalledTimes(3);
  });

  it('shutdown waits for the running batch and starts no more, from the worker or a read', async () => {
    let finish!: (n: number) => void;
    db.state.reconcile.mockReturnValueOnce(new Promise<number>((resolve) => { finish = resolve; }));
    const worker = await load('staging');
    worker.startHqLinkedGuestWorker();
    await vi.advanceTimersByTimeAsync(60_000);
    let stopped = false;
    const stopping = worker.stopHqLinkedGuestWorker().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish(4);
    await stopping;
    await repo.hqRepo.pulse(7);
    expect(db.state.reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not run locally', async () => {
    const worker = await load('local');
    worker.startHqLinkedGuestWorker();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(db.state.reconcile).not.toHaveBeenCalled();
    await worker.stopHqLinkedGuestWorker();
  });
});
