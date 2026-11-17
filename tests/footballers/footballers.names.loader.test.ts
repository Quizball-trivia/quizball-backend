import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { newestRelease, universe, activeGreekVersion, greekIndex, installed, awaited, stopped, pendingUntil } = vi.hoisted(() => ({
  newestRelease: vi.fn<() => Promise<string | null>>(),
  universe: vi.fn<(releaseId: string) => Promise<{ named: () => string[] }>>(),
  activeGreekVersion: vi.fn<() => Promise<string | null>>(),
  greekIndex: vi.fn<(version: string) => Promise<{ named: () => string[] }>>(),
  installed: [] as Array<string | null>,
  awaited: { count: 0 },
  stopped: { count: 0 },
  pendingUntil: [] as number[],
}));
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/modules/footballers/footballers.repo.js', () => ({ footballersRepo: { newestRelease } }));
vi.mock('../../src/modules/footballers/footballers.service.js', () => ({ footballersService: { universe } }));
vi.mock('../../src/modules/footballers/footballers.greek.js', () => ({
  activeGreekVersion, greekIndex, greekView: (_u: unknown, index: { named: () => string[] }) => index,
}));
vi.mock('../../src/modules/footballers/footballers.names.js', () => ({
  // Records "<release>" or "<release>+<greek>" (or "+loading"): what the matchers would read with.
  footballerNamesOf: (u: { named: () => string[] }, greek: { named: () => string[] } | 'loading' | null, options: { pendingUntil: number }) => {
    pendingUntil.push(options.pendingUntil);
    return { holders: () => [[u.named()[0], greek === 'loading' ? 'loading' : greek?.named()[0]].filter(Boolean).join('+')] };
  },
  installFootballerNames: (names: { holders: () => string[] } | null) => { installed.push(names ? names.holders()[0] : null); },
  awaitFootballerNames: () => { awaited.count += 1; },
  stopAwaitingFootballerNames: () => { stopped.count += 1; },
}));

const loader = () => import('../../src/modules/footballers/footballers.names.loader.js');

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  installed.length = 0;
  awaited.count = 0;
  stopped.count = 0;
  pendingUntil.length = 0;
  for (const mock of [newestRelease, universe, activeGreekVersion, greekIndex]) mock.mockReset();
  universe.mockImplementation(async (id) => ({ named: () => [id] }));
  greekIndex.mockImplementation(async (version) => ({ named: () => [version] }));
  activeGreekVersion.mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); });

describe('footballer names loader', () => {
  it('a stalled load does not block the next refresh, and an older load finishing late never replaces a newer release', async () => {
    const { startFootballerNamesLoader, FOOTBALLER_NAMES_REFRESH_MS } = await loader();
    let finishFirst!: () => void;
    newestRelease.mockResolvedValueOnce('r1').mockResolvedValue('r2');
    universe.mockImplementation((id) => (id === 'r1'
      ? new Promise((resolve) => { finishFirst = () => resolve({ named: () => ['r1'] }); })
      : Promise.resolve({ named: () => [id] })));

    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_REFRESH_MS);
    expect(installed).toEqual(['r2']);
    finishFirst();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_REFRESH_MS);
    expect(installed).toEqual(['r2']);
  });

  it('holds typos back from the start, and retries a failed first load within seconds, not the ten-minute interval', async () => {
    const { startFootballerNamesLoader, FOOTBALLER_NAMES_RETRY_MS } = await loader();
    newestRelease.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down')).mockResolvedValue('r1');
    startFootballerNamesLoader();
    expect(awaited.count).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(installed).toEqual([]);
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_RETRY_MS[0]);
    expect(installed).toEqual([]);
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_RETRY_MS[0] * 2);
    expect(installed).toEqual(['r1']);
  });

  it('with no release the matchers judge without the veto (as before), not held back', async () => {
    const { startFootballerNamesLoader } = await loader();
    newestRelease.mockResolvedValue(null);
    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(0);
    expect(installed).toEqual([null]);
  });

  it('reads Greek texts with the active Greek names; a Greek load that fails holds Greek typos back and is retried soon', async () => {
    const { startFootballerNamesLoader, FOOTBALLER_NAMES_RETRY_MS } = await loader();
    newestRelease.mockResolvedValue('r1');
    activeGreekVersion.mockResolvedValue('el-1');
    greekIndex.mockRejectedValueOnce(new Error('incomplete'));
    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(0);
    expect(installed).toEqual(['r1+loading']);
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_RETRY_MS[0]);
    expect(installed).toEqual(['r1+loading', 'r1+el-1']);
  });

  it('a database without the Greek tables has no Greek names (nothing held back)', async () => {
    const { startFootballerNamesLoader } = await loader();
    newestRelease.mockResolvedValue('r1');
    activeGreekVersion.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(0);
    expect(installed).toEqual(['r1']);
  });

  it('a load that never settles holds typos back for the gate only, then the matchers judge without the veto', async () => {
    const { startFootballerNamesLoader, FOOTBALLER_NAMES_GATE_MS } = await loader();
    newestRelease.mockResolvedValue('r1');
    universe.mockImplementation(() => new Promise(() => undefined));
    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_GATE_MS - 1);
    expect(stopped.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped.count).toBe(1);
    expect(installed).toEqual([]);
  });

  it('a Greek load that never settles does not hold the Latin names back, and Greek typos only for the gate', async () => {
    const { startFootballerNamesLoader, FOOTBALLER_NAMES_GATE_MS, FOOTBALLER_NAMES_STEP_MS } = await loader();
    newestRelease.mockResolvedValue('r1');
    activeGreekVersion.mockResolvedValue('el-1');
    greekIndex.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    startFootballerNamesLoader();
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_STEP_MS);
    expect(installed).toEqual(['r1+loading']);
    // The installed names stop holding Greek typos back at the gate by themselves, whatever later loads do.
    expect(pendingUntil[0]).toBe(started + FOOTBALLER_NAMES_GATE_MS);
    await vi.advanceTimersByTimeAsync(FOOTBALLER_NAMES_GATE_MS + FOOTBALLER_NAMES_STEP_MS);
    expect(installed.at(-1)).toBe('r1');
  });
});
