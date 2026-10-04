import { describe, expect, it } from 'vitest';
import { createBuscaminasService, type BuscaminasDeps, type RunResponse } from '../../src/modules/buscaminas/buscaminas.service.js';
import type { ContentIndex } from '../../src/modules/buscaminas/buscaminas.content.js';
import { perfects } from '../../src/modules/buscaminas/buscaminas.rules.js';
import type { BuscaminasRunRow, Player } from '../../src/modules/buscaminas/buscaminas.types.js';
import { addDays } from '../../src/modules/buscaminas/buscaminas.days.js';
import { indexOf, makeDay, mineCards, okCards } from './fixtures.js';

const LAUNCH = '2026-09-26';
const TODAY = '2026-09-28';
const YESTERDAY = '2026-09-27';
const NOW = new Date('2026-09-28T15:00:00Z');
const TODAY_CLOSES = new Date('2026-09-29T03:00:00Z');

const member = (userId: string): Player => ({ kind: 'member', userId });
const guest = (guestId: string): Player => ({ kind: 'guest', guestId });
const A = member('user-a');
const B = member('user-b');
const GA = guest('guest-a');
const GB = guest('guest-b');

const entry = (r: BuscaminasRunRow, rank: number) => ({
  rank, userId: r.user_id!, username: r.user_id!, avatarUrl: null, avatarCustomization: null, country: null, tier: null, score: r.score!, perfects: r.perfects!,
});

/**
 * In-memory buscaminas_runs (+ the stored day versions of buscaminas_days) with the same uniqueness,
 * cutoff (`NOT ranked OR clock < closesAt`), content predicate (stored day version = the run's) and
 * board filter (ranked AND done) as the SQL.
 */
function memoryRepo(now: () => Date, dayVersions: Map<string, number>) {
  const rows = new Map<string, BuscaminasRunRow & { completedMs: number }>();
  const cutoffs: Date[] = [];
  const hooks: { onLock?: () => void; onDayLock?: () => void } = {};
  const dayLocks: string[] = [];
  const clone = <T>(x: T): T => structuredClone(x);
  const ownerKey = (p: Player) => (p.kind === 'member' ? `u:${p.userId}` : `g:${p.guestId}`);
  const rowOwner = (r: BuscaminasRunRow) => (r.user_id ? `u:${r.user_id}` : `g:${r.guest_id}`);
  const find = (p: Player, day: string) => [...rows.values()].find((r) => rowOwner(r) === ownerKey(p) && r.day === day);
  const board = (day: string) => [...rows.values()].filter((r) => r.day === day && r.ranked && r.done);
  let clock = 0;
  const repo: BuscaminasDeps['repo'] = {
    withTx: (fn) => fn({} as never),
    async lockDay(_tx, day) {
      dayLocks.push(day);
      const version = dayVersions.get(day) ?? null;
      hooks.onDayLock?.();
      return version;
    },
    async dayVersion(_tx, day) {
      return dayVersions.get(day) ?? null;
    },
    async insertRun(_tx, d) {
      if (find(d.player, d.day)) return null;
      const row = {
        id: d.id, user_id: d.player.kind === 'member' ? d.player.userId : null, guest_id: d.player.kind === 'guest' ? d.player.guestId : null,
        day: d.day, ranked: d.ranked, content_version: d.contentVersion, state: clone(d.state), state_version: 0,
        done: false, score: null, perfects: null, completed_at: null, completedMs: 0,
      };
      rows.set(row.id, row);
      return clone(row);
    },
    async lockOwnRun(_tx, p, day) {
      const r = find(p, day);
      return r ? clone(r) : null;
    },
    async lockRun(_tx, id) {
      hooks.onLock?.();
      const r = rows.get(id);
      return r ? clone(r) : null;
    },
    async getRun(p, day) {
      const r = find(p, day);
      return r ? clone(r) : null;
    },
    async saveState(_tx, id, d) {
      cutoffs.push(d.closesAt);
      const row = rows.get(id)!;
      if (row.ranked && now().getTime() >= d.closesAt.getTime()) return null;
      if (dayVersions.get(row.day) !== d.contentVersion) return null;
      Object.assign(row, {
        state: clone(d.state), state_version: d.stateVersion, content_version: d.contentVersion, done: d.completion !== null,
        score: d.completion?.score ?? null, perfects: d.completion?.perfects ?? null,
        completed_at: d.completion ? new Date() : null, completedMs: d.completion ? ++clock : 0,
      });
      return clone(row);
    },
    async unrankClosedRun(_tx, id, closesAt) {
      const row = rows.get(id)!;
      if (!row.ranked || row.done || now().getTime() < closesAt.getTime()) return null;
      row.ranked = false;
      return clone(row);
    },
    async rankOf(u, day) {
      const me = board(day).find((r) => r.user_id === u);
      if (!me) return null;
      const better = board(day).filter((o) => o.score! > me.score! || (o.score === me.score && o.completedMs < me.completedMs));
      return entry(me, better.length + 1);
    },
    async leaderboard(day, limit) {
      const done = board(day).sort((a, b) => b.score! - a.score! || a.completedMs - b.completedMs);
      return { players: done.length, top: done.slice(0, limit).map((r, i) => entry(r, i + 1)) };
    },
  };
  return { repo, rows, cutoffs, hooks, find, dayLocks };
}

function setup(opts: { now?: Date; days?: string[] } = {}) {
  // The stored days are the calendar, so they run unbroken from the launch day.
  const days = opts.days ?? [LAUNCH, YESTERDAY, TODAY, '2026-09-29'];
  let content: ContentIndex = indexOf(...days.map((d) => makeDay(d)));
  const clock = { now: opts.now ?? NOW };
  const stored = new Map(days.map((d) => [d, makeDay(d).contentVersion]));
  const mem = memoryRepo(() => clock.now, stored);
  const stale = { count: 0 };
  const svc = createBuscaminasService({ repo: mem.repo, content: async () => content, contentStale: () => { stale.count += 1; }, now: () => clock.now });
  const version = (day: string, variant = 0) => makeDay(day, variant).contentVersion;
  /** A seed correcting every day's answers commits; the replica's cache has not seen it yet. */
  const correctDatabase = () => { for (const d of days) stored.set(d, makeDay(d, 1).contentVersion); };
  /** The replica's cache catches up with the database. */
  const refreshCache = () => { content = indexOf(...days.map((d) => makeDay(d, 1))); };
  /** What this replica's cache holds (the stored days stay as they are). */
  const serve = (served: string[]) => { content = indexOf(...served.map((d) => makeDay(d))); };
  return { svc, clock, ...mem, stored, stale, version, serve, correctDatabase, refreshCache, correct: () => { correctDatabase(); refreshCache(); } };
}

type Svc = ReturnType<typeof setup>['svc'];

/** Round r: tap `hits` correct cards then bank (or a perfect when hits = 12), then next. */
async function playRound(svc: Svc, p: Player, run: RunResponse, r: number, hits: number): Promise<RunResponse> {
  let cur = run;
  for (const id of okCards(r).slice(0, hits)) cur = await svc.tap(p, cur.run.id, cur.run.version, id);
  if (hits < 12) cur = await svc.bank(p, cur.run.id, cur.run.version);
  return svc.next(p, cur.run.id, cur.run.version);
}

async function playAll(svc: Svc, p: Player, run: RunResponse, hits: (r: number) => number): Promise<RunResponse> {
  let cur = run;
  for (let r = 0; r < 20; r += 1) cur = await playRound(svc, p, cur, r, hits(r));
  return cur;
}

const conflict = (code: string) => ({ statusCode: 409, code });
const signIn = { statusCode: 403, code: 'sign_in_for_today' };

describe('buscaminas service: guests', () => {
  it('a guest plays a past day as an unranked row, one per guest session per day, with the full reveal', async () => {
    const { svc, rows, find } = setup();
    const run = await svc.start(YESTERDAY, GA);
    expect(run).toMatchObject({ run: { version: 0 }, state: { day: YESTERDAY, round: 0, ranked: false, score: 0, done: false } });
    expect(find(GA, YESTERDAY)).toMatchObject({ guest_id: 'guest-a', user_id: null, ranked: false });
    // Idempotent: the same guest session gets the same run back.
    expect((await svc.start(YESTERDAY, GA)).run).toEqual(run.run);
    expect((await svc.start(YESTERDAY, GB)).run.id).not.toBe(run.run.id);
    expect(rows.size).toBe(2);

    const hit = await svc.tap(GA, run.run.id, 0, 'r0c0');
    expect(hit).toMatchObject({ ok: true, run: { id: run.run.id, version: 1 } });
    const mine = await svc.tap(GA, hit.run.id, hit.run.version, 'r0c12');
    expect(mine.ok).toBe(false);
    expect(mine.state.settled).toMatchObject({ outcome: 'mine', found: 1, reveal: { ok: okCards(0), mines: mineCards(0) } });
    const next = await svc.next(GA, mine.run.id, mine.run.version);
    expect(next.state).toMatchObject({ round: 1, picked: [], results: [{ outcome: 'mine', found: 1, points: 0 }] });
    expect(await svc.current(GA, YESTERDAY)).toEqual(next);
  });

  it('a guest cannot start the live day (403 sign_in_for_today) and never creates a row for it', async () => {
    const { svc, rows } = setup();
    await expect(svc.start(TODAY, GA)).rejects.toMatchObject(signIn);
    // The policy answers before a stale page's content check; unknown and future days stay 404.
    await expect(svc.start(TODAY, GA, 7)).rejects.toMatchObject(signIn);
    await expect(svc.start('2026-09-29', GA)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.start('2026-09-25', GA)).rejects.toMatchObject({ statusCode: 404 });
    expect(rows.size).toBe(0);
    expect(await svc.current(GA, undefined)).toEqual({ run: null });
  });

  it('a guest run carried over into the live day (pre-launch preview) cannot be played on', async () => {
    const { svc, clock } = setup({ now: new Date('2026-09-25T15:00:00Z'), days: ['2026-09-26'] });
    const preview = await svc.start('2026-09-26', GA);
    expect(preview.state.ranked).toBe(false);
    clock.now = new Date('2026-09-26T15:00:00Z');
    await expect(svc.tap(GA, preview.run.id, 0, 'r0c0')).rejects.toMatchObject(signIn);
  });
});

describe('buscaminas service: members', () => {
  it('a member\'s live-day run is ranked; /start resumes it (any device) and it lands on the board', async () => {
    const { svc, find } = setup();
    const first = await svc.start(TODAY, A, makeDay(TODAY).contentVersion);
    expect(first.state).toMatchObject({ day: TODAY, ranked: true });
    expect(find(A, TODAY)).toMatchObject({ user_id: 'user-a', guest_id: null, ranked: true });
    const tapped = await svc.tap(A, first.run.id, first.run.version, 'r0c0');
    const resumed = await svc.start(TODAY, A);
    expect(resumed).toEqual({ run: tapped.run, state: tapped.state });
    expect(resumed.state.picked).toEqual(['r0c0']);

    let cur = resumed;
    for (const id of okCards(0).slice(1)) cur = await svc.tap(A, cur.run.id, cur.run.version, id);
    cur = await svc.next(A, cur.run.id, cur.run.version);
    for (let r = 1; r < 20; r += 1) cur = await playRound(svc, A, cur, r, r % 2 ? 12 : 5);
    const expected = 15 + 10 * 15 + 9 * 5;
    expect(cur.state).toMatchObject({ done: true, score: expected, rank: 1, ranked: true });
    expect(find(A, TODAY)).toMatchObject({ done: true, score: expected, perfects: perfects(cur.state.results) });
    await expect(svc.next(A, cur.run.id, cur.run.version)).rejects.toMatchObject({ statusCode: 400, message: 'run_done' });
    // A finished run is returned as it is, with the member's rank.
    expect((await svc.start(TODAY, A)).state).toMatchObject({ done: true, rank: 1 });
    expect(await svc.current(A, undefined)).toMatchObject({ state: { done: true, rank: 1, ranked: true } });
  });

  it('a member\'s past-day run is an unranked row and never reaches the board', async () => {
    const { svc, find } = setup();
    const run = await svc.start(YESTERDAY, A);
    expect(run.state.ranked).toBe(false);
    expect(find(A, YESTERDAY)).toMatchObject({ ranked: false, user_id: 'user-a' });
    const done = await playAll(svc, A, run, () => 12);
    expect(done.state).toMatchObject({ done: true, score: 300, ranked: false });
    expect(done.state.rank).toBeUndefined();
    expect(await svc.leaderboard(YESTERDAY, 'user-a')).toEqual({ day: YESTERDAY, players: 0, top: [], me: null });
  });

  it('the leaderboard holds ranked, finished member runs only', async () => {
    const { svc } = setup();
    // Guests and past-day members play the same past day; nobody is ranked there.
    await playAll(svc, GA, await svc.start(YESTERDAY, GA), () => 12);
    await playAll(svc, B, await svc.start(YESTERDAY, B), () => 12);
    // Live day: A finishes, B finishes lower, a third member never finishes.
    const a = await playAll(svc, A, await svc.start(TODAY, A), () => 12);
    const b = await playAll(svc, B, await svc.start(TODAY, B), (r) => (r === 0 ? 5 : 12));
    const c = await svc.start(TODAY, member('user-c'));
    await svc.tap(member('user-c'), c.run.id, 0, 'r0c0');
    expect(a.state).toMatchObject({ score: 300, rank: 1 });
    expect(b.state).toMatchObject({ score: 290, rank: 2 });

    const board = await svc.leaderboard(undefined, 'user-b');
    expect(board).toMatchObject({ day: TODAY, players: 2, me: { rank: 2, userId: 'user-b', score: 290 } });
    expect(board.top.map((e) => [e.userId, e.score])).toEqual([['user-a', 300], ['user-b', 290]]);
    expect(await svc.leaderboard(YESTERDAY, null)).toMatchObject({ players: 0, top: [] });
    expect(await svc.leaderboard('2026-12-25', null)).toEqual({ day: '2026-12-25', players: 0, top: [], me: null });
  });

  it('an unfinished ranked run whose day closed goes on as practice (unranked) from /start', async () => {
    const { svc, clock, find } = setup();
    const run = await svc.start(TODAY, A);
    const tapped = await svc.tap(A, run.run.id, 0, 'r0c0');
    clock.now = new Date('2026-09-29T15:00:00Z');
    await expect(svc.tap(A, tapped.run.id, tapped.run.version, 'r0c1')).rejects.toMatchObject(conflict('day_over'));
    const practice = await svc.start(TODAY, A);
    expect(practice).toMatchObject({ run: tapped.run, state: { ranked: false, picked: ['r0c0'] } });
    expect(find(A, TODAY)).toMatchObject({ ranked: false });
    const on = await svc.tap(A, practice.run.id, practice.run.version, 'r0c12');
    // Now an archive day: the answers are revealed.
    expect(on.state.settled?.reveal).toEqual({ ok: okCards(0), mines: mineCards(0) });
  });
});

describe('buscaminas service: moves', () => {
  it('only the run\'s owner may move it: guest A not guest B\'s, a member not a guest\'s, a guest not a member\'s', async () => {
    const { svc } = setup();
    const ga = await svc.start(YESTERDAY, GA);
    const am = await svc.start(TODAY, A);
    const notYours = { statusCode: 403, message: 'run_not_yours' };
    await expect(svc.tap(GB, ga.run.id, 0, 'r0c0')).rejects.toMatchObject(notYours);
    await expect(svc.tap(A, ga.run.id, 0, 'r0c0')).rejects.toMatchObject(notYours);
    await expect(svc.bank(GA, am.run.id, 0)).rejects.toMatchObject(notYours);
    await expect(svc.next(B, am.run.id, 0)).rejects.toMatchObject(notYours);
    await expect(svc.tap(A, '00000000-0000-4000-8000-000000000000', 0, 'r0c0')).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.tap(GA, ga.run.id, 0, 'r0c0')).ok).toBe(true);
  });

  it('an outdated version is stale_state (a retry, another tab) and /start re-syncs', async () => {
    const { svc } = setup();
    const run = await svc.start(TODAY, A);
    const tapped = await svc.tap(A, run.run.id, 0, 'r0c0');
    await expect(svc.tap(A, run.run.id, 0, 'r0c0')).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.bank(A, run.run.id, 0)).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.tap(A, run.run.id, 5, 'r0c1')).rejects.toMatchObject(conflict('stale_state'));
    const synced = await svc.start(TODAY, A);
    expect(synced.run).toEqual({ id: run.run.id, version: 1 });
    expect((await svc.bank(A, synced.run.id, synced.run.version)).state.settled).toMatchObject({ outcome: 'banked', found: 1 });
  });

  it('an invalid move changes nothing', async () => {
    const { svc, find } = setup();
    const run = await svc.start(YESTERDAY, GA);
    await expect(svc.bank(GA, run.run.id, 0)).rejects.toMatchObject({ statusCode: 400, message: 'nothing_to_bank' });
    await expect(svc.next(GA, run.run.id, 0)).rejects.toMatchObject({ statusCode: 400, message: 'round_not_settled' });
    expect(find(GA, YESTERDAY)).toMatchObject({ state_version: 0 });
    expect((await svc.tap(GA, run.run.id, 0, 'r0c0')).run.version).toBe(1);
  });

  it('closes an unfinished ranked run at Buenos Aires midnight; unranked runs never close', async () => {
    const { svc, clock, find } = setup();
    const ranked = await svc.tap(A, (await svc.start(TODAY, A)).run.id, 0, 'r0c0');
    const practice = await svc.tap(GA, (await svc.start(YESTERDAY, GA)).run.id, 0, 'r0c0');
    clock.now = new Date('2026-09-29T03:00:01Z');
    await expect(svc.tap(A, ranked.run.id, 1, 'r0c1')).rejects.toMatchObject(conflict('day_over'));
    await expect(svc.bank(A, ranked.run.id, 1)).rejects.toMatchObject(conflict('day_over'));
    expect(find(A, TODAY)).toMatchObject({ done: false, state_version: 1 });
    expect((await svc.tap(GA, practice.run.id, 1, 'r0c1')).ok).toBe(true);
  });

  it('the ranked UPDATE carries the day cutoff: admitted before midnight but committed after is day_over', async () => {
    const { svc, clock, find, cutoffs, hooks } = setup();
    const tapped = await svc.tap(A, (await svc.start(TODAY, A)).run.id, 0, 'r0c0');
    expect(cutoffs).toEqual([TODAY_CLOSES]);
    clock.now = new Date('2026-09-29T02:59:59Z');
    hooks.onLock = () => { clock.now = new Date('2026-09-29T03:00:01Z'); };
    await expect(svc.bank(A, tapped.run.id, 1)).rejects.toMatchObject(conflict('day_over'));
    expect(cutoffs).toEqual([TODAY_CLOSES, TODAY_CLOSES]);
    expect(find(A, TODAY)).toMatchObject({ done: false, state_version: 1 });
  });
});

describe('buscaminas service: content versions', () => {
  it('start rejects a page built from other content; a tap on a card the round lacks is content_changed', async () => {
    const { svc } = setup();
    await expect(svc.start(YESTERDAY, GA, 7)).rejects.toMatchObject(conflict('content_changed'));
    const run = await svc.start(YESTERDAY, GA, makeDay(YESTERDAY).contentVersion);
    await expect(svc.tap(GA, run.run.id, 0, 'not-a-card')).rejects.toMatchObject(conflict('content_changed'));
  });

  it('after a correction, moves on the old content are content_changed; only a client on the new content restarts the run', async () => {
    const { svc, find, correct, version } = setup();
    const run = await svc.start(TODAY, A);
    await svc.tap(A, run.run.id, 0, 'r0c0');
    correct();
    await expect(svc.tap(A, run.run.id, 1, 'r0c1')).rejects.toMatchObject(conflict('content_changed'));
    expect(await svc.current(A, TODAY)).toEqual({ run: null });
    await expect(svc.start(TODAY, A)).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.start(TODAY, A, version(TODAY))).rejects.toMatchObject(conflict('content_changed'));
    expect(find(A, TODAY)).toMatchObject({ content_version: version(TODAY), state_version: 1 });
    const restarted = await svc.start(TODAY, A, version(TODAY, 1));
    expect(restarted).toMatchObject({ run: { id: run.run.id, version: 2 }, state: { round: 0, picked: [], ranked: true } });
    expect(find(A, TODAY)).toMatchObject({ content_version: version(TODAY, 1) });
    expect((await svc.tap(A, run.run.id, 2, 'r0c15')).ok).toBe(true);
  });

  it('every start and move share-locks its day and checks the stored version', async () => {
    const { svc, dayLocks } = setup();
    const run = await svc.start(YESTERDAY, GA);
    await svc.tap(GA, run.run.id, 0, 'r0c0');
    await svc.bank(GA, run.run.id, 1);
    await svc.next(GA, run.run.id, 2);
    expect(dayLocks).toEqual([YESTERDAY, YESTERDAY, YESTERDAY, YESTERDAY]);
  });

  it('a correction committed while this replica still serves the old answers: starts and moves are content_changed, never scored', async () => {
    const { svc, find, stale, correctDatabase, refreshCache, version } = setup();
    const ranked = await svc.start(TODAY, A);
    const tapped = await svc.tap(A, ranked.run.id, 0, 'r0c0');
    correctDatabase();
    // r0c15 is a mine in the old answers but fits the corrected ones: the stale cache must not judge it.
    await expect(svc.tap(A, tapped.run.id, 1, 'r0c15')).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.bank(A, tapped.run.id, 1)).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.start(YESTERDAY, GA)).rejects.toMatchObject(conflict('content_changed'));
    expect(find(A, TODAY)).toMatchObject({ state_version: 1, content_version: version(TODAY) });
    expect(find(GA, YESTERDAY)).toBeUndefined();
    // Each refusal asks the cache to re-check now instead of after the refresh interval.
    expect(stale.count).toBe(3);

    refreshCache();
    const restarted = await svc.start(TODAY, A, version(TODAY, 1));
    expect(restarted).toMatchObject({ run: { id: ranked.run.id, version: 2 }, state: { round: 0, picked: [], ranked: true } });
    expect((await svc.tap(A, ranked.run.id, 2, 'r0c15')).ok).toBe(true);
  });

  it('the run UPDATE itself requires the stored day version: 0 rows is content_changed, not day_over', async () => {
    const { svc, find, hooks, stored, version } = setup();
    const run = await svc.start(TODAY, A);
    // A version change the share lock did not see (it cannot happen under the lock; the predicate is the backstop).
    hooks.onDayLock = () => { stored.set(TODAY, version(TODAY, 1)); };
    await expect(svc.tap(A, run.run.id, 0, 'r0c0')).rejects.toMatchObject(conflict('content_changed'));
    expect(find(A, TODAY)).toMatchObject({ state_version: 0, done: false });
  });

  it('a finished run on superseded content is kept as it is, without a reveal', async () => {
    const { svc, correct } = setup();
    const done = await playAll(svc, GA, await svc.start(YESTERDAY, GA), () => 5);
    correct();
    const again = await svc.start(YESTERDAY, GA);
    expect(again).toMatchObject({ run: done.run, state: { done: true, score: 100 } });
  });
});

describe('buscaminas service: reveal rules', () => {
  it('never reveals a live day; archive days reveal each settled round', async () => {
    const { svc } = setup();
    const ranked = await svc.start(TODAY, A);
    const mine = await svc.tap(A, ranked.run.id, 0, 'r0c13');
    expect(mine.state).toMatchObject({ ranked: true, mine: 'r0c13', settled: { outcome: 'mine', reveal: null } });
    expect(JSON.stringify(mine)).not.toContain('r0c12');
    let cur = await svc.next(A, mine.run.id, mine.run.version);
    for (const id of okCards(1)) cur = await svc.tap(A, cur.run.id, cur.run.version, id);
    const perfect = await svc.current(A, TODAY);
    expect(perfect).toMatchObject({ state: { settled: { outcome: 'perfect', reveal: null } } });
    expect(JSON.stringify(perfect)).not.toContain(mineCards(1)[0]);

    const archive = await svc.start(YESTERDAY, GA);
    const archived = await svc.tap(GA, archive.run.id, 0, 'r0c12');
    expect(archived.state.settled?.reveal).toEqual({ ok: okCards(0), mines: mineCards(0) });
  });

  it('before launch the launch puzzle is an unranked, unrevealed preview for everyone; after the last day nothing is ranked', async () => {
    const pre = setup({ now: new Date('2026-09-25T15:00:00Z'), days: ['2026-09-26'] });
    const preview = await pre.svc.start('2026-09-26', A);
    expect(preview.state.ranked).toBe(false);
    expect((await pre.svc.tap(A, preview.run.id, 0, 'r0c12')).state.settled?.reveal).toBeNull();
    expect((await pre.svc.start('2026-09-26', GA)).state.ranked).toBe(false);

    const post = setup({ now: new Date('2026-12-26T15:00:00Z'), days: Array.from({ length: 90 }, (_, i) => addDays(LAUNCH, i)) });
    expect((await post.svc.start('2026-12-24', A)).state.ranked).toBe(false);
    expect((await post.svc.leaderboard(undefined, null)).day).toBe('2026-12-24');
  });
});

describe('buscaminas boards', () => {
  const expectNoAnswers = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/"ok"|"mines"|"reveal"|"answers"/);

  it('serves a past or the live board without any answer; its day decides how long it may be cached', async () => {
    const { svc } = setup();
    const past = await svc.board(YESTERDAY);
    expect(past.live).toBe(false);
    expect(past.board).toEqual({
      day: YESTERDAY, number: 2, contentVersion: makeDay(YESTERDAY).contentVersion,
      rounds: makeDay(YESTERDAY).rounds.map((r) => ({ id: r.id, difficulty: r.difficulty, prompt: r.prompt, cards: r.cards.map(({ id, name, img }) => ({ id, name, img })) })),
    });
    expectNoAnswers(past);
    const live = await svc.board(TODAY);
    expect(live).toMatchObject({ live: true, board: { day: TODAY, number: 3 } });
    expectNoAnswers(live);
  });

  it('a future day is the same 404 as a day with no content, until it opens at Buenos Aires midnight', async () => {
    const { svc, clock, version } = setup();
    const errorOf = (day: string) => svc.board(day).then(() => null, (e: { statusCode: number; code: string; message: string; details: unknown }) =>
      ({ statusCode: e.statusCode, code: e.code, message: e.message, details: e.details }));
    const tomorrow = await errorOf('2026-09-29');
    expect(tomorrow).toMatchObject({ statusCode: 404 });
    for (const day of ['2026-09-30', '2026-09-25', '2027-01-01', '2026-02-30']) expect(await errorOf(day)).toEqual(tomorrow);
    expect((await svc.boards()).days).toEqual({ [LAUNCH]: version(LAUNCH), [YESTERDAY]: version(YESTERDAY), [TODAY]: version(TODAY) });

    clock.now = new Date('2026-09-29T02:59:59Z');
    expect(await errorOf('2026-09-29')).toEqual(tomorrow);
    clock.now = new Date('2026-09-29T03:00:00Z');
    expect(await svc.board('2026-09-29')).toMatchObject({ live: true, board: { day: '2026-09-29' } });
    expect((await svc.board(TODAY)).live).toBe(false);
    expect(Object.keys((await svc.boards()).days)).toEqual([LAUNCH, YESTERDAY, TODAY, '2026-09-29']);
  });

  it('the stored days are the calendar: an appended day opens ranked on its date, a day past a hole never opens', async () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => addDays(LAUNCH, i));
    const dec25 = new Date('2026-12-25T15:00:00Z');
    // 90 days stored, as first seeded: the 91st date has nothing, and the last day goes on unranked.
    const ended = setup({ now: dec25, days: run(90) });
    await expect(ended.svc.board('2026-12-25')).rejects.toMatchObject({ statusCode: 404 });
    expect((await ended.svc.start('2026-12-24', A)).state.ranked).toBe(false);
    // One more stored day, no release: it is the live, ranked day.
    const appended = setup({ now: dec25, days: run(91) });
    expect(await appended.svc.board('2026-12-25')).toMatchObject({ live: true, board: { day: '2026-12-25', number: 91 } });
    expect((await appended.svc.start('2026-12-25', A)).state.ranked).toBe(true);
    expect((await appended.svc.leaderboard(undefined, null)).day).toBe('2026-12-25');
    // A stored day beyond a missing one is not released, whatever the date.
    const holed = setup({ now: new Date('2026-12-27T15:00:00Z'), days: [...run(90), '2026-12-26', '2026-12-27'] });
    await expect(holed.svc.board('2026-12-26')).rejects.toMatchObject({ statusCode: 404 });
    await expect(holed.svc.board('2026-12-27')).rejects.toMatchObject({ statusCode: 404 });
    expect(Object.keys((await holed.svc.boards()).days).at(-1)).toBe('2026-12-24');
    expect((await holed.svc.start('2026-12-24', A)).state.ranked).toBe(false);
  });

  it('a replica whose cache is behind an appended day re-checks instead of calling a live ranked run over', async () => {
    const { svc, serve, stale } = setup();
    const run = await svc.start(TODAY, A);
    expect(run.state.ranked).toBe(true);
    // Another replica's view: it has not read the append that added today.
    serve([LAUNCH, YESTERDAY]);
    await expect(svc.tap(A, run.run.id, 0, 'r0c0')).rejects.toMatchObject(conflict('content_changed'));
    expect(stale.count).toBe(1);
    // Once it has, the move lands on the same ranked run.
    serve([LAUNCH, YESTERDAY, TODAY]);
    expect((await svc.tap(A, run.run.id, 0, 'r0c0')).state.ranked).toBe(true);
  });

  it('a run of a day the calendar no longer reaches is neither played on nor shown', async () => {
    const { svc, serve } = setup();
    const run = await svc.start(TODAY, A);
    // Yesterday's row is gone: today is stored beyond a hole, so the calendar ends at the launch day.
    serve([LAUNCH, TODAY]);
    await expect(svc.tap(A, run.run.id, 0, 'r0c0')).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.current(A, TODAY)).toEqual({ run: null });
    await expect(svc.board(TODAY)).rejects.toMatchObject({ statusCode: 404 });
    // Its leaderboard, asked for by day, shows nothing either.
    expect(await svc.leaderboard(TODAY, 'user-a')).toEqual({ day: TODAY, players: 0, top: [], me: null });
  });

  it('with no days seeded every day is a 404 and the index is empty', async () => {
    const { svc } = setup({ days: [] });
    expect(await svc.boards()).toEqual({ days: {} });
    await expect(svc.board(TODAY)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.start(YESTERDAY, GA)).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.current(A, undefined)).toEqual({ run: null });
    expect(await svc.leaderboard(undefined, 'user-a')).toEqual({ day: TODAY, players: 0, top: [], me: null });
  });
});
