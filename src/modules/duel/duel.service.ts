import { createHash } from 'node:crypto';
import type { TransactionSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BM_TIERS } from './engines/buscaminas.engine.js';
import { UL_TIERS } from './engines/ultimo.engine.js';
import { currentEngine, engineFor, type AnyEngine } from './duel.registry.js';
import { duelRepo, type DuelMatchRow, type DuelParticipantRow, type DuelResult, type DuelStatus } from './duel.repo.js';
import { newSeed, seededRng } from './duel.rng.js';
import { DUEL_LOCALES, DuelRuleError, type DuelGameId, type DuelLocale, type EngineOutcome, type Seat } from './duel.types.js';

/** Both seats must say ready within this, or the match is cancelled and both go back to the room. */
export const DUEL_READY_MS = 20_000;
/** The match intro (versus screen + 3-2-1) between both seats ready and the first game clock. */
export const DUEL_COUNTDOWN_MS = 5_000;
/** How long one disconnection may last before it forfeits (capped by the seat's remaining absence budget). */
export const DUEL_RECONNECT_MS = 30_000;
/** A resumed match gives both players a moment before the clock runs again. */
export const DUEL_RESUME_GRACE_MS = 3_000;
/** No legitimate match lasts this long (every phase has a deadline); older live matches are a bug and are cancelled. */
export const DUEL_MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** The command inbox and content snapshot of an ended match are kept this long. */
export const DUEL_RETENTION_DAYS = 30;
/** A clock this far past its deadline means the service was down: never charge the players for it. */
export const DUEL_OUTAGE_MS = 30_000;
/** ...they get this long to act once it is back. */
export const DUEL_OUTAGE_GRACE_MS = 15_000;
const MAX_CATCH_UP = 50;

export class DuelError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

/** What the realtime layer does after a commit: send each seat its snapshot, arm the clock, refresh the room. */
export interface DuelEffects {
  matchId: string;
  lobbyId: string | null;
  userIds: string[];
  status: DuelStatus;
  timer: { token: number; dueAt: Date } | null;
  finished: boolean;
}

export type CommandResult = { ok: true } | { ok: false; code: string };

/** Pool items per difficulty for one match, and the round order they are dealt in. */
const PACKS: Record<DuelGameId, { wanted: Record<string, number>; order: readonly string[] }> = {
  buscaminas: { wanted: { easy: 2, medium: 4, hard: 4 }, order: BM_TIERS },
  pistas: {
    wanted: { easy: 3, medium: 4, hard: 3 },
    order: ['easy', 'medium', 'hard', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard'],
  },
  ultimo: { wanted: { easy: 2, medium: 2, hard: 1 }, order: UL_TIERS },
};

const contentCache = new Map<string, unknown>();

function parsedContent(engine: AnyEngine, matchId: string, raw: unknown): unknown {
  const key = `${matchId}:${engine.version}`;
  const hit = contentCache.get(key);
  if (hit) return hit;
  const parsed = engine.parseContent(raw);
  if (contentCache.size > 500) contentCache.delete(contentCache.keys().next().value as string);
  contentCache.set(key, parsed);
  return parsed;
}

function stableHash(value: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v);
  return createHash('sha256').update(JSON.stringify(canon(value) ?? null)).digest('hex');
}

function resultOf(outcome: EngineOutcome): DuelResult {
  const { scores, idle } = outcome;
  if (idle !== null) return { scores, winnerSeat: idle === 0 ? 1 : 0, reason: 'idle', leftSeat: idle };
  const winnerSeat = scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
  return { scores, winnerSeat, reason: 'score', leftSeat: null };
}

const cancelled = (leftSeat: 0 | 1 | null): DuelResult => ({ scores: [0, 0], winnerSeat: null, reason: 'cancelled', leftSeat });

interface Clock { state: unknown; deadlineMs: number | null; moved: boolean }

/**
 * Runs the phase clock up to the database now: every deadline already passed is expired in order, each next
 * deadline counted from the previous one. A clock far behind (an outage) is not replayed: the open phase
 * gets a short fresh deadline instead, so an infrastructure failure never costs a player a turn or the match.
 */
function catchUp(engine: AnyEngine, content: unknown, state: unknown, deadlineMs: number, nowMs: number, rng: () => number): Clock {
  if (nowMs - deadlineMs > DUEL_OUTAGE_MS) return { state, deadlineMs: nowMs + DUEL_OUTAGE_GRACE_MS, moved: true };
  let current = { state, deadlineMs: deadlineMs as number | null, moved: false };
  for (let i = 0; current.deadlineMs !== null && current.deadlineMs <= nowMs; i += 1) {
    if (i >= MAX_CATCH_UP) throw new Error('DUEL_CATCH_UP_RUNAWAY');
    const step = engine.expire(current.state, content, { rng, remainingMs: 0 });
    if (step.phase === 'keep') throw new Error('DUEL_EXPIRE_KEPT_PHASE');
    current = { state: step.state, deadlineMs: step.phase === null ? null : current.deadlineMs + step.phase.ms, moved: true };
  }
  return current;
}

const effectsOf = (row: DuelMatchRow, participants: DuelParticipantRow[], status: DuelStatus, timer: DuelEffects['timer']): DuelEffects => ({
  matchId: row.id,
  lobbyId: row.lobby_id,
  userIds: participants.map((p) => p.user_id),
  status,
  timer,
  finished: status === 'completed' || status === 'cancelled',
});

async function seatOf(tx: TransactionSql, row: DuelMatchRow, userId: string): Promise<{ seat: Seat; participants: DuelParticipantRow[] }> {
  const participants = await duelRepo.participants(tx, row.id);
  const me = participants.find((p) => p.user_id === userId);
  if (!me) throw new DuelError('not_in_match', 403);
  return { seat: me.seat, participants };
}

async function lockOwned(tx: TransactionSql, matchId: string, userId: string) {
  const row = await duelRepo.lockMatch(tx, matchId);
  if (!row) throw new DuelError('duel_not_found', 404);
  return { row, ...(await seatOf(tx, row, userId)) };
}

async function engineAndContent(tx: TransactionSql, row: DuelMatchRow) {
  const engine = engineFor(row.game, row.engine_version);
  const stored = await duelRepo.getContent(tx, row.id);
  if (!engine || !stored) return null;
  return { engine, content: parsedContent(engine, row.id, stored.content), seed: stored.seed };
}

/**
 * Writes the clock and state after a step. A terminal state ends the match in the same transaction.
 * Returns the timer to arm (null when the match ended).
 */
async function persist(
  tx: TransactionSql,
  row: DuelMatchRow,
  engine: AnyEngine,
  clock: Clock,
  rngCounter: number,
  started = false,
): Promise<{ status: DuelStatus; timer: DuelEffects['timer'] }> {
  const outcome = engine.outcome(clock.state);
  if (clock.deadlineMs === null || outcome) {
    const result = resultOf(outcome ?? { scores: engine.scores(clock.state), idle: null });
    await duelRepo.finish(tx, row, { status: 'completed', state: clock.state, result, rngCounter });
    return { status: 'completed', timer: null };
  }
  const dueAt = new Date(clock.deadlineMs);
  const saved = await duelRepo.saveStep(tx, row.id, { status: 'active', state: clock.state, deadlineAt: clock.moved ? dueAt : null, rngCounter, started });
  return { status: 'active', timer: { token: saved.phase_token, dueAt: saved.phase_deadline_at } };
}

/** Runs the intro or game clock (as its expiry does) under the caller's lock. */
async function advanceClock(tx: TransactionSql, row: DuelMatchRow): Promise<{ status: DuelStatus; timer: DuelEffects['timer'] }> {
  const nowMs = row.now.getTime();
  const loaded = await engineAndContent(tx, row);
  if (!loaded) {
    await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(null), rngCounter: row.rng_counter });
    return { status: 'cancelled', timer: null };
  }
  const draws = seededRng(loaded.seed, row.rng_counter);
  if (row.status === 'countdown') {
    // The intro is over: the engine deals its first phase on the database clock.
    const step = loaded.engine.start(loaded.content, { rng: draws.rng, remainingMs: 0 });
    if (step.phase === 'keep' || step.phase === null) throw new Error('DUEL_START_WITHOUT_CLOCK');
    return persist(tx, row, loaded.engine, { state: step.state, deadlineMs: nowMs + step.phase.ms, moved: true }, draws.used(), true);
  }
  const clock = catchUp(loaded.engine, loaded.content, row.state, row.phase_deadline_at!.getTime(), nowMs, draws.rng);
  return persist(tx, row, loaded.engine, clock, draws.used());
}

/** A paused match with nobody away any more goes on with the phase time it had left plus a short grace. */
/**
 * Back to the paused phase with its remaining time, plus a grace of at most DUEL_RESUME_GRACE_MS and never more than
 * the pause lasted: a drop-and-reconnect just past the debounce earns (almost) nothing, so pausing cannot be farmed
 * for thinking time, while a real reconnect gets its few seconds back.
 */
async function resume(tx: TransactionSql, row: DuelMatchRow): Promise<{ status: DuelStatus; timer: DuelEffects['timer'] }> {
  const status = row.paused_from ?? 'active';
  const paused = row.paused_at ? Math.max(0, row.now.getTime() - row.paused_at.getTime()) : DUEL_RESUME_GRACE_MS;
  const grace = Math.min(DUEL_RESUME_GRACE_MS, paused);
  const saved = await duelRepo.setPhase(tx, row.id, { status, deadlineAt: new Date(row.now.getTime() + (row.paused_remaining_ms ?? 0) + grace) });
  return { status, timer: { token: saved.phase_token, dueAt: saved.phase_deadline_at } };
}

/** Keeps the pause but moves its clock (the match deadline is the earliest reconnect deadline of the seats away). */
async function repause(tx: TransactionSql, row: DuelMatchRow, deadlineAt: Date): Promise<{ status: DuelStatus; timer: DuelEffects['timer'] }> {
  const saved = await duelRepo.setPhase(tx, row.id, { status: 'paused', deadlineAt, pausedFrom: row.paused_from, pausedRemainingMs: row.paused_remaining_ms });
  return { status: 'paused', timer: { token: saved.phase_token, dueAt: saved.phase_deadline_at } };
}

/**
 * A paused match at (or past) its deadline, under the lock. Each seat away has its own reconnect deadline:
 * one seat past it forfeits (the other wins by disconnect); both away when one runs out is no contest; nobody
 * away resumes; a deadline far overdue is an outage, never a penalty (both get a short fresh window).
 */
async function resolvePause(tx: TransactionSql, row: DuelMatchRow, participants: DuelParticipantRow[]): Promise<{ status: DuelStatus; timer: DuelEffects['timer'] }> {
  const nowMs = row.now.getTime();
  const away = participants.filter((p) => !p.connected);
  if (away.length === 0) return resume(tx, row);
  const deadlines = away.map((p) => p.absence_deadline_at?.getTime() ?? nowMs);
  const earliest = Math.min(...deadlines);
  if (earliest > nowMs) return repause(tx, row, new Date(earliest));
  if (nowMs - earliest > DUEL_OUTAGE_MS) {
    const fresh = new Date(nowMs + DUEL_OUTAGE_GRACE_MS);
    for (const p of away) {
      const until = p.absence_deadline_at?.getTime() ?? nowMs;
      const chargeMs = p.absent_since ? Math.min(nowMs, until) - p.absent_since.getTime() : 0;
      await duelRepo.settleOutage(tx, row.id, p.seat, chargeMs, fresh);
    }
    return repause(tx, row, fresh);
  }
  if (away.length === 2) {
    await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(null), rngCounter: row.rng_counter });
    return { status: 'cancelled', timer: null };
  }
  const gone = away[0].seat;
  const engine = engineFor(row.game, row.engine_version);
  const scores: [number, number] = engine && row.state !== null ? engine.scores(row.state) : [0, 0];
  await duelRepo.finish(tx, row, {
    status: 'completed', state: row.state, rngCounter: row.rng_counter,
    result: { scores, winnerSeat: gone === 0 ? 1 : 0, reason: 'disconnect', leftSeat: gone },
  });
  return { status: 'completed', timer: null };
}

const windowFor = (p: DuelParticipantRow, nowMs: number): Date => new Date(nowMs + Math.min(DUEL_RECONNECT_MS, p.absence_budget_ms));

type Locked = { row: DuelMatchRow; seat: Seat; participants: DuelParticipantRow[] };

/**
 * A pause already due is settled against the presence it had at its deadline, before any presence change is
 * applied: a return or a new disconnect a moment after the deadline must not change an outcome already due.
 * Returns the effects when that ended the match, else the (re-read) row and participants to continue with.
 */
async function settleDuePause(tx: TransactionSql, locked: Locked): Promise<Locked | { effects: DuelEffects }> {
  const { row, participants } = locked;
  if (row.status !== 'paused' || !row.phase_deadline_at || row.phase_deadline_at.getTime() > row.now.getTime()) return locked;
  const resolved = await resolvePause(tx, row, participants);
  if (resolved.status === 'completed' || resolved.status === 'cancelled') return { effects: effectsOf(row, participants, resolved.status, resolved.timer) };
  const fresh = (await duelRepo.lockMatch(tx, row.id))!;
  return { row: fresh, seat: locked.seat, participants: await duelRepo.participants(tx, row.id) };
}

export const duelService = {
  /**
   * Host start of a ready duel room. The pack is picked before the transaction; the transaction re-checks the
   * room (exactly these two members, both ready, still waiting, same game) and flips it active with the match.
   */
  async createFromLobby(input: { lobbyId: string; game: DuelGameId; players: Array<{ userId: string; isGuest: boolean }> }): Promise<DuelEffects> {
    if (input.players.length !== 2) throw new DuelError('duel_needs_two');
    const engine = currentEngine(input.game);
    const pack = PACKS[input.game];
    const items = await duelRepo.pickPool(input.game, input.players.map((p) => p.userId), pack.wanted);
    const byDifficulty = new Map<string, typeof items>();
    for (const item of items) byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), item]);
    const dealt = pack.order.map((difficulty) => byDifficulty.get(difficulty)?.shift());
    if (dealt.some((item) => !item)) throw new DuelError('duel_pool_short', 503);
    const content = engine.parseContent({ rounds: dealt.map((item) => item!.payload) });
    const seed = newSeed();
    return duelRepo.withTx(async (tx) => {
      const claimed = await duelRepo.claimLobby(tx, input.lobbyId, input.game, input.players.map((p) => p.userId));
      if (!claimed) throw new DuelError('duel_room_changed', 409);
      const created = await duelRepo.insertMatch(tx, {
        game: input.game, engineVersion: engine.version, lobbyId: input.lobbyId, readyMs: DUEL_READY_MS, seed,
        itemIds: dealt.map((item) => item!.item_id), content, seats: input.players,
      });
      return {
        matchId: created.id, lobbyId: input.lobbyId, userIds: input.players.map((p) => p.userId), status: 'ready',
        timer: { token: created.phase_token, dueAt: created.phase_deadline_at }, finished: false,
      } satisfies DuelEffects;
    });
  },

  /** A seat's screen is up. When both are, the game starts on the database clock. */
  async ready(matchId: string, userId: string, locale: DuelLocale): Promise<DuelEffects> {
    return duelRepo.withTx(async (tx) => {
      const { row, seat, participants } = await lockOwned(tx, matchId, userId);
      if (row.status !== 'ready') return effectsOf(row, participants, row.status, null);
      // A ready that lands after the gate closed cannot start the game: the gate is judged here, not only by the timer.
      if (row.phase_deadline_at && row.phase_deadline_at.getTime() <= row.now.getTime()) {
        const absent = participants.filter((p) => !p.ready_at);
        await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(absent.length === 1 ? absent[0].seat : null), rngCounter: row.rng_counter });
        return effectsOf(row, participants, 'cancelled', null);
      }
      await duelRepo.markReady(tx, row.id, seat, locale);
      // The seat saying ready is here, whatever the last disconnect check concluded.
      const me = participants.find((p) => p.seat === seat)!;
      if (!me.connected) await duelRepo.markPresent(tx, row.id, seat, 0);
      const now = participants.map((p) => (p.seat === seat ? { ...p, connected: true } : p));
      const others = now.filter((p) => p.seat !== seat);
      if (others.some((p) => !p.ready_at)) return effectsOf(row, now, 'ready', null);
      const nowMs = row.now.getTime();
      const away = now.filter((p) => !p.connected);
      if (away.length > 0) {
        // Ready earlier, gone since: the intro starts paused on that seat's reconnect window, never without it.
        const deadlines = away.map((p) => windowFor(p, nowMs));
        for (const [i, p] of away.entries()) await duelRepo.setAbsenceDeadline(tx, row.id, p.seat, deadlines[i]);
        const saved = await duelRepo.setPhase(tx, row.id, {
          status: 'paused', deadlineAt: new Date(Math.min(...deadlines.map((d) => d.getTime()))), pausedFrom: 'countdown', pausedRemainingMs: DUEL_COUNTDOWN_MS,
        });
        return effectsOf(row, now, 'paused', { token: saved.phase_token, dueAt: saved.phase_deadline_at });
      }
      // Both screens are up: the intro runs on the database clock, then the first game phase starts.
      const saved = await duelRepo.setPhase(tx, row.id, { status: 'countdown', deadlineAt: new Date(nowMs + DUEL_COUNTDOWN_MS) });
      return effectsOf(row, now, 'countdown', { token: saved.phase_token, dueAt: saved.phase_deadline_at });
    });
  },

  /**
   * A seat has no socket left (after the realtime debounce). `generation` is the seat's presence generation read
   * when the disconnect was seen: a (re)connect since then bumped it, so this stale check does nothing.
   * An overdue intro/game clock is run first (a pause never shelters an expired phase); then the match pauses on
   * this seat's own reconnect window, min(DUEL_RECONNECT_MS, budget). At the ready gate nothing pauses.
   */
  async absent(userId: string, generation: number | null = null): Promise<DuelEffects | null> {
    const live = await duelRepo.liveMatchForUser(userId);
    if (!live) return null;
    return duelRepo.withTx(async (tx) => {
      const settled = await settleDuePause(tx, await lockOwned(tx, live.id, userId));
      if ('effects' in settled) return settled.effects;
      let row = settled.row;
      const { seat, participants } = settled;
      const me = participants.find((p) => p.seat === seat)!;
      if (!me.connected || (generation !== null && me.presence_gen !== generation)) return null;
      if (!row.phase_deadline_at || !['ready', 'countdown', 'active', 'paused'].includes(row.status)) return null;
      const away = participants.map((p) => (p.seat === seat ? { ...p, connected: false } : p));
      if (row.status === 'ready') {
        await duelRepo.markAbsent(tx, row.id, seat, null);
        return effectsOf(row, away, 'ready', null);
      }
      if ((row.status === 'countdown' || row.status === 'active') && row.phase_deadline_at.getTime() <= row.now.getTime()) {
        const advanced = await advanceClock(tx, row);
        if (advanced.status === 'completed' || advanced.status === 'cancelled') return effectsOf(row, participants, advanced.status, null);
        row = (await duelRepo.lockMatch(tx, row.id))!;
      }
      const nowMs = row.now.getTime();
      const mine = windowFor(me, nowMs);
      await duelRepo.markAbsent(tx, row.id, seat, mine);
      if (row.status === 'paused') {
        const next = await repause(tx, row, new Date(Math.min(row.phase_deadline_at!.getTime(), mine.getTime())));
        return effectsOf(row, away, next.status, next.timer);
      }
      const saved = await duelRepo.setPhase(tx, row.id, {
        status: 'paused', deadlineAt: mine,
        pausedFrom: row.status as 'countdown' | 'active', pausedRemainingMs: Math.max(0, row.phase_deadline_at!.getTime() - nowMs),
      });
      return effectsOf(row, away, 'paused', { token: saved.phase_token, dueAt: saved.phase_deadline_at });
    });
  },

  /**
   * A seat is here (a socket connected, or its screen resynced). Any disconnect check in flight goes stale. A seat
   * returning after its own reconnect deadline is too late (the pause resolves: forfeit or no contest) unless the
   * lateness is an outage. Otherwise its absence, up to its deadline, comes off its budget, and when nobody is away
   * any more the match resumes with the phase time it had left plus a short grace.
   */
  async present(userId: string): Promise<DuelEffects | null> {
    const live = await duelRepo.liveMatchForUser(userId);
    if (!live) return null;
    return duelRepo.withTx(async (tx) => {
      const settled = await settleDuePause(tx, await lockOwned(tx, live.id, userId));
      if ('effects' in settled) return settled.effects;
      const { row, seat, participants } = settled;
      const me = participants.find((p) => p.seat === seat)!;
      const nowMs = row.now.getTime();
      if (me.connected) {
        await duelRepo.bumpPresence(tx, row.id, seat);
        if (row.status !== 'paused' || participants.some((p) => !p.connected)) return null;
        const resumed = await resume(tx, row);
        return effectsOf(row, participants, resumed.status, resumed.timer);
      }
      const deadlineMs = me.absence_deadline_at?.getTime() ?? null;
      if (row.status === 'paused' && deadlineMs !== null && deadlineMs <= nowMs && nowMs - deadlineMs <= DUEL_OUTAGE_MS) {
        const resolved = await resolvePause(tx, row, participants);
        return effectsOf(row, participants, resolved.status, resolved.timer);
      }
      const chargeMs = deadlineMs === null || !me.absent_since ? 0 : Math.min(nowMs, deadlineMs) - me.absent_since.getTime();
      await duelRepo.markPresent(tx, row.id, seat, chargeMs);
      const back = participants.map((p) => (p.seat === seat ? { ...p, connected: true, absence_deadline_at: null } : p));
      if (row.status !== 'paused') return effectsOf(row, back, row.status, null);
      const stillAway = back.filter((p) => !p.connected);
      const next = stillAway.length === 0
        ? await resume(tx, row)
        : await repause(tx, row, new Date(Math.min(...stillAway.map((p) => p.absence_deadline_at?.getTime() ?? nowMs))));
      return effectsOf(row, back, next.status, next.timer);
    });
  },

  /** The presence generation to fence a disconnect check with (null: the user has no live duel to pause). */
  presenceGeneration(userId: string): Promise<number | null> {
    return duelRepo.presenceGeneration(userId);
  },

  /**
   * One game command. Order: ownership, idempotency (same id + same payload replays; changed payload is refused),
   * status, the clock catch-up (a command after the deadline meets the state that followed it), then the rules.
   * Rule rejections are stored like successes, so a retry replays them instead of re-judging.
   */
  async command(matchId: string, userId: string, commandId: string, raw: unknown): Promise<{ result: CommandResult; effects: DuelEffects | null }> {
    const hash = stableHash(raw);
    return duelRepo.withTx(async (tx) => {
      const { row, seat, participants } = await lockOwned(tx, matchId, userId);
      const previous = await duelRepo.findCommand(tx, row.id, userId, commandId);
      if (previous) {
        if (previous.payload_hash !== hash) return { result: { ok: false, code: 'command_id_reused' }, effects: null };
        return { result: previous.result as CommandResult, effects: null };
      }
      const record = async (result: CommandResult) => {
        await duelRepo.insertCommand(tx, row.id, userId, commandId, hash, result);
        return result;
      };
      if (row.status === 'paused') return { result: await record({ ok: false, code: 'paused' }), effects: null };
      if (row.status !== 'active' || row.phase_deadline_at === null) {
        return { result: await record({ ok: false, code: 'not_active' }), effects: null };
      }
      const loaded = await engineAndContent(tx, row);
      if (!loaded) {
        await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(null), rngCounter: row.rng_counter });
        return { result: await record({ ok: false, code: 'not_active' }), effects: effectsOf(row, participants, 'cancelled', null) };
      }
      const { engine, content } = loaded;
      const draws = seededRng(loaded.seed, row.rng_counter);
      const nowMs = row.now.getTime();
      let clock = catchUp(engine, content, row.state, row.phase_deadline_at.getTime(), nowMs, draws.rng);
      let result: CommandResult = { ok: true };
      if (clock.deadlineMs === null) {
        result = { ok: false, code: 'round_over' };
      } else {
        const parsed = engine.commandSchema.safeParse(raw);
        if (!parsed.success) {
          result = { ok: false, code: 'invalid_command' };
        } else {
          try {
            const step = engine.apply(clock.state, content, seat, parsed.data, { rng: draws.rng, remainingMs: Math.max(0, clock.deadlineMs - nowMs) });
            clock = step.phase === 'keep'
              ? { ...clock, state: step.state }
              : { state: step.state, deadlineMs: step.phase === null ? null : nowMs + step.phase.ms, moved: true };
          } catch (error) {
            if (!(error instanceof DuelRuleError)) throw error;
            result = { ok: false, code: error.code };
          }
        }
      }
      await record(result);
      if (!result.ok && !clock.moved) return { result, effects: null };
      const saved = await persist(tx, row, engine, clock, draws.used());
      return { result, effects: effectsOf(row, participants, saved.status, saved.timer) };
    });
  },

  /**
   * The phase clock ran out (timer or recovery poll). A timer carrying an old phase token, or a deadline that
   * is not due by the database clock, changes nothing. A ready gate that runs out cancels the match.
   */
  async expire(matchId: string, token: number | null): Promise<DuelEffects | null> {
    return duelRepo.withTx(async (tx) => {
      const row = await duelRepo.lockMatch(tx, matchId);
      if (!row || !['ready', 'countdown', 'active', 'paused'].includes(row.status) || !row.phase_deadline_at) return null;
      if (token !== null && token !== row.phase_token) return null;
      const participants = await duelRepo.participants(tx, row.id);
      const nowMs = row.now.getTime();
      if (row.phase_deadline_at.getTime() > nowMs) {
        return effectsOf(row, participants, row.status, { token: row.phase_token, dueAt: row.phase_deadline_at });
      }
      if (row.status === 'ready') {
        const missing = participants.filter((p) => !p.ready_at);
        await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(missing.length === 1 ? missing[0].seat : null), rngCounter: row.rng_counter });
        return effectsOf(row, participants, 'cancelled', null);
      }
      if (row.status === 'paused') {
        const resolved = await resolvePause(tx, row, participants);
        return effectsOf(row, participants, resolved.status, resolved.timer);
      }
      const advanced = await advanceClock(tx, row);
      return effectsOf(row, participants, advanced.status, advanced.timer);
    });
  },

  /** A seat leaves: from the intro on the match goes to the rival; a match still at the ready gate is cancelled. */
  async forfeit(matchId: string, userId: string): Promise<DuelEffects | null> {
    return duelRepo.withTx(async (tx) => {
      const { row, seat, participants } = await lockOwned(tx, matchId, userId);
      if (row.status === 'ready') {
        await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(seat), rngCounter: row.rng_counter });
        return effectsOf(row, participants, 'cancelled', null);
      }
      if (!['countdown', 'active', 'paused'].includes(row.status)) return null;
      const engine = engineFor(row.game, row.engine_version);
      const scores: [number, number] = engine && row.state !== null ? engine.scores(row.state) : [0, 0];
      await duelRepo.finish(tx, row, {
        status: 'completed', state: row.state, rngCounter: row.rng_counter,
        result: { scores, winnerSeat: seat === 0 ? 1 : 0, reason: 'forfeit', leftSeat: seat },
      });
      return effectsOf(row, participants, 'completed', null);
    });
  },

  /** Everything one seat's screen needs, read without locks; null when the user is not in the match. */
  async snapshot(matchId: string, userId: string, localeOverride?: DuelLocale) {
    const row = await duelRepo.getMatch(matchId);
    if (!row) return null;
    const participants = await duelRepo.participants(undefined, row.id);
    const me = participants.find((p) => p.user_id === userId);
    if (!me) return null;
    const locale = localeOverride ?? me.locale;
    let view: unknown = null;
    if (row.state !== null) {
      const engine = engineFor(row.game, row.engine_version);
      const stored = engine ? await duelRepo.getContent(undefined, row.id) : null;
      if (engine && stored) view = engine.view(row.state, parsedContent(engine, row.id, stored.content), me.seat, locale);
    }
    return {
      matchId: row.id,
      lobbyId: row.lobby_id,
      game: row.game,
      stateVersion: row.state_version,
      status: row.status,
      phaseToken: row.phase_token,
      phaseDeadlineAt: row.phase_deadline_at?.toISOString() ?? null,
      serverNow: row.now.toISOString(),
      mySeat: me.seat,
      seats: participants.map((p) => ({
        seat: p.seat, userId: p.user_id, username: p.nickname ?? 'Jugador', avatarUrl: p.avatar_url,
        avatarCustomization: p.avatar_customization, isGuest: p.is_guest, ready: p.ready_at !== null,
        connected: p.connected, absenceBudgetMs: p.absence_budget_ms,
      })),
      pausedFrom: row.paused_from,
      view,
      result: row.result,
    };
  },

  /** Safety net: a live match past the hard age cap is cancelled as no contest (nobody's fault, nobody wins). */
  async cancelStale(matchId: string): Promise<DuelEffects | null> {
    return duelRepo.withTx(async (tx) => {
      const row = await duelRepo.lockMatch(tx, matchId);
      if (!row || !['ready', 'countdown', 'active', 'paused'].includes(row.status)) return null;
      const participants = await duelRepo.participants(tx, row.id);
      await duelRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelled(null), rngCounter: row.rng_counter });
      logger.warn({ matchId, status: row.status, game: row.game }, 'Duel cancelled by the age cap');
      return effectsOf(row, participants, 'cancelled', null);
    });
  },

  anyLive() {
    return duelRepo.anyLive();
  },

  staleLiveMatches(limit = 20) {
    return duelRepo.staleLiveMatches(DUEL_MAX_AGE_MS, limit);
  },

  purgeEnded() {
    return duelRepo.purgeEnded(DUEL_RETENTION_DAYS, 5_000);
  },

  setLocale(matchId: string, userId: string, locale: DuelLocale): Promise<void> {
    return duelRepo.setLocale(matchId, userId, locale);
  },

  liveMatchFor(userId: string) {
    return duelRepo.liveMatchForUser(userId);
  },

  dueMatches(limit = 50) {
    return duelRepo.dueMatches(limit);
  },
};

export const asDuelLocale = (value: unknown): DuelLocale | undefined =>
  (DUEL_LOCALES as readonly string[]).includes(value as string) ? (value as DuelLocale) : undefined;

export const logDuelFailure = (error: unknown, context: Record<string, unknown>) => logger.warn({ error, ...context }, 'Duel operation failed');
