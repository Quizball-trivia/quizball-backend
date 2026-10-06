import { describe, expect, it, vi } from 'vitest';

const { calls } = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }> }));

/** Captures the SQL the repo sends instead of running it; `unsafe` fragments are inlined as text. */
vi.mock('../../src/db/index.js', () => {
  const render = (strings: TemplateStringsArray, values: unknown[]) => strings.reduce((text, part, i) => {
    const value = values[i - 1] as { unsafe?: string; fragment?: string } | undefined;
    const slot = value?.unsafe ?? value?.fragment ?? '$?';
    return i === 0 ? part : `${text}${slot}${part}`;
  });
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = render(strings, values);
      calls.push({ text, values: values.filter((v) => !(v && typeof v === 'object' && ('unsafe' in v || 'fragment' in v))) });
      return Object.assign(Promise.resolve([]), { fragment: text });
    },
    { json: (value: unknown) => value, unsafe: (text: string) => ({ unsafe: text }), begin: vi.fn() },
  );
  return { sql, withStatementTimeout: vi.fn((fn: (tx: unknown) => unknown) => fn(sql)) };
});

const { pistasRepo } = await import('../../src/modules/pistas/pistas.repo.js');
const { sql, withStatementTimeout } = await import('../../src/db/index.js');
const tx = sql as never;
const last = () => calls.at(-1)!;
const state = { v: 1 as const, r: 0, n: 1, g: 0, c: null, s: null, res: [], done: false };

describe('pistas repo SQL', () => {
  it('every run read carries the database clock against the row\'s closes_at', async () => {
    await pistasRepo.lockRun(tx, 'run-1');
    expect(last().text).toMatch(/closes_at, clock_timestamp\(\) >= closes_at AS closed FROM pistas_runs WHERE id = \$\? FOR UPDATE/);
  });

  it('the UPDATE carries the Buenos Aires cutoff (the row\'s closes_at) for ranked rows only, at statement time, and the stored content version', async () => {
    await pistasRepo.saveState(tx, 'run-1', { state, stateVersion: 4, contentVersion: 11, completion: { score: 42, solved: 5 } });
    const { text, values } = last();
    expect(text).toMatch(/UPDATE pistas_runs/);
    expect(text).toMatch(/done = \$\?, score = \$\?, solved = \$\?/);
    expect(text).toMatch(/completed_at = CASE WHEN \$\? THEN clock_timestamp\(\) END/);
    expect(text).toMatch(/WHERE id = \$\? AND \(NOT ranked OR clock_timestamp\(\) < closes_at\)\s+AND EXISTS \(SELECT 1 FROM pistas_days d WHERE d\.day = pistas_runs\.day AND d\.content_version = \$\?\)/);
    expect(text).not.toMatch(/\bnow\(\)/);
    expect(values).toEqual(expect.arrayContaining([42, 5, 11, 'run-1']));
  });

  it('gameplay share-locks the day row, which a seed correcting it must wait for (FOR UPDATE)', async () => {
    await pistasRepo.lockDay(tx, '2026-09-29');
    expect(last().text).toMatch(/SELECT content_version FROM pistas_days WHERE day = \$\? FOR SHARE/);
    await pistasRepo.dayVersion(tx, '2026-09-29');
    expect(last().text).not.toMatch(/FOR (SHARE|UPDATE)/);
  });

  it('a closed ranked run is unranked only by the database clock, and only while unfinished', async () => {
    await pistasRepo.unrankClosedRun(tx, 'run-1');
    expect(last().text).toMatch(/SET ranked = false\s+WHERE id = \$\? AND ranked AND NOT done AND clock_timestamp\(\) >= closes_at/);
  });

  it('a rebase moves an unfinished run onto the stored content only, with the given state, bumps its version and unranks it', async () => {
    await pistasRepo.rebaseRun(tx, 'run-1', 12, state);
    const { text } = last();
    expect(text).toMatch(/SET content_version = \$\?, state = \$\?, ranked = false, state_version = state_version \+ 1/);
    expect(text).toMatch(/WHERE id = \$\? AND NOT done AND content_version <> \$\?\s+AND EXISTS \(SELECT 1 FROM pistas_days d WHERE d\.day = pistas_runs\.day AND d\.content_version = \$\?\)/);
  });

  it('a run\'s day is read without a lock (the move locks the day first)', async () => {
    await pistasRepo.runDay(tx, 'run-1');
    expect(last().text).toMatch(/SELECT day::text AS day FROM pistas_runs WHERE id = \$\?/);
    expect(last().text).not.toMatch(/FOR (SHARE|UPDATE)/);
  });

  it('a run is inserted for exactly one owner with its day\'s closing instant; any uniqueness conflict yields null', async () => {
    const closesAt = new Date('2026-09-30T03:00:00Z');
    await pistasRepo.insertRun(tx, { id: 'run-1', player: { kind: 'guest', guestId: 'guest-a' }, day: '2026-09-29', ranked: false, contentVersion: 5, state, closesAt });
    expect(last().text).toMatch(/ON CONFLICT DO NOTHING/);
    expect(last().values.slice(0, 5)).toEqual(['run-1', null, 'guest-a', '2026-09-29', false]);
    expect(last().values.at(-1)).toBe(closesAt);
    await pistasRepo.insertRun(tx, { id: 'run-2', player: { kind: 'member', userId: 'user-a' }, day: '2026-09-29', ranked: true, contentVersion: 5, state, closesAt });
    expect(last().values.slice(0, 5)).toEqual(['run-2', 'user-a', null, '2026-09-29', true]);
  });

  it('the board and a member\'s rank count ranked, finished runs only, with `solved`', async () => {
    await pistasRepo.leaderboard('2026-09-29', 20);
    expect(withStatementTimeout).toHaveBeenLastCalledWith(expect.any(Function), 4_000);
    expect(last().text).toMatch(/WHERE r\.day = \$\? AND r\.ranked AND r\.done/);
    expect(last().text).toMatch(/r\.solved/);
    await pistasRepo.rankOf('user-a', '2026-09-29', tx);
    expect(last().text).toMatch(/WHERE o\.day = me\.day AND o\.ranked AND o\.done/);
    expect(last().text).toMatch(/WHERE me\.user_id = \$\? AND me\.day = \$\? AND me\.ranked AND me\.done/);
  });
});
