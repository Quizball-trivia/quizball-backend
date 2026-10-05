import { describe, expect, it } from 'vitest';
import { createPistasService, type PistasDeps, type RunResponse } from '../../src/modules/pistas/pistas.service.js';
import type { ContentIndex } from '../../src/modules/pistas/pistas.content.js';
import type { PistasRunRow, Player } from '../../src/modules/pistas/pistas.types.js';
import { addDays } from '../../src/modules/pistas/pistas.days.js';
import { answerOf, indexOf, makeDay } from './fixtures.js';

const TODAY = '2026-09-30';
const YESTERDAY = '2026-09-29';
const FIRST = '2026-09-27';
const NOW = new Date('2026-09-30T15:00:00Z');
const TODAY_CLOSES = new Date('2026-10-01T03:00:00Z');

const member = (userId: string): Player => ({ kind: 'member', userId });
const guest = (guestId: string): Player => ({ kind: 'guest', guestId });
const A = member('user-a');
const B = member('user-b');
const GA = guest('guest-a');
const GB = guest('guest-b');

type MemRow = Omit<PistasRunRow, 'closed'> & { completedMs: number };

const entry = (r: MemRow, rank: number) => ({
  rank, userId: r.user_id!, username: r.user_id!, avatarUrl: null, avatarCustomization: null, country: null, tier: null, score: r.score!, solved: r.solved!,
});

/**
 * In-memory pistas_runs (+ the stored day versions of pistas_days) with the SQL's uniqueness, ranked
 * fence (`NOT ranked OR db clock < closes_at`), content predicate and board filter. `db()` is the
 * database clock, separate from the app clock, so the tests can split them.
 */
function memoryRepo(db: () => Date, dayVersions: Map<string, number>) {
  const rows = new Map<string, MemRow>();
  const hooks: { onLock?: () => void; onDayLock?: () => void } = {};
  const dayLocks: string[] = [];
  const locks: string[] = [];
  const ownerKey = (p: Player) => (p.kind === 'member' ? `u:${p.userId}` : `g:${p.guestId}`);
  const rowOwner = (r: MemRow) => (r.user_id ? `u:${r.user_id}` : `g:${r.guest_id}`);
  const find = (p: Player, day: string) => [...rows.values()].find((r) => rowOwner(r) === ownerKey(p) && r.day === day);
  const board = (day: string) => [...rows.values()].filter((r) => r.day === day && r.ranked && r.done);
  const out = (r: MemRow | undefined): PistasRunRow | null => {
    if (!r) return null;
    const { completedMs: _ms, ...row } = structuredClone(r);
    return { ...row, closed: db().getTime() >= r.closes_at.getTime() };
  };
  let clock = 0;
  const repo: PistasDeps['repo'] = {
    withTx: (fn) => fn({} as never),
    async lockDay(_tx, day) {
      dayLocks.push(day);
      locks.push(`day:${day}`);
      const version = dayVersions.get(day) ?? null;
      hooks.onDayLock?.();
      return version;
    },
    async dayVersion(_tx, day) {
      return dayVersions.get(day) ?? null;
    },
    async insertRun(_tx, d) {
      if (find(d.player, d.day)) return null;
      const row: MemRow = {
        id: d.id, user_id: d.player.kind === 'member' ? d.player.userId : null, guest_id: d.player.kind === 'guest' ? d.player.guestId : null,
        day: d.day, ranked: d.ranked, content_version: d.contentVersion, state: structuredClone(d.state), state_version: 0,
        done: false, score: null, solved: null, completed_at: null, closes_at: d.closesAt, completedMs: 0,
      };
      rows.set(row.id, row);
      return out(row);
    },
    async lockOwnRun(_tx, p, day) {
      return out(find(p, day));
    },
    async runDay(_tx, id) {
      return rows.get(id)?.day ?? null;
    },
    async lockRun(_tx, id) {
      locks.push(`run:${id}`);
      hooks.onLock?.();
      return out(rows.get(id));
    },
    async getRun(p, day) {
      return out(find(p, day));
    },
    async saveState(_tx, id, d) {
      const row = rows.get(id)!;
      if (row.ranked && db().getTime() >= row.closes_at.getTime()) return null;
      if (dayVersions.get(row.day) !== d.contentVersion) return null;
      Object.assign(row, {
        state: structuredClone(d.state), state_version: d.stateVersion, content_version: d.contentVersion, done: d.completion !== null,
        score: d.completion?.score ?? null, solved: d.completion?.solved ?? null,
        completed_at: d.completion ? new Date() : null, completedMs: d.completion ? ++clock : 0,
      });
      return out(row);
    },
    async unrankClosedRun(_tx, id) {
      const row = rows.get(id)!;
      if (!row.ranked || row.done || db().getTime() < row.closes_at.getTime()) return null;
      row.ranked = false;
      return out(row);
    },
    async rebaseRun(_tx, id, contentVersion, state) {
      const row = rows.get(id)!;
      if (row.done || row.content_version === contentVersion || dayVersions.get(row.day) !== contentVersion) return null;
      Object.assign(row, { content_version: contentVersion, state: structuredClone(state), ranked: false, state_version: row.state_version + 1 });
      return out(row);
    },
    async isClosed(closesAt) {
      return db().getTime() >= closesAt.getTime();
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
  return { repo, rows, hooks, find, dayLocks, locks };
}

function setup(opts: { now?: Date; days?: string[] } = {}) {
  const days = opts.days ?? ['2026-09-27', '2026-09-28', YESTERDAY, TODAY, '2026-10-01'];
  let content: ContentIndex = indexOf(...days.map((d) => makeDay(d)));
  // `db` follows the app clock unless a test sets it apart.
  const clock = { now: opts.now ?? NOW, db: null as Date | null };
  const stored = new Map(days.map((d) => [d, makeDay(d).contentVersion]));
  const mem = memoryRepo(() => clock.db ?? clock.now, stored);
  const stale = { count: 0 };
  const svc = createPistasService({ repo: mem.repo, content: async () => content, contentStale: () => { stale.count += 1; }, now: () => clock.now });
  const version = (day: string, variant = 0) => makeDay(day, variant).contentVersion;
  /** A seed corrected every day and unranked their runs; the replica's cache has not seen it yet. */
  const correctDatabase = () => {
    for (const d of days) stored.set(d, version(d, 1));
    for (const row of mem.rows.values()) row.ranked = false;
  };
  const refreshCache = () => { content = indexOf(...days.map((d) => makeDay(d, 1))); };
  /** What this replica's cache holds (the stored days stay as they are). */
  const serve = (served: string[]) => { content = indexOf(...served.map((d) => makeDay(d))); };
  return { svc, clock, ...mem, stored, stale, version, serve, correctDatabase, refreshCache, correct: () => { correctDatabase(); refreshCache(); } };
}

type Svc = ReturnType<typeof setup>['svc'];

/** Round r: reveal `extra` clues, then guess right (points 10 − extra) or give up; then next unless it was the last. */
async function playRound(svc: Svc, p: Player, run: RunResponse, r: number, extra: number, solve: boolean): Promise<RunResponse> {
  let cur = run;
  for (let i = 0; i < extra; i += 1) cur = await svc.reveal(p, cur.run.id, cur.run.version);
  cur = solve ? await svc.guess(p, cur.run.id, cur.run.version, answerOf(r)) : await svc.giveUp(p, cur.run.id, cur.run.version);
  return cur.state.done ? cur : svc.next(p, cur.run.id, cur.run.version);
}

async function playAll(svc: Svc, p: Player, run: RunResponse, plan: (r: number) => { extra: number; solve: boolean }): Promise<RunResponse> {
  let cur = run;
  for (let r = 0; r < 10; r += 1) cur = await playRound(svc, p, cur, r, plan(r).extra, plan(r).solve);
  return cur;
}

const conflict = (code: string) => ({ statusCode: 409, code });
const bad = (reason: string) => ({ statusCode: 400, message: reason, details: { reason } });
const signIn = { statusCode: 403, code: 'sign_in_for_today' };
const perfect = () => ({ extra: 0, solve: true });

describe('pistas service: guests', () => {
  it('a guest plays a closed day as an unranked row, one per guest session per day', async () => {
    const { svc, rows, find } = setup();
    const run = await svc.start(YESTERDAY, GA);
    expect(run).toMatchObject({ run: { version: 0 }, state: { day: YESTERDAY, round: 0, revealed: 1, pointsInPlay: 10, ranked: false, score: 0, done: false } });
    expect(run.state.clues).toHaveLength(1);
    expect(find(GA, YESTERDAY)).toMatchObject({ guest_id: 'guest-a', user_id: null, ranked: false, closes_at: new Date('2026-09-30T03:00:00Z') });
    expect((await svc.start(YESTERDAY, GA)).run).toEqual(run.run);
    expect((await svc.start(YESTERDAY, GB)).run.id).not.toBe(run.run.id);
    expect(rows.size).toBe(2);
    const shown = await svc.reveal(GA, run.run.id, 0);
    expect(shown).toMatchObject({ run: { id: run.run.id, version: 1 }, state: { revealed: 2, pointsInPlay: 9 } });
    expect(await svc.current(GA, YESTERDAY)).toEqual(shown);
  });

  it('a guest waits for the database clock too: an app clock ahead of it cannot open yesterday early', async () => {
    const { svc, clock, find } = setup({ now: new Date('2026-09-30T03:00:01Z') });
    clock.db = new Date('2026-09-30T02:59:59Z');
    await expect(svc.start(YESTERDAY, GA)).rejects.toMatchObject(signIn);
    expect(find(GA, YESTERDAY)).toBeUndefined();
    clock.db = new Date('2026-09-30T03:00:00Z');
    const run = await svc.start(YESTERDAY, GA);
    expect(run.state.ranked).toBe(false);
  });

  it('a guest is refused today (403 sign_in_for_today), ranked or not, and never gets a row; future days are 404', async () => {
    const { svc, rows } = setup();
    await expect(svc.start(TODAY, GA)).rejects.toMatchObject(signIn);
    await expect(svc.start(TODAY, GA, 7)).rejects.toMatchObject(signIn);
    await expect(svc.start('2026-10-01', GA)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.start('2026-09-26', GA)).rejects.toMatchObject({ statusCode: 404 });
    // Before the ranked launch, today is unranked for members and still closed to guests.
    const prelaunch = setup({ now: new Date('2026-09-28T15:00:00Z') });
    await expect(prelaunch.svc.start('2026-09-28', GA)).rejects.toMatchObject(signIn);
    expect((await prelaunch.svc.start(FIRST, GA)).state.ranked).toBe(false);
    expect(rows.size).toBe(0);
    expect(await svc.current(GA, undefined)).toEqual({ run: null });
  });
});

describe('pistas service: members', () => {
  it('a member\'s live-day run is ranked; the 10th settled round writes score and solved at once; /start resumes it', async () => {
    const { svc, find } = setup();
    const first = await svc.start(TODAY, A, makeDay(TODAY).contentVersion);
    expect(first.state).toMatchObject({ day: TODAY, ranked: true });
    expect(find(A, TODAY)).toMatchObject({ user_id: 'user-a', guest_id: null, ranked: true, closes_at: TODAY_CLOSES });
    const shown = await svc.reveal(A, first.run.id, 0);
    expect(await svc.start(TODAY, A)).toEqual(shown);

    let cur = await playRound(svc, A, shown, 0, 1, true);
    for (let r = 1; r < 9; r += 1) cur = await playRound(svc, A, cur, r, r, r % 2 === 1);
    expect(cur.state).toMatchObject({ round: 9, done: false });
    // The last round: its settle finishes the run, ranked, with no /next.
    const last = await svc.guess(A, cur.run.id, cur.run.version, answerOf(9));
    const expected = 8 + (9 + 7 + 5 + 3) + 10;
    expect(last).toMatchObject({ correct: true, state: { done: true, score: expected, solved: 6, rank: 1, ranked: true, round: 9 } });
    expect(last.state.results).toHaveLength(10);
    expect(find(A, TODAY)).toMatchObject({ done: true, score: expected, solved: 6 });
    expect(find(A, TODAY)!.completed_at).toBeInstanceOf(Date);
    await expect(svc.next(A, last.run.id, last.run.version)).rejects.toMatchObject(bad('run_done'));
    expect((await svc.start(TODAY, A)).state).toMatchObject({ done: true, rank: 1 });
    expect(await svc.current(A, undefined)).toMatchObject({ state: { done: true, rank: 1, ranked: true } });
  });

  it('a member\'s closed-day run and a pre-launch run of today are unranked and never reach the board', async () => {
    const { svc, find } = setup();
    const done = await playAll(svc, A, await svc.start(YESTERDAY, A), perfect);
    expect(done.state).toMatchObject({ done: true, score: 100, solved: 10, ranked: false });
    expect(done.state.rank).toBeUndefined();
    expect(find(A, YESTERDAY)).toMatchObject({ ranked: false });
    expect(await svc.leaderboard(YESTERDAY, 'user-a')).toEqual({ day: YESTERDAY, players: 0, top: [], me: null });
    const prelaunch = setup({ now: new Date('2026-09-28T15:00:00Z') });
    expect((await prelaunch.svc.start('2026-09-28', A)).state.ranked).toBe(false);
  });

  it('the leaderboard holds ranked, finished member runs with `solved`; ties go to the earlier finish', async () => {
    const { svc } = setup();
    await playAll(svc, GA, await svc.start(YESTERDAY, GA), perfect);
    await playAll(svc, B, await svc.start(YESTERDAY, B), perfect);
    const a = await playAll(svc, A, await svc.start(TODAY, A), (r) => ({ extra: r === 0 ? 2 : 0, solve: true }));
    const b = await playAll(svc, B, await svc.start(TODAY, B), (r) => ({ extra: 0, solve: r !== 0 }));
    const c = await playAll(svc, member('user-c'), await svc.start(TODAY, member('user-c')), (r) => ({ extra: 0, solve: r !== 0 }));
    await svc.start(TODAY, member('user-d'));
    expect(a.state).toMatchObject({ score: 98, solved: 10, rank: 1 });
    expect(b.state).toMatchObject({ score: 90, solved: 9, rank: 2 });
    expect(c.state).toMatchObject({ score: 90, rank: 3 });
    const board = await svc.leaderboard(undefined, 'user-b');
    expect(board).toMatchObject({ day: TODAY, players: 3, me: { rank: 2, userId: 'user-b', score: 90, solved: 9 } });
    expect(board.top.map((e) => [e.userId, e.score, e.solved])).toEqual([['user-a', 98, 10], ['user-b', 90, 9], ['user-c', 90, 9]]);
    expect(await svc.leaderboard(YESTERDAY, null)).toMatchObject({ players: 0, top: [] });
    expect(await svc.leaderboard('2026-12-25', null)).toEqual({ day: '2026-12-25', players: 0, top: [], me: null });
  });

  it('an unfinished ranked run whose day closed goes on as practice from /start', async () => {
    const { svc, clock, find } = setup();
    const shown = await svc.reveal(A, (await svc.start(TODAY, A)).run.id, 0);
    clock.now = new Date('2026-10-01T15:00:00Z');
    await expect(svc.reveal(A, shown.run.id, shown.run.version)).rejects.toMatchObject(conflict('day_over'));
    const practice = await svc.start(TODAY, A);
    expect(practice).toMatchObject({ run: shown.run, state: { ranked: false, revealed: 2 } });
    expect(find(A, TODAY)).toMatchObject({ ranked: false });
    const lost = await svc.giveUp(A, practice.run.id, practice.run.version);
    // Closed by the database clock now: the missed answer is shown.
    expect(lost.state.settled).toMatchObject({ outcome: 'missed', answer: { display: { en: 'Numero 0' } } });
  });
});

describe('pistas service: moves', () => {
  it('reveal, a wrong guess, the last-chance ceiling, then the final guess', async () => {
    const { svc } = setup();
    let cur = await svc.start(YESTERDAY, GA);
    cur = await svc.reveal(GA, cur.run.id, cur.run.version);
    const miss = await svc.guess(GA, cur.run.id, cur.run.version, 'Nadie');
    expect(miss).toMatchObject({ correct: false, state: { revealed: 2, wrongGuesses: 1, ceiling: 5, canReveal: true, settled: null } });
    cur = miss;
    for (let i = 0; i < 3; i += 1) cur = await svc.reveal(GA, cur.run.id, cur.run.version);
    expect(cur.state).toMatchObject({ revealed: 5, pointsInPlay: 6, canReveal: false });
    expect(cur.state.clues).toHaveLength(5);
    await expect(svc.reveal(GA, cur.run.id, cur.run.version)).rejects.toMatchObject(bad('no_more_clues'));
    const won = await svc.guess(GA, cur.run.id, cur.run.version, ' número-0 ');
    expect(won).toMatchObject({ correct: true, state: { settled: { outcome: 'solved', clues: 5, points: 6 }, score: 6, solved: 1 } });
    await expect(svc.guess(GA, won.run.id, won.run.version, answerOf(0))).rejects.toMatchObject(bad('round_settled'));
    const next = await svc.next(GA, won.run.id, won.run.version);
    expect(next.state).toMatchObject({ round: 1, revealed: 1, wrongGuesses: 0, ceiling: null, settled: null, results: [{ outcome: 'solved', clues: 5, points: 6 }] });
    const twice = await svc.guess(GA, next.run.id, next.run.version, 'x1');
    const out = await svc.guess(GA, twice.run.id, twice.run.version, 'x2');
    expect(out).toMatchObject({ correct: false, state: { settled: { outcome: 'missed', clues: 1, points: 0 }, score: 6 } });
  });

  it('only the run\'s owner may move it', async () => {
    const { svc } = setup();
    const ga = await svc.start(YESTERDAY, GA);
    const am = await svc.start(TODAY, A);
    const notYours = { statusCode: 403, message: 'run_not_yours' };
    await expect(svc.reveal(GB, ga.run.id, 0)).rejects.toMatchObject(notYours);
    await expect(svc.guess(A, ga.run.id, 0, 'x')).rejects.toMatchObject(notYours);
    await expect(svc.giveUp(GA, am.run.id, 0)).rejects.toMatchObject(notYours);
    await expect(svc.next(B, am.run.id, 0)).rejects.toMatchObject(notYours);
    await expect(svc.reveal(A, '00000000-0000-4000-8000-000000000000', 0)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('an outdated version is stale_state (a retry, another tab); an invalid move changes nothing', async () => {
    const { svc, find } = setup();
    const run = await svc.start(TODAY, A);
    await svc.reveal(A, run.run.id, 0);
    await expect(svc.reveal(A, run.run.id, 0)).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.guess(A, run.run.id, 0, answerOf(0))).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.next(A, run.run.id, 1)).rejects.toMatchObject(bad('round_not_settled'));
    expect(find(A, TODAY)).toMatchObject({ state_version: 1 });
    const synced = await svc.start(TODAY, A);
    expect(synced.run).toEqual({ id: run.run.id, version: 1 });
  });

  it('closes an unfinished ranked run at Buenos Aires midnight; unranked runs never close', async () => {
    const { svc, clock, find } = setup();
    const ranked = await svc.reveal(A, (await svc.start(TODAY, A)).run.id, 0);
    const practice = await svc.reveal(GA, (await svc.start(YESTERDAY, GA)).run.id, 0);
    clock.now = new Date('2026-10-01T03:00:01Z');
    await expect(svc.guess(A, ranked.run.id, 1, answerOf(0))).rejects.toMatchObject(conflict('day_over'));
    expect(find(A, TODAY)).toMatchObject({ done: false, state_version: 1 });
    expect((await svc.reveal(GA, practice.run.id, 1)).state.revealed).toBe(3);
  });

  it('the ranked write fence is the database clock: admitted before midnight, committed after is day_over', async () => {
    const { svc, clock, find, hooks } = setup();
    const shown = await svc.reveal(A, (await svc.start(TODAY, A)).run.id, 0);
    clock.now = new Date('2026-10-01T02:59:59Z');
    hooks.onLock = () => { clock.db = new Date('2026-10-01T03:00:01Z'); };
    await expect(svc.guess(A, shown.run.id, 1, answerOf(0))).rejects.toMatchObject(conflict('day_over'));
    expect(find(A, TODAY)).toMatchObject({ done: false, state_version: 1 });
  });
});

describe('pistas service: disclosure', () => {
  it('a missed round of an open day hides its answer for every run; a solved one shows it', async () => {
    const { svc } = setup({ now: new Date('2026-09-28T15:00:00Z') });
    // Before launch: an unranked member run of today still hides missed answers.
    const lost = await svc.giveUp(A, (await svc.start('2026-09-28', A)).run.id, 0);
    expect(lost.state).toMatchObject({ ranked: false, settled: { outcome: 'missed', answer: null } });
    expect(JSON.stringify(lost)).not.toMatch(/umero|ნომერი|Numara/);
    const next = await svc.next(A, lost.run.id, lost.run.version);
    const won = await svc.guess(A, next.run.id, next.run.version, answerOf(1));
    expect(won.state.settled).toMatchObject({ outcome: 'solved', answer: { display: { es: 'Número 1', en: 'Numero 1', ka: 'ნომერი 1', tr: 'Numara 1' } } });
  });

  it('a closed day discloses missed answers only once the database clock has closed it too', async () => {
    const { svc, clock } = setup();
    clock.db = new Date('2026-09-30T02:59:00Z');
    // A member's practice run of yesterday: guests wait for the database clock before they get in at all.
    const run = await svc.start(YESTERDAY, A);
    const lost = await svc.giveUp(A, run.run.id, 0);
    expect(lost.state.settled).toMatchObject({ outcome: 'missed', answer: null });
    await expect(svc.review(YESTERDAY)).rejects.toMatchObject({ statusCode: 404 });
    clock.db = null;
    expect((await svc.current(A, YESTERDAY) as RunResponse).state.settled).toMatchObject({ answer: { display: { en: 'Numero 0' } } });
    expect((await svc.review(YESTERDAY)).rounds).toHaveLength(10);
  });

  it('only revealed clues ever leave the server', async () => {
    const { svc } = setup();
    const run = await svc.start(YESTERDAY, GA);
    const json = JSON.stringify(await svc.reveal(GA, run.run.id, 0));
    expect(json).toContain('pista 0.1');
    expect(json).not.toContain('pista 0.2');
    expect(json).not.toMatch(/accepted|umero/);
  });
});

describe('pistas service: content versions', () => {
  it('start rejects a client on other content; every start and move share-locks its day', async () => {
    const { svc, dayLocks } = setup();
    await expect(svc.start(YESTERDAY, GA, 7)).rejects.toMatchObject(conflict('content_changed'));
    const run = await svc.start(YESTERDAY, GA, makeDay(YESTERDAY).contentVersion);
    const a = await svc.reveal(GA, run.run.id, 0);
    const b = await svc.guess(GA, a.run.id, a.run.version, 'x');
    const c = await svc.giveUp(GA, b.run.id, b.run.version);
    await svc.next(GA, c.run.id, c.run.version);
    expect(dayLocks).toEqual(Array(5).fill(YESTERDAY));
  });

  it('after a correction, moves on the old content are content_changed; /start moves the run onto the new content as it stands, unranked', async () => {
    const { svc, find, correct, version } = setup();
    const run = await svc.start(TODAY, A);
    const shown = await svc.reveal(A, run.run.id, 0);
    const miss = await svc.guess(A, shown.run.id, shown.run.version, 'x');
    correct();
    await expect(svc.reveal(A, run.run.id, miss.run.version)).rejects.toMatchObject(conflict('content_changed'));
    expect(await svc.current(A, TODAY)).toEqual({ run: null });
    const rebased = await svc.start(TODAY, A);
    expect(rebased).toMatchObject({ run: { id: run.run.id, version: 3 }, state: { round: 0, revealed: 2, wrongGuesses: 1, ceiling: 5, ranked: false } });
    expect(find(A, TODAY)).toMatchObject({ content_version: version(TODAY, 1), ranked: false });
    const on = await svc.reveal(A, rebased.run.id, rebased.run.version);
    expect(on.state.revealed).toBe(3);
    expect(await svc.current(A, TODAY)).toEqual(on);
  });

  it('after a correction, a settled round moves on: the corrected answer is never shown for a guess made on the old content', async () => {
    const { svc, correct } = setup();
    const run = await svc.start(TODAY, A);
    const solved = await svc.guess(A, run.run.id, run.run.version, answerOf(0));
    expect(solved.state.settled?.answer).not.toBeNull();
    correct();
    const rebased = await svc.start(TODAY, A);
    expect(rebased.state).toMatchObject({ round: 1, revealed: 1, settled: null, ranked: false, results: [{ outcome: 'solved', clues: 1, points: 10 }] });
  });

  it('after a correction, a finished run keeps its own content and shows none of the new one', async () => {
    const { svc, find, correct, version } = setup();
    const done = await playAll(svc, A, await svc.start(TODAY, A), perfect);
    correct();
    const again = await svc.start(TODAY, A);
    expect(again.run).toEqual(done.run);
    expect(again.state).toMatchObject({ done: true, score: 100, clues: [], settled: { answer: null } });
    expect(find(A, TODAY)).toMatchObject({ content_version: version(TODAY), ranked: false });
  });

  it('a move share-locks the day before it locks the run (the order a seed correction takes)', async () => {
    const { svc, locks } = setup();
    const run = await svc.start(YESTERDAY, A);
    locks.length = 0;
    await svc.reveal(A, run.run.id, run.run.version);
    expect(locks).toEqual([`day:${YESTERDAY}`, `run:${run.run.id}`]);
  });

  it('two misses settle the round with wrongGuesses still 1 in the public state', async () => {
    const { svc } = setup();
    const run = await svc.start(TODAY, A);
    const first = await svc.guess(A, run.run.id, run.run.version, 'x');
    const second = await svc.guess(A, first.run.id, first.run.version, 'y');
    expect(second.state).toMatchObject({ wrongGuesses: 1, settled: { outcome: 'missed' } });
  });

  it('a correction committed while this replica still serves the old content: starts and moves are content_changed, never judged', async () => {
    const { svc, find, stale, correctDatabase, refreshCache, version } = setup();
    const ranked = await svc.start(TODAY, A);
    correctDatabase();
    await expect(svc.guess(A, ranked.run.id, 0, answerOf(0))).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.start(YESTERDAY, GA)).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.start(TODAY, A)).rejects.toMatchObject(conflict('content_changed'));
    expect(find(A, TODAY)).toMatchObject({ state_version: 0, content_version: version(TODAY) });
    expect(find(GA, YESTERDAY)).toBeUndefined();
    expect(stale.count).toBe(3);
    refreshCache();
    expect((await svc.start(TODAY, A)).state).toMatchObject({ ranked: false, revealed: 1 });
  });

  it('the run UPDATE itself requires the stored day version: 0 rows is content_changed, not day_over', async () => {
    const { svc, find, hooks, stored, version } = setup();
    const run = await svc.start(TODAY, A);
    hooks.onDayLock = () => { stored.set(TODAY, version(TODAY, 1)); };
    await expect(svc.reveal(A, run.run.id, 0)).rejects.toMatchObject(conflict('content_changed'));
    expect(find(A, TODAY)).toMatchObject({ state_version: 0 });
  });
});

describe('pistas boards and review', () => {
  it('the index lists playable days with their versions and when ranking starts; no content, no future day', async () => {
    const { svc, clock, version } = setup();
    const days = await svc.boards();
    expect(days).toEqual({
      days: { '2026-09-27': version('2026-09-27'), '2026-09-28': version('2026-09-28'), [YESTERDAY]: version(YESTERDAY), [TODAY]: version(TODAY) },
      rankedFrom: '2026-09-29',
    });
    clock.now = new Date('2026-10-01T03:00:00Z');
    expect(Object.keys((await svc.boards()).days)).toContain('2026-10-01');
  });

  it('reviews a closed day in full (clues and display names, never the accepted list); today, future and unknown days are the same 404', async () => {
    const { svc } = setup();
    const review = await svc.review(YESTERDAY);
    expect(review.day).toBe(YESTERDAY);
    expect(review.rounds[0]).toEqual({ number: 1, answer: { display: { es: 'Número 0', en: 'Numero 0', ka: 'ნომერი 0', tr: 'Numara 0' } }, clues: indexOf(makeDay(YESTERDAY)).get(YESTERDAY)!.rounds[0].clues });
    expect(review.rounds[9].clues).toHaveLength(10);
    expect(JSON.stringify(review)).not.toMatch(/accepted|"id"|N 0/);
    const errorOf = (day: string) => svc.review(day).then(() => null, (e: { statusCode: number; message: string }) => ({ statusCode: e.statusCode, message: e.message }));
    const today = await errorOf(TODAY);
    expect(today).toEqual({ statusCode: 404, message: 'Day not available' });
    for (const day of ['2026-10-01', '2026-09-26', '2027-01-01']) expect(await errorOf(day)).toEqual(today);
  });

  it('the stored days are the calendar: an appended day opens ranked on its date, a day past a hole never opens', async () => {
    const run = (n: number) => Array.from({ length: n }, (_, i) => addDays('2026-09-27', i));
    const oct27 = new Date('2026-10-27T15:00:00Z');
    // 30 days stored, as first seeded: the 31st date has nothing, and the last day goes on unranked.
    const ended = setup({ now: oct27, days: run(30) });
    await expect(ended.svc.start('2026-10-27', A)).rejects.toMatchObject({ statusCode: 404 });
    expect((await ended.svc.start('2026-10-26', A)).state.ranked).toBe(false);
    expect((await ended.svc.leaderboard(undefined, null)).day).toBe('2026-10-26');
    // One more stored day, no release: it is the live, ranked day.
    const appended = setup({ now: oct27, days: run(31) });
    expect((await appended.svc.start('2026-10-27', A)).state.ranked).toBe(true);
    expect(Object.keys((await appended.svc.boards()).days).at(-1)).toBe('2026-10-27');
    expect((await appended.svc.leaderboard(undefined, null)).day).toBe('2026-10-27');
    // A stored day beyond a missing one is not released, whatever the date.
    const holed = setup({ now: new Date('2026-10-29T15:00:00Z'), days: [...run(30), '2026-10-28', '2026-10-29'] });
    await expect(holed.svc.start('2026-10-29', A)).rejects.toMatchObject({ statusCode: 404 });
    expect(Object.keys((await holed.svc.boards()).days).at(-1)).toBe('2026-10-26');
  });

  it('a run of a day the calendar no longer reaches is neither played on nor disclosed', async () => {
    const { svc, serve } = setup();
    const run = await svc.start(YESTERDAY, GA);
    // 2026-09-28 is gone: yesterday is stored beyond a hole, so the calendar ends at the first day.
    serve(['2026-09-27', YESTERDAY, TODAY]);
    await expect(svc.giveUp(GA, run.run.id, run.run.version)).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.current(GA, YESTERDAY)).toEqual({ run: null });
    await expect(svc.review(YESTERDAY)).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.leaderboard(YESTERDAY, 'user-a')).toEqual({ day: YESTERDAY, players: 0, top: [], me: null });
    // The hole filled, the run is there again, untouched.
    serve(['2026-09-27', '2026-09-28', YESTERDAY, TODAY]);
    expect(await svc.current(GA, YESTERDAY)).toMatchObject({ run: { id: run.run.id, version: run.run.version } });
  });

  it('with no days seeded every day is a 404 and the index is empty', async () => {
    const { svc } = setup({ days: [] });
    expect(await svc.boards()).toEqual({ days: {}, rankedFrom: '2026-09-29' });
    await expect(svc.start(YESTERDAY, GA)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.review(YESTERDAY)).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.current(A, undefined)).toEqual({ run: null });
    expect(await svc.leaderboard(undefined, 'user-a')).toEqual({ day: TODAY, players: 0, top: [], me: null });
  });
});
