import { describe, expect, it } from 'vitest';
import { createBuscaminasService, type BuscaminasDeps } from '../../src/modules/buscaminas/buscaminas.service.js';
import { indexContent, type ContentIndex } from '../../src/modules/buscaminas/buscaminas.content.js';
import { RUN_TOKEN_TTL_SECONDS } from '../../src/modules/buscaminas/buscaminas.constants.js';
import { unavailable } from '../../src/modules/buscaminas/buscaminas.errors.js';
import { newPayload, perfects } from '../../src/modules/buscaminas/buscaminas.rules.js';
import { signToken, verifyToken } from '../../src/modules/buscaminas/buscaminas.token.js';
import { memoryRunLedger, memoryStartCounter, type RunLedger, type StartCounter } from '../../src/modules/buscaminas/buscaminas.ledger.js';
import type { BuscaminasRunRow } from '../../src/modules/buscaminas/buscaminas.types.js';
import { makeDay, mineCards, okCards } from './fixtures.js';

const SECRET = 's'.repeat(64);
const TODAY = '2026-09-28';
const NOW = new Date('2026-09-28T15:00:00Z');
const TODAY_CLOSES = new Date('2026-09-29T03:00:00Z');

const entry = (r: BuscaminasRunRow, rank: number) => ({
  rank, userId: r.user_id, username: r.user_id, avatarUrl: null, avatarCustomization: null, country: null, tier: null, score: r.score!, perfects: r.perfects!,
});

/** In-memory repo; `saveState` applies the same statement-time cutoff as the SQL (`clock < closesAt`). */
function memoryRepo(now: () => Date) {
  const rows = new Map<string, BuscaminasRunRow & { completedMs: number }>();
  const cutoffs: Date[] = [];
  const hooks: { onLock?: () => void } = {};
  const key = (u: string, d: string) => `${u}|${d}`;
  const clone = <T>(x: T): T => structuredClone(x);
  let clock = 0;
  const repo: BuscaminasDeps['repo'] = {
    withTx: (fn) => fn({} as never),
    async insertRun(_tx, d) {
      if (rows.has(key(d.userId, d.day))) return null;
      const row = { id: d.id, user_id: d.userId, day: d.day, content_version: d.contentVersion, state: clone(d.state), state_version: d.state.sv, done: false, score: null, perfects: null, completed_at: null, completedMs: 0 };
      rows.set(key(d.userId, d.day), row);
      return clone(row);
    },
    async lockRun(_tx, u, d) {
      hooks.onLock?.();
      const r = rows.get(key(u, d));
      return r ? clone(r) : null;
    },
    async getRun(u, d) { const r = rows.get(key(u, d)); return r ? clone(r) : null; },
    async saveState(_tx, id, d) {
      cutoffs.push(d.closesAt);
      if (now().getTime() >= d.closesAt.getTime()) return null;
      const row = [...rows.values()].find((r) => r.id === id)!;
      Object.assign(row, {
        state: clone(d.state), state_version: d.state.sv, content_version: d.contentVersion, done: d.completion !== null,
        score: d.completion?.score ?? null, perfects: d.completion?.perfects ?? null,
        completed_at: d.completion ? new Date() : null, completedMs: d.completion ? ++clock : 0,
      });
      return clone(row);
    },
    async rankOf(u, d) {
      const me = rows.get(key(u, d));
      if (!me?.done) return null;
      const better = [...rows.values()].filter((o) => o.day === d && o.done && (o.score! > me.score! || (o.score === me.score && o.completedMs < me.completedMs)));
      return entry(me, better.length + 1);
    },
    async leaderboard(d, limit) {
      const done = [...rows.values()].filter((r) => r.day === d && r.done).sort((a, b) => b.score! - a.score! || a.completedMs - b.completedMs);
      return { players: done.length, top: done.slice(0, limit).map((r, i) => entry(r, i + 1)) };
    },
  };
  return { repo, rows, cutoffs, hooks };
}

/** Any Redis use fails the test: the ranked path must never touch it. */
const noRedis: RunLedger & StartCounter = {
  claim: async () => { throw new Error('ranked path touched the run ledger'); },
  consumed: async () => { throw new Error('ranked path touched the run ledger'); },
  hit: async () => { throw new Error('ranked path touched the start counter'); },
};

/** `guestsPlayLive` defaults to the production default (off) and can be flipped mid-test via `flags`. */
function setup(opts: { now?: Date; days?: string[]; ledger?: RunLedger; starts?: StartCounter; limit?: number; guestsPlayLive?: boolean } = {}) {
  const days = opts.days ?? ['2026-09-27', TODAY, '2026-09-29'];
  let content: ContentIndex = indexContent(days.map((d) => makeDay(d)));
  const clock = { now: opts.now ?? NOW };
  const flags = { guestsPlayLive: opts.guestsPlayLive ?? false };
  const mem = memoryRepo(() => clock.now);
  const starts = memoryStartCounter();
  const ledger = memoryRunLedger();
  const svc = createBuscaminasService({
    repo: mem.repo,
    ledger: opts.ledger ?? ledger,
    starts: opts.starts ?? starts,
    guestsPlayLive: () => flags.guestsPlayLive,
    liveStartsPerDay: () => opts.limit ?? 8,
    content: async () => content,
    secret: () => SECRET,
    now: () => clock.now,
  });
  return { svc, clock, flags, starts, ledger, ...mem, bumpContent: () => { content = indexContent(days.map((d) => makeDay(d, 2))); } };
}

/** Round r: tap `hits` correct cards then bank (or a perfect when hits = 12). */
async function playRound(svc: ReturnType<typeof setup>['svc'], token: string, r: number, hits: number, user: string | null) {
  let t = token;
  for (const id of okCards(r).slice(0, hits)) t = (await svc.tap(t, id, user)).token;
  if (hits < 12) t = (await svc.bank(t, user)).token;
  return svc.next(t, user);
}

const conflict = (code: string) => ({ statusCode: 409, code });
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

describe('buscaminas service', () => {
  it('guests allowed on the live day get an unranked stateless run with an expiring token; future and unknown days are 404', async () => {
    const { svc, rows } = setup({ guestsPlayLive: true });
    const run = await svc.start(TODAY, null);
    expect(run.state).toMatchObject({ day: TODAY, round: 0, ranked: false, score: 0, done: false });
    const { payload, claims } = verifyToken(run.token, SECRET);
    expect(payload.u).toBeNull();
    expect(claims).toEqual({ iat: seconds(NOW), exp: seconds(NOW) + RUN_TOKEN_TTL_SECONDS });
    await expect(svc.start('2026-09-29', null)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.start('2026-09-25', null)).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.tap(run.token, 'r0c0', null)).ok).toBe(true);
    expect(rows.size).toBe(0);
  });

  it('a signed-in past-day run is unranked and never stored', async () => {
    const { svc, rows } = setup();
    const run = await svc.start('2026-09-27', 'user-a');
    expect(run.state.ranked).toBe(false);
    expect(verifyToken(run.token, SECRET).payload.u).toBeNull();
    expect(rows.size).toBe(0);
  });

  it('by default guests cannot start the live ranked day (403 sign_in_for_today); signed-in users get the ranked run; no per-address cap', async () => {
    const { svc, rows } = setup({ starts: noRedis, limit: 1 });
    const refused = { statusCode: 403, code: 'sign_in_for_today' };
    await expect(svc.start(TODAY, null)).rejects.toMatchObject(refused);
    // The policy answers before a stale page's content check; unknown and future days stay 404.
    await expect(svc.start(TODAY, null, 7)).rejects.toMatchObject(refused);
    await expect(svc.start('2026-09-29', null)).rejects.toMatchObject({ statusCode: 404 });
    const ranked = await svc.start(TODAY, 'user-a');
    expect(ranked.state).toMatchObject({ day: TODAY, ranked: true });
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ state_version: 0 });
    expect((await svc.tap(ranked.token, 'r0c0', 'user-a')).ok).toBe(true);
  });

  it('by default guests play past days, uncapped, with the full reveal', async () => {
    const { svc, rows } = setup({ starts: noRedis, limit: 1 });
    const runs = await Promise.all([1, 2, 3].map(() => svc.start('2026-09-27', null, undefined, '203.0.113.7')));
    expect(runs.map((r) => r.state.ranked)).toEqual([false, false, false]);
    const hit = await svc.tap(runs[0].token, 'r0c0', null);
    expect(hit.ok).toBe(true);
    const mine = await svc.tap(hit.token, 'r0c12', null);
    expect(mine.state.settled).toMatchObject({ outcome: 'mine', found: 1, reveal: { ok: okCards(0), mines: mineCards(0) } });
    expect(rows.size).toBe(0);
  });

  it('with guests allowed live they start the live day unranked; turning it off refuses their live-day tokens', async () => {
    const { svc, flags } = setup({ guestsPlayLive: true });
    const live = await svc.start(TODAY, null);
    expect(live.state).toMatchObject({ day: TODAY, ranked: false });
    const tapped = await svc.tap(live.token, 'r0c0', null);
    const past = await svc.start('2026-09-27', null);
    flags.guestsPlayLive = false;
    await expect(svc.tap(tapped.token, 'r0c1', null)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });
    await expect(svc.bank(tapped.token, null)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });
    expect((await svc.tap(past.token, 'r0c0', null)).ok).toBe(true);
  });

  it('Redis state loss: a live-day unranked token past its first action is stale; a past-day token fails open', async () => {
    const { svc, ledger } = setup({ guestsPlayLive: true });
    const tapped = await svc.tap((await svc.start(TODAY, null)).token, 'r0c0', null);
    const past = await svc.tap((await svc.start('2026-09-27', null)).token, 'r0c0', null);
    ledger.runs.clear();
    await expect(svc.tap(tapped.token, 'r0c1', null)).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.bank(tapped.token, null)).rejects.toMatchObject(conflict('stale_state'));
    // An invalid move on a lost run is stale too, not a 400 implying the token is still usable.
    await expect(svc.tap(tapped.token, 'r0c0', null)).rejects.toMatchObject(conflict('stale_state'));
    expect((await svc.tap(past.token, 'r0c1', null)).ok).toBe(true);
    // A run started after the loss records its first action and plays on normally.
    const first = await svc.tap((await svc.start(TODAY, null)).token, 'r0c0', null);
    expect((await svc.tap(first.token, 'r0c1', null)).ok).toBe(true);
  });

  it('rejects tokens minted against superseded content with content_changed', async () => {
    const { svc, bumpContent } = setup({ guestsPlayLive: true });
    const run = await svc.start(TODAY, null);
    bumpContent();
    await expect(svc.tap(run.token, 'r0c0', null)).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.bank(run.token, null)).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.next(run.token, null)).rejects.toMatchObject(conflict('content_changed'));
  });

  it('start rejects a page built from other content; tap rejects a card the round lacks', async () => {
    const { svc } = setup({ guestsPlayLive: true });
    await expect(svc.start(TODAY, null, 7)).rejects.toMatchObject(conflict('content_changed'));
    const run = await svc.start(TODAY, null, 1);
    await expect(svc.tap(run.token, 'not-a-card', null)).rejects.toMatchObject(conflict('content_changed'));
  });

  it('accepts content-hash versions up to 2^32', async () => {
    const hash = 2 ** 32;
    const svc = createBuscaminasService({
      repo: memoryRepo(() => NOW).repo, ledger: memoryRunLedger(), starts: memoryStartCounter(), guestsPlayLive: () => false, liveStartsPerDay: () => 8,
      content: async () => indexContent([makeDay(TODAY, hash)]), secret: () => SECRET, now: () => NOW,
    });
    const run = await svc.start(TODAY, 'user-a', hash);
    expect(verifyToken(run.token, SECRET).payload.cv).toBe(hash);
    expect((await svc.tap(run.token, 'r0c0', 'user-a')).ok).toBe(true);
  });

  it('unranked tokens are single-use: the same action replays its response, anything else is stale', async () => {
    const { svc, clock } = setup({ guestsPlayLive: true });
    const run = await svc.start(TODAY, null);
    const first = await svc.tap(run.token, 'r0c0', null);
    clock.now = new Date(NOW.getTime() + 5_000);
    // The retry is rebuilt from the first issue time, so even its token is identical.
    expect(await svc.tap(run.token, 'r0c0', null)).toEqual(first);
    await expect(svc.tap(run.token, 'r0c12', null)).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.bank(run.token, null)).rejects.toMatchObject(conflict('stale_state'));
    const banked = await svc.bank(first.token, null);
    await expect(svc.tap(first.token, 'r0c1', null)).rejects.toMatchObject(conflict('stale_state'));
    expect((await svc.next(banked.token, null)).state.round).toBe(1);
  });

  it('an invalid move does not consume the token', async () => {
    const { svc } = setup({ guestsPlayLive: true });
    const run = await svc.start(TODAY, null);
    await expect(svc.bank(run.token, null)).rejects.toMatchObject({ statusCode: 400 });
    expect((await svc.tap(run.token, 'r0c0', null)).ok).toBe(true);
  });

  it('an expired unranked token is stale even when the ledger has forgotten the run', async () => {
    const { svc, clock } = setup({ guestsPlayLive: true });
    const run = await svc.start(TODAY, null);
    const tapped = await svc.tap(run.token, 'r0c0', null);
    const { claims } = verifyToken(tapped.token, SECRET);
    clock.now = new Date((claims!.exp - 1) * 1000);
    expect((await svc.tap(tapped.token, 'r0c1', null)).ok).toBe(true);

    // A fresh ledger stands in for a Redis flush/eviction: only the expiry still guards old tokens.
    const flushed = setup({ guestsPlayLive: true });
    const old = await flushed.svc.start(TODAY, null);
    flushed.clock.now = new Date((verifyToken(old.token, SECRET).claims!.exp) * 1000);
    await expect(flushed.svc.tap(old.token, 'r0c0', null)).rejects.toMatchObject(conflict('stale_state'));
    await expect(flushed.svc.bank(old.token, null)).rejects.toMatchObject(conflict('stale_state'));

    const unclaimed = signToken(newPayload('rid-x', TODAY, 1, null), SECRET);
    await expect(flushed.svc.tap(unclaimed, 'r0c0', null)).rejects.toMatchObject(conflict('stale_state'));
  });

  it('never reveals a live day, ranked or not; archive days reveal the answers', async () => {
    const { svc } = setup({ guestsPlayLive: true });
    const live = await svc.start(TODAY, null);
    const mine = await svc.tap(live.token, 'r0c12', null);
    expect(mine.ok).toBe(false);
    expect(mine.state).toMatchObject({ mine: 'r0c12', settled: { outcome: 'mine', found: 0, points: 0, reveal: null } });
    expect(JSON.stringify(mine)).not.toContain('r0c13');

    const ranked = await svc.start(TODAY, 'user-a');
    const rankedMine = await svc.tap(ranked.token, 'r0c13', 'user-a');
    expect(rankedMine.ok).toBe(false);
    expect(rankedMine.state).toMatchObject({ ranked: true, mine: 'r0c13', settled: { outcome: 'mine', reveal: null } });
    expect(JSON.stringify(rankedMine)).not.toContain('r0c12');
    const rankedNext = await svc.next(rankedMine.token, 'user-a');
    let t = rankedNext.token;
    for (const id of okCards(1)) t = (await svc.tap(t, id, 'user-a')).token;
    const perfect = await svc.current('user-a', TODAY);
    expect(perfect).toMatchObject({ state: { settled: { outcome: 'perfect', reveal: null } } });
    expect(JSON.stringify(perfect)).not.toContain(mineCards(1)[0]);

    const archive = await svc.start('2026-09-27', null);
    const archived = await svc.tap(archive.token, 'r0c12', null);
    expect(archived.state.settled?.reveal).toEqual({ ok: okCards(0), mines: mineCards(0) });
  });

  it('ranked run: resume on start, reject forks, persist score and rank', async () => {
    const { svc, rows } = setup();
    const first = await svc.start(TODAY, 'user-a');
    expect(first.state.ranked).toBe(true);
    expect(verifyToken(first.token, SECRET).claims).toBeNull();
    const tapped = await svc.tap(first.token, 'r0c0', 'user-a');
    const resumed = await svc.start(TODAY, 'user-a');
    expect(resumed.token).toBe(tapped.token);
    expect(resumed.state.picked).toEqual(['r0c0']);

    await expect(svc.tap(first.token, 'r0c1', 'user-a')).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.tap(tapped.token, 'r0c1', 'user-b')).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.tap(tapped.token, 'r0c1', null)).rejects.toMatchObject({ statusCode: 403 });

    let t = tapped.token;
    for (const id of okCards(0).slice(1)) t = (await svc.tap(t, id, 'user-a')).token;
    let res = await svc.next(t, 'user-a');
    await expect(svc.next(t, 'user-a')).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.bank(t, 'user-a')).rejects.toMatchObject(conflict('stale_state'));
    for (let r = 1; r < 20; r += 1) res = await playRound(svc, res.token, r, r % 2 ? 12 : 5, 'user-a');
    expect(res.state.done).toBe(true);
    expect(res.state.rank).toBe(1);
    const expected = 15 + 10 * 15 + 9 * 5;
    expect(res.state.score).toBe(expected);
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ done: true, score: expected, perfects: perfects(res.state.results) });
    await expect(svc.next(res.token, 'user-a')).rejects.toMatchObject({ statusCode: 400, message: 'run_done' });

    let rb = await svc.start(TODAY, 'user-b');
    for (let r = 0; r < 20; r += 1) rb = await playRound(svc, rb.token, r, 12, 'user-b');
    expect(rb.state).toMatchObject({ score: 300, rank: 1 });

    const board = await svc.leaderboard(undefined, 'user-a');
    expect(board).toMatchObject({ day: TODAY, players: 2, me: { rank: 2, userId: 'user-a', score: expected } });
    expect(board.top.map((e) => e.score)).toEqual([300, expected]);
    expect(await svc.current('user-a', undefined)).toMatchObject({ state: { done: true, rank: 2, ranked: true } });
    expect(await svc.current('user-c', undefined)).toEqual({ run: null });
  });

  it('ranked retries use only the row: an old token is stale_state and /start re-syncs, with no Redis at all', async () => {
    const { svc, rows } = setup({ ledger: noRedis, starts: noRedis });
    const run = await svc.start(TODAY, 'user-a');
    const tapped = await svc.tap(run.token, 'r0c0', 'user-a');
    expect(tapped.ok).toBe(true);
    // A network retry of the committed tap: the row has moved on.
    await expect(svc.tap(run.token, 'r0c0', 'user-a')).rejects.toMatchObject(conflict('stale_state'));
    await expect(svc.bank(run.token, 'user-a')).rejects.toMatchObject(conflict('stale_state'));
    const synced = await svc.start(TODAY, 'user-a');
    expect(synced).toEqual({ token: tapped.token, state: tapped.state });
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ state_version: 1 });
    expect((await svc.bank(synced.token, 'user-a')).state.settled).toMatchObject({ outcome: 'banked', found: 1 });
  });

  it('a forged rid for the same user and version is rejected', async () => {
    const { svc, rows } = setup();
    const run = await svc.start(TODAY, 'user-a');
    rows.get(`user-a|${TODAY}`)!.id = 'another-run';
    await expect(svc.tap(run.token, 'r0c0', 'user-a')).rejects.toMatchObject(conflict('stale_state'));
  });

  it('closes an unfinished ranked run at Buenos Aires midnight', async () => {
    const { svc, clock, rows } = setup();
    const run = await svc.start(TODAY, 'user-a');
    const tapped = await svc.tap(run.token, 'r0c0', 'user-a');
    clock.now = new Date('2026-09-29T03:00:01Z');
    await expect(svc.tap(tapped.token, 'r0c1', 'user-a')).rejects.toMatchObject(conflict('day_over'));
    await expect(svc.bank(tapped.token, 'user-a')).rejects.toMatchObject(conflict('day_over'));
    await expect(svc.current('user-a', TODAY)).rejects.toMatchObject(conflict('day_over'));
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ done: false, state_version: 1 });
    expect((await svc.start(TODAY, 'user-a')).state.ranked).toBe(false);
    expect(await svc.current('user-a', undefined)).toEqual({ run: null });
  });

  it('the ranked UPDATE carries the day cutoff: admitted before midnight but committed after is day_over', async () => {
    const { svc, clock, rows, cutoffs, hooks } = setup();
    const run = await svc.start(TODAY, 'user-a');
    const tapped = await svc.tap(run.token, 'r0c0', 'user-a');
    expect(cutoffs).toEqual([TODAY_CLOSES]);

    clock.now = new Date('2026-09-29T02:59:59Z');
    hooks.onLock = () => { clock.now = new Date('2026-09-29T03:00:01Z'); };
    await expect(svc.bank(tapped.token, 'user-a')).rejects.toMatchObject(conflict('day_over'));
    expect(cutoffs).toEqual([TODAY_CLOSES, TODAY_CLOSES]);
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ done: false, state_version: 1 });
  });

  it('when guests may play live, caps fresh unranked runs of a live day per address per Buenos Aires day', async () => {
    const { svc, clock, starts } = setup({ limit: 3, guestsPlayLive: true });
    for (let i = 0; i < 3; i += 1) await svc.start(TODAY, null, undefined, '203.0.113.7');
    await expect(svc.start(TODAY, null, undefined, '203.0.113.7')).rejects.toMatchObject({ statusCode: 429, code: 'too_many_runs' });
    expect((await svc.start(TODAY, null, undefined, '198.51.100.1')).state.ranked).toBe(false);
    // Archive days are already public, and a signed-in ranked start is one row per user: neither counts.
    expect((await svc.start('2026-09-27', null, undefined, '203.0.113.7')).state.ranked).toBe(false);
    expect((await svc.start(TODAY, 'user-a', undefined, '203.0.113.7')).state.ranked).toBe(true);
    expect(starts.counts.get(`${TODAY}:203.0.113.7`)).toBe(4);
    expect([...starts.counts.keys()].some((k) => k.startsWith('2026-09-27'))).toBe(false);

    clock.now = new Date('2026-09-29T15:00:00Z');
    expect((await svc.start('2026-09-29', null, undefined, '203.0.113.7')).state.day).toBe('2026-09-29');
  });

  it('a Redis failure is a 503 from start and from unranked actions', async () => {
    const down: RunLedger & StartCounter = {
      claim: async () => { throw unavailable(); },
      consumed: async () => { throw unavailable(); },
      hit: async () => { throw unavailable(); },
    };
    const outage = { statusCode: 503, code: 'buscaminas_unavailable' };
    const { svc } = setup({ ledger: down, starts: down, guestsPlayLive: true });
    await expect(svc.start(TODAY, null)).rejects.toMatchObject(outage);
    const iat = seconds(NOW);
    const token = signToken(newPayload('rid-y', TODAY, 1, null), SECRET, { iat, exp: iat + 60 });
    await expect(svc.tap(token, 'r0c0', null)).rejects.toMatchObject(outage);
    await expect(svc.bank(token, null)).rejects.toMatchObject(outage);
    expect((await svc.start('2026-09-27', null)).state.ranked).toBe(false);
    expect((await svc.start(TODAY, 'user-a')).state.ranked).toBe(true);
  });

  it('never resets a ranked row to other content unless the client already loaded it', async () => {
    const { svc, rows, bumpContent } = setup();
    const run = await svc.start(TODAY, 'user-a');
    await svc.tap(run.token, 'r0c0', 'user-a');
    bumpContent();
    expect(await svc.current('user-a', TODAY)).toEqual({ run: null });
    await expect(svc.start(TODAY, 'user-a')).rejects.toMatchObject(conflict('content_changed'));
    await expect(svc.start(TODAY, 'user-a', 1)).rejects.toMatchObject(conflict('content_changed'));
    expect(rows.get(`user-a|${TODAY}`)).toMatchObject({ content_version: 1, state_version: 1 });
    const restarted = await svc.start(TODAY, 'user-a', 2);
    expect(restarted.state).toMatchObject({ round: 0, picked: [], ranked: true });
    expect(verifyToken(restarted.token, SECRET).payload).toMatchObject({ cv: 2, sv: 2 });
    expect((await svc.tap(restarted.token, 'r0c0', 'user-a')).ok).toBe(true);
  });

  it('before launch the launch puzzle is an unranked, unrevealed preview for everyone; after the last day nothing is ranked', async () => {
    const PRE_NOW = new Date('2026-09-25T15:00:00Z');
    // Guests off the live day (default): there is no ranked day yet, so the preview stays open to guests, uncapped.
    const pre = setup({ now: PRE_NOW, days: ['2026-09-26'], starts: noRedis, limit: 1 });
    const preview = await pre.svc.start('2026-09-26', 'user-a');
    expect(preview.state.ranked).toBe(false);
    expect(pre.rows.size).toBe(0);
    expect((await pre.svc.tap(preview.token, 'r0c12', 'user-a')).state.settled?.reveal).toBeNull();
    const guest = await pre.svc.start('2026-09-26', null);
    await pre.svc.start('2026-09-26', null);
    expect(guest.state.ranked).toBe(false);
    const tapped = await pre.svc.tap(guest.token, 'r0c0', null);
    expect(tapped.ok).toBe(true);
    // It is still a secret day: its ledger fails closed on a lost entry.
    pre.ledger.runs.clear();
    await expect(pre.svc.tap(tapped.token, 'r0c1', null)).rejects.toMatchObject(conflict('stale_state'));
    expect(await pre.svc.current('user-a', undefined)).toEqual({ run: null });
    // At launch midnight the preview day becomes the ranked day: a carried-over guest token is refused.
    const carried = await pre.svc.start('2026-09-26', null);
    pre.clock.now = new Date('2026-09-26T15:00:00Z');
    await expect(pre.svc.tap(carried.token, 'r0c0', null)).rejects.toMatchObject({ statusCode: 403, code: 'sign_in_for_today' });

    // Guests allowed on the live day: the preview counts against the per-address cap, as a live start.
    const capped = setup({ now: PRE_NOW, days: ['2026-09-26'], guestsPlayLive: true });
    expect((await capped.svc.start('2026-09-26', 'user-a')).state.ranked).toBe(false);
    expect(capped.starts.counts.get('2026-09-25:unknown')).toBe(1);

    const post = setup({ now: new Date('2026-12-26T15:00:00Z'), days: ['2026-12-24'] });
    expect((await post.svc.start('2026-12-24', 'user-a')).state.ranked).toBe(false);
    expect(post.rows.size).toBe(0);
    expect(post.starts.counts.size).toBe(0);
    expect(await post.svc.leaderboard('2026-12-25', null)).toEqual({ day: '2026-12-25', players: 0, top: [], me: null });
    expect((await post.svc.leaderboard(undefined, null)).day).toBe('2026-12-24');
  });
});

describe('buscaminas boards', () => {
  const expectNoAnswers = (value: unknown) => expect(JSON.stringify(value)).not.toMatch(/"ok"|"mines"|"reveal"/);

  it('serves a past or the live board without any ok flag; its day decides how long it may be cached', async () => {
    const { svc } = setup();
    const past = await svc.board('2026-09-27');
    expect(past.live).toBe(false);
    expect(past.board).toEqual({
      day: '2026-09-27', number: 2, contentVersion: 1,
      rounds: makeDay('2026-09-27').rounds.map((r) => ({ id: r.id, difficulty: r.difficulty, prompt: r.prompt, cards: r.cards.map(({ id, name, img }) => ({ id, name, img })) })),
    });
    expect(past.board.rounds[0].cards[0]).toEqual({ id: 'r0c0', name: 'Player 0-0', img: '/buscaminas/v1/p/r0c0.webp' });
    expectNoAnswers(past);
    const live = await svc.board(TODAY);
    expect(live).toMatchObject({ live: true, board: { day: TODAY, number: 3 } });
    expect(live.board.rounds).toHaveLength(20);
    expect(live.board.rounds[0].prompt).toEqual({ es: 'pista 0', en: 'clue 0', ka: 'მინიშნება 0', tr: 'ipucu 0' });
    expectNoAnswers(live);
  });

  it('a future day is the same 404 as a day with no content, until it opens at Buenos Aires midnight', async () => {
    const { svc, clock } = setup();
    const errorOf = (day: string) => svc.board(day).then(() => null, (e: { statusCode: number; code: string; message: string; details: unknown }) =>
      ({ statusCode: e.statusCode, code: e.code, message: e.message, details: e.details }));
    const tomorrow = await errorOf('2026-09-29');
    expect(tomorrow).toMatchObject({ statusCode: 404 });
    for (const day of ['2026-09-30', '2026-09-25', '2027-01-01', '2026-02-30']) expect(await errorOf(day)).toEqual(tomorrow);
    expect((await svc.boards()).days).toEqual({ '2026-09-27': 1, [TODAY]: 1 });

    clock.now = new Date('2026-09-29T02:59:59Z');
    expect(await errorOf('2026-09-29')).toEqual(tomorrow);
    clock.now = new Date('2026-09-29T03:00:00Z');
    expect(await svc.board('2026-09-29')).toMatchObject({ live: true, board: { day: '2026-09-29' } });
    expect((await svc.board(TODAY)).live).toBe(false);
    expect((await svc.boards()).days).toEqual({ '2026-09-27': 1, [TODAY]: 1, '2026-09-29': 1 });
  });

  it('the index lists only playable days with their content versions', async () => {
    const { svc, bumpContent } = setup();
    bumpContent();
    expect(await svc.boards()).toEqual({ days: { '2026-09-27': 2, [TODAY]: 2 } });
  });

  it('before launch only the preview board is open (live); after the last day the final board is archived', async () => {
    const pre = setup({ now: new Date('2026-09-25T15:00:00Z'), days: ['2026-09-26', '2026-09-27'] });
    expect((await pre.svc.board('2026-09-26')).live).toBe(true);
    await expect(pre.svc.board('2026-09-27')).rejects.toMatchObject({ statusCode: 404 });
    expect(await pre.svc.boards()).toEqual({ days: { '2026-09-26': 1 } });

    const post = setup({ now: new Date('2026-12-26T15:00:00Z'), days: ['2026-12-23', '2026-12-24'] });
    expect((await post.svc.board('2026-12-24')).live).toBe(false);
    await expect(post.svc.board('2026-12-25')).rejects.toMatchObject({ statusCode: 404 });
    expect(await post.svc.boards()).toEqual({ days: { '2026-12-23': 1, '2026-12-24': 1 } });
  });
});
