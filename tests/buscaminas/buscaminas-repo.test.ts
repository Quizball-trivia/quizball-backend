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
  return { sql };
});

const { buscaminasRepo } = await import('../../src/modules/buscaminas/buscaminas.repo.js');
const { sql } = await import('../../src/db/index.js');
const tx = sql as never;
const last = () => calls.at(-1)!;

describe('buscaminas repo SQL', () => {
  it('the UPDATE carries the Buenos Aires cutoff for ranked rows only, checked at statement time', async () => {
    const closesAt = new Date('2026-09-29T03:00:00Z');
    const saved = await buscaminasRepo.saveState(tx, 'run-1', {
      state: { v: 1, r: 0, p: [], m: null, s: null, res: [], done: false }, stateVersion: 4, contentVersion: 1, completion: { score: 42, perfects: 1 }, closesAt,
    });
    expect(saved).toBeNull();
    const { text, values } = last();
    expect(text).toMatch(/UPDATE buscaminas_runs/);
    expect(text).toMatch(/WHERE id = \$\? AND \(NOT ranked OR clock_timestamp\(\) < \$\?\)\s+RETURNING/);
    expect(text).toMatch(/completed_at = CASE WHEN \$\? THEN clock_timestamp\(\) END/);
    // now() is the transaction start: a request that waited on the row lock across midnight would slip through.
    expect(text).not.toMatch(/\bnow\(\)/);
    expect(values.at(-1)).toBe(closesAt);
  });

  it('a closed ranked run is unranked only by the database clock, and only while unfinished', async () => {
    await buscaminasRepo.unrankClosedRun(tx, 'run-1', new Date('2026-09-29T03:00:00Z'));
    expect(last().text).toMatch(/SET ranked = false\s+WHERE id = \$\? AND ranked AND NOT done AND clock_timestamp\(\) >= \$\?/);
  });

  it('a run is inserted for exactly one owner, unranked unless asked, and any uniqueness conflict yields null', async () => {
    const state = { v: 1 as const, r: 0, p: [], m: null, s: null, res: [], done: false };
    await buscaminasRepo.insertRun(tx, { id: 'run-1', player: { kind: 'guest', guestId: 'guest-a' }, day: '2026-09-27', ranked: false, contentVersion: 5, state });
    expect(last().text).toMatch(/ON CONFLICT DO NOTHING/);
    expect(last().values.slice(0, 5)).toEqual(['run-1', null, 'guest-a', '2026-09-27', false]);
    await buscaminasRepo.insertRun(tx, { id: 'run-2', player: { kind: 'member', userId: 'user-a' }, day: '2026-09-28', ranked: true, contentVersion: 5, state });
    expect(last().values.slice(0, 5)).toEqual(['run-2', 'user-a', null, '2026-09-28', true]);
  });

  it('a player\'s run is looked up by its own owner column', async () => {
    await buscaminasRepo.lockOwnRun(tx, { kind: 'guest', guestId: 'guest-a' }, '2026-09-27');
    expect(last().text).toMatch(/WHERE guest_id = \$\? AND day = \$\? FOR UPDATE/);
    await buscaminasRepo.getRun({ kind: 'member', userId: 'user-a' }, '2026-09-27');
    expect(last().text).toMatch(/WHERE user_id = \$\? AND day = \$\?/);
  });

  it('the board and a member\'s rank count ranked, finished runs only', async () => {
    await buscaminasRepo.leaderboard('2026-09-28', 20);
    expect(last().text).toMatch(/WHERE r\.day = \$\? AND r\.ranked AND r\.done/);
    await buscaminasRepo.rankOf('user-a', '2026-09-28', tx);
    expect(last().text).toMatch(/WHERE o\.day = me\.day AND o\.ranked AND o\.done/);
    expect(last().text).toMatch(/WHERE me\.user_id = \$\? AND me\.day = \$\? AND me\.ranked AND me\.done/);
  });
});
