import { createHash } from 'node:crypto';
import type { TransactionSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { finalStandings, isIdle, OUTAGE_MS, seatsChanged, startMatch, submitGuess, tick, type EngineConfig, type EngineState, type SeatChange } from './games/aproximado/aproximado.engine.js';
import { ROUND_MS, ROUNDS } from './games/aproximado/aproximado.rules.js';
import { roomRepo, type PresenceFence, type RoomMatchRow, type RoomSeatRow } from './room.repo.js';
import {
  aproximadoContentSchema, ROOM_LOCALES, RoomError, roomCommandSchema,
  type AproximadoContent, type RoomGameId, type RoomLocale, type RoomResult, type RoomStatus,
} from './room.types.js';

/** Everyone must say ready within this; whoever did is admitted (2+ needed), the rest wait in the room. */
export const ROOM_READY_MS = 20_000;
/** One disconnection may last this long before the seat is withdrawn... */
export const ROOM_AWAY_MS = 30_000;
/** ...and all of a seat's absences in a match together this long. */
export const ROOM_AWAY_BUDGET_MS = 60_000;
/** After a server outage every away seat gets at least this long to come back (nobody is withdrawn by an outage). */
export const ROOM_OUTAGE_GRACE_MS = 5_000;
export const ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000;
export const ROOM_RETENTION_DAYS = 30;
export const ROOM_MAX_SEATS = 6;
const ENGINE_VERSION = 1;
const PACK = { wanted: { easy: 3, medium: 4, hard: 3 }, order: ['easy', 'medium', 'easy', 'medium', 'hard', 'medium', 'easy', 'hard', 'medium', 'hard'] } as const;

export interface RoomEffects {
  matchId: string;
  lobbyId: string | null;
  /** Every user with a seat row (admitted or not): each gets its own snapshot. */
  userIds: string[];
  status: RoomStatus;
  timer: { token: number; dueAt: Date } | null;
  finished: boolean;
  /** A new match only: database time just before its creation committed (fences stale "no live seat" answers). */
  startedAtMs?: number;
}

export type RoomCommandResult = { ok: true } | { ok: false; code: string };

const stableHash = (value: unknown): string => {
  const canon = (v: unknown): unknown => (Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
      : v);
  return createHash('sha256').update(JSON.stringify(canon(value) ?? null)).digest('hex');
};

/** A schema error can quote the content (an answer): callers and logs only ever get a code. */
function parseContent(raw: unknown): AproximadoContent {
  const parsed = aproximadoContentSchema.safeParse(raw);
  if (!parsed.success) throw new RoomError('room_content_invalid', 500);
  return parsed.data;
}

const engineConfig = (content: AproximadoContent, seats: number): EngineConfig => ({
  questions: content.questions.map((q) => ({ id: q.id, kind: q.kind, prompt: '', unit: '', precision: q.precision, exactWithin: q.exactWithin, value: q.value })),
  // A 1v1 is closest-takes-it (the videos' rule); three or more play the podium.
  scoring: seats === 2 ? 'closest' : 'podium',
  rounds: ROUNDS,
});

const effectsOf = (row: RoomMatchRow, seats: RoomSeatRow[], status: RoomStatus, timer: RoomEffects['timer']): RoomEffects => ({
  matchId: row.id, lobbyId: row.lobby_id, userIds: seats.map((s) => s.user_id), status, timer,
  finished: status === 'completed' || status === 'cancelled',
});

const admittedSeats = (seats: RoomSeatRow[]) => seats.filter((s) => s.admitted).sort((a, b) => a.seat! - b.seat!);

function resultOf(state: EngineState, seats: RoomSeatRow[]): RoomResult {
  const userOf = new Map(admittedSeats(seats).map((s) => [s.seat!, s.user_id]));
  return {
    reason: 'score',
    standings: finalStandings(state).map((s) => ({
      seat: s.seat, userId: userOf.get(s.seat)!, points: s.points, roundWins: s.roundWins, place: s.place, withdrawn: state.status[s.seat] === 'withdrawn',
    })),
  };
}

const cancelledResult = (): RoomResult => ({ reason: 'cancelled', standings: [] });

interface Loaded { row: RoomMatchRow; seats: RoomSeatRow[]; content: AproximadoContent }

async function load(tx: TransactionSql, matchId: string): Promise<Loaded | null> {
  const row = await roomRepo.lockMatch(tx, matchId);
  if (!row) return null;
  const seats = await roomRepo.seats(tx, row.id);
  const raw = await roomRepo.getContent(tx, row.id);
  if (raw === null) {
    // Content gone (retention or a bug): only a cancel can end it cleanly.
    if (row.status === 'ready' || row.status === 'active') await roomRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelledResult() });
    return null;
  }
  return { row, seats, content: parseContent(raw) };
}

/**
 * Writes the state after any change, under the caller's lock. A terminal engine phase ends the match in the same
 * transaction. The match deadline is the earliest of the engine's own deadline and every away seat's absence deadline.
 */
async function persist(tx: TransactionSql, l: Loaded, state: EngineState, started = false): Promise<RoomEffects> {
  const seats = await roomRepo.seats(tx, l.row.id);
  if (state.phase === 'over' || state.phase === 'cancelled') {
    const status = state.phase === 'over' ? 'completed' : 'cancelled';
    await roomRepo.finish(tx, l.row, { status, state, result: status === 'completed' ? resultOf(state, seats) : cancelledResult() });
    return effectsOf(l.row, seats, status, null);
  }
  const absences = admittedSeats(seats)
    .filter((s) => state.status[s.seat!] === 'away' && s.absence_deadline_at)
    .map((s) => s.absence_deadline_at!.getTime());
  const deadline = new Date(Math.min(state.deadline, ...absences));
  const saved = await roomRepo.saveState(tx, l.row.id, { status: 'active', state, deadlineAt: deadline, started });
  return effectsOf(l.row, seats, 'active', { token: saved.phase_token, dueAt: saved.phase_deadline_at });
}

/** The engine's clock up to `nowMs`: intro → question → reveal → next, and the early close once everyone eligible is in. */
function runClock(state: EngineState, content: AproximadoContent, nowMs: number): EngineState {
  const cfg = engineConfig(content, state.status.length);
  for (let i = 0; i < 4 && state.phase !== 'over' && state.phase !== 'cancelled'; i += 1) {
    const next = tick(state, cfg, nowMs);
    if (next === state) break;
    state = next;
  }
  return state;
}

/**
 * Brings an active match up to the database clock, before any action is applied. Due boundaries are settled in time
 * order: the engine's own deadlines (intro → question → reveal → next) and each away seat's absence deadline (seats
 * sharing a deadline are withdrawn as one batch; on a tie the engine goes first). So a match that was already over is
 * never reversed by a later absence, and an absence that came first can end the match before a later reveal.
 * A scheduler deadline missed by more than OUTAGE_MS means the server was not running: every open absence window is
 * rebased (what it had left, at least ROOM_OUTAGE_GRACE_MS, from now; the outage is not charged) and an open question
 * gets a fresh window (guesses and missed counts kept), whichever deadline revealed the outage.
 * `changed` also covers rebased absence rows, so the caller persists the new scheduler deadline (never rebasing twice).
 */
async function advance(tx: TransactionSql, l: Loaded): Promise<{ state: EngineState; changed: boolean }> {
  const nowMs = l.row.now.getTime();
  const outageStart = l.row.phase_deadline_at;
  let state = l.row.state as EngineState;
  const before = state;
  if (outageStart && nowMs - outageStart.getTime() > OUTAGE_MS) {
    const rebased = l.seats.some((s) => s.active && !s.connected && s.absence_deadline_at);
    if (rebased) {
      await roomRepo.rebaseAbsences(tx, l.row.id, outageStart, l.row.now, ROOM_OUTAGE_GRACE_MS);
      l.seats = await roomRepo.seats(tx, l.row.id);
    }
    if (state.phase === 'guess') state = { ...state, deadline: nowMs + ROUND_MS };
    state = runClock(state, l.content, nowMs);
    return { state, changed: rebased || state !== before };
  }
  const cfg = engineConfig(l.content, state.status.length);
  for (let i = 0; i < 40 && state.phase !== 'over' && state.phase !== 'cancelled'; i += 1) {
    const current = state;
    const away = admittedSeats(l.seats).filter((s) => current.status[s.seat!] === 'away' && s.absence_deadline_at);
    const nextAbsence = Math.min(...away.map((s) => s.absence_deadline_at!.getTime()));
    const nextEngine = current.deadline;
    if (Math.min(nextAbsence, nextEngine) > nowMs) break;
    if (nextAbsence < nextEngine) {
      const batch = away.filter((s) => s.absence_deadline_at!.getTime() === nextAbsence);
      state = seatsChanged(current, batch.map((s): SeatChange => ({ seat: s.seat!, change: 'leave' })));
      for (const s of batch) await roomRepo.deactivate(tx, l.row.id, s.user_id);
    } else {
      state = tick(current, cfg, nextEngine);
      if (state === current) break;
    }
  }
  // Then the present moment: the early close, once everyone eligible is in.
  state = runClock(state, l.content, nowMs);
  return { state, changed: state !== before };
}

/** Closes the ready gate: ready seats are admitted (2+), the rest leave the match; fewer than 2 = cancelled. */
async function closeGate(tx: TransactionSql, l: Loaded, force: boolean): Promise<RoomEffects> {
  const ready = l.seats.filter((s) => s.active && s.ready_at);
  const allReady = l.seats.filter((s) => s.active).every((s) => s.ready_at);
  if (!force && !allReady) return effectsOf(l.row, l.seats, 'ready', null);
  if (ready.length < 2) {
    await roomRepo.finish(tx, l.row, { status: 'cancelled', state: null, result: cancelledResult() });
    return effectsOf(l.row, l.seats, 'cancelled', null);
  }
  const admitted = ready.sort((a, b) => a.slot - b.slot).map((s, seat) => ({ userId: s.user_id, seat }));
  await roomRepo.admit(tx, l.row.id, admitted);
  const nowMs = l.row.now.getTime();
  let state = startMatch(admitted.length, engineConfig(l.content, admitted.length), nowMs);
  // Admitted but without a socket right now: away from the start, with its own absence window.
  const away = ready.filter((s) => !s.connected);
  if (away.length > 0) {
    const seatOf = new Map(admitted.map((a) => [a.userId, a.seat]));
    state = seatsChanged(state, away.map((s): SeatChange => ({ seat: seatOf.get(s.user_id)!, change: 'away' })));
    for (const s of away) await roomRepo.setAbsenceDeadline(tx, l.row.id, s.user_id, new Date(nowMs + absenceWindow(s)));
  }
  return persist(tx, l, state, true);
}

/**
 * A ready gate whose deadline has passed is closed before anything else is applied (a leave, a presence change, a
 * command), so the roster and the scoring are judged on the gate's own terms. Returns the reloaded match (null when
 * the gate cancelled it) and the gate's effects, which the caller returns when it has nothing newer.
 */
async function settleGate(tx: TransactionSql, l: Loaded): Promise<{ l: Loaded | null; effects: RoomEffects | null }> {
  if (l.row.status !== 'ready' || !l.row.phase_deadline_at || l.row.phase_deadline_at.getTime() > l.row.now.getTime()) return { l, effects: null };
  const effects = await closeGate(tx, l, true);
  return { l: effects.status === 'active' ? await load(tx, l.row.id) : null, effects };
}

/**
 * Under the match lock: this user is here. A connected seat only bumps its presence generation (an older disconnect
 * check then does nothing); a seat marked away comes back, charged for the time away, unless the catch-up already
 * withdrew it. Used by connects/resyncs, and by a ready or a guess (which prove the player is here too).
 */
async function presentLocked(tx: TransactionSql, l: Loaded, userId: string): Promise<RoomEffects | null> {
  const me = seatOf(l, userId);
  if (!me.active) return null;
  if (me.connected) {
    await roomRepo.bumpPresence(tx, l.row.id, userId);
    return null;
  }
  const nowMs = l.row.now.getTime();
  if (l.row.status === 'ready') {
    await roomRepo.markPresent(tx, l.row.id, userId, 0);
    return effectsOf(l.row, await roomRepo.seats(tx, l.row.id), 'ready', null);
  }
  if (l.row.status !== 'active' || !me.admitted) return null;
  const advanced = await advance(tx, l);
  if (advanced.state.status[me.seat!] === 'withdrawn') return advanced.changed ? persist(tx, l, advanced.state) : null;
  const seat = l.seats.find((s) => s.user_id === userId) ?? me; // re-read: an outage may have moved the window
  const until = seat.absence_deadline_at?.getTime() ?? nowMs;
  const charge = seat.absent_since ? Math.min(nowMs, until) - seat.absent_since.getTime() : 0;
  await roomRepo.markPresent(tx, l.row.id, userId, charge);
  // Back may make this seat the last one the open question waited for (it had answered before dropping).
  return persist(tx, l, runClock(seatsChanged(advanced.state, [{ seat: me.seat!, change: 'back' }]), l.content, nowMs));
}

const absenceWindow = (s: RoomSeatRow) => Math.max(0, Math.min(ROOM_AWAY_MS, ROOM_AWAY_BUDGET_MS - s.absence_used_ms));

function seatOf(l: Loaded, userId: string): RoomSeatRow {
  const me = l.seats.find((s) => s.user_id === userId);
  if (!me) throw new RoomError('not_in_match', 403);
  return me;
}

function projectSnapshot(row: RoomMatchRow, seats: RoomSeatRow[], state: EngineState | null, content: AproximadoContent | null, userId: string, localeOverride?: RoomLocale) {
  const me = seats.find((s) => s.user_id === userId);
  if (!me) return null;
  const locale = localeOverride ?? me.locale;
  const admitted = admittedSeats(seats);
  const table = state ? finalStandings(state) : [];
  const seatView = (s: RoomSeatRow) => ({
    seat: s.seat, slot: s.slot, userId: s.user_id, username: s.nickname ?? 'Jugador', avatarUrl: s.avatar_url,
    avatarCustomization: s.avatar_customization, isGuest: s.is_guest, ready: s.ready_at !== null, connected: s.connected,
    admitted: s.admitted, active: s.active,
  });
  let view: unknown = null;
  if (state && content && me.admitted) {
    const q = content.questions[state.round];
    const reveal = state.phase === 'reveal' ? state.results[state.results.length - 1] ?? null : null;
    view = {
      phase: state.phase === 'cancelled' ? 'over' : state.phase,
      round: state.round,
      totalRounds: ROUNDS,
      scoring: state.status.length === 2 ? 'closest' : 'podium',
      question: { id: q.id, kind: q.kind, prompt: q.prompt[locale], unit: q.unit[locale], precision: q.precision },
      seats: admitted.map((s) => ({
        seat: s.seat!, status: state.status[s.seat!],
        answered: state.phase === 'guess' ? state.guesses[s.seat!] !== null : reveal ? reveal.entries[s.seat!]?.guess !== null : false,
        idle: isIdle(state, s.seat!), score: table.find((t) => t.seat === s.seat)?.points ?? 0,
      })),
      mySeat: me.seat,
      myGuess: state.phase === 'guess' ? state.guesses[me.seat!] : reveal ? reveal.entries[me.seat!]?.guess ?? null : null,
      reveal,
      // Only revealed rounds: the open question's guesses are never in here.
      results: state.results,
      standings: state.phase === 'over' ? table : null,
      deadline: state.phase === 'over' || state.phase === 'cancelled' ? null : new Date(state.deadline).toISOString(),
    };
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
    me: { userId, admitted: me.admitted, active: me.active, left: me.left_at !== null, seat: me.seat, slot: me.slot, ready: me.ready_at !== null },
    seats: seats.map(seatView),
    view,
    result: row.result,
  };
}

export const roomService = {
  /**
   * Host start of a ready room (2–6 members). The questions are picked before the transaction; the transaction re-checks
   * the room (exactly these members, all ready, still waiting, same game) and flips it active with the match.
   */
  async createFromLobby(input: { lobbyId: string; game: RoomGameId; players: Array<{ userId: string; isGuest: boolean }> }): Promise<RoomEffects> {
    if (input.players.length < 2 || input.players.length > ROOM_MAX_SEATS) throw new RoomError('room_needs_players');
    const items = await roomRepo.pickPool(input.game, input.players.map((p) => p.userId), PACK.wanted);
    const byDifficulty = new Map<string, typeof items>();
    for (const item of items) byDifficulty.set(item.difficulty, [...(byDifficulty.get(item.difficulty) ?? []), item]);
    const dealt = PACK.order.map((d) => byDifficulty.get(d)?.shift());
    if (dealt.some((item) => !item)) throw new RoomError('room_pool_short', 503);
    const content = parseContent({ questions: dealt.map((item) => item!.payload) });
    const created = await roomRepo.withTx(async (tx) => {
      const claimed = await roomRepo.claimLobby(tx, input.lobbyId, input.game, input.players.map((p) => p.userId));
      if (!claimed) throw new RoomError('room_changed', 409);
      const created = await roomRepo.insertMatch(tx, {
        game: input.game, engineVersion: ENGINE_VERSION, lobbyId: input.lobbyId, readyMs: ROOM_READY_MS,
        itemIds: dealt.map((item) => item!.item_id), content, seats: input.players,
      });
      return {
        matchId: created.id, lobbyId: input.lobbyId, userIds: input.players.map((p) => p.userId), status: 'ready',
        timer: { token: created.phase_token, dueAt: created.phase_deadline_at }, finished: false,
      } satisfies RoomEffects;
    });
    // After the commit, before anyone is told: a "no live seat" read stamped earlier than this cannot know the match.
    return { ...created, startedAtMs: await roomRepo.dbNowMs() };
  },

  /** A seat's screen is up. When every seat is, the gate closes early and the match starts. */
  async ready(matchId: string, userId: string, locale: RoomLocale): Promise<RoomEffects | null> {
    return roomRepo.withTx(async (tx) => {
      const l = await load(tx, matchId);
      if (!l) return null;
      const me = seatOf(l, userId);
      // A ready on a running match (a screen that reconnected) is a presence: an older disconnect check must not win.
      if (l.row.status === 'active') return (await presentLocked(tx, l, userId)) ?? effectsOf(l.row, l.seats, 'active', null);
      if (l.row.status !== 'ready') return effectsOf(l.row, l.seats, l.row.status, null);
      // A ready after the gate closed cannot join: the gate is judged here, not only by the timer. A caller the gate
      // admitted is here, though (an older disconnect check must not mark them away).
      if (l.row.phase_deadline_at && l.row.phase_deadline_at.getTime() <= l.row.now.getTime()) {
        const closed = await closeGate(tx, l, true);
        const started = closed.status === 'active' ? await load(tx, l.row.id) : null;
        return (started && (await presentLocked(tx, started, userId))) || closed;
      }
      if (!me.active) return effectsOf(l.row, l.seats, 'ready', null);
      await roomRepo.markReady(tx, l.row.id, userId, locale);
      if (me.connected) await roomRepo.bumpPresence(tx, l.row.id, userId);
      else await roomRepo.markPresent(tx, l.row.id, userId, 0);
      const seats = await roomRepo.seats(tx, l.row.id);
      return closeGate(tx, { ...l, seats }, false);
    });
  },

  /**
   * One game command. Order: ownership, idempotency (same id + same payload replays; changed payload is refused),
   * status, the clock catch-up (a command after a deadline meets the state that followed it), then the rules.
   */
  async command(matchId: string, userId: string, commandId: string, raw: unknown): Promise<{ result: RoomCommandResult; effects: RoomEffects | null }> {
    const hash = stableHash(raw);
    return roomRepo.withTx(async (tx) => {
      const loaded = await load(tx, matchId);
      if (!loaded) throw new RoomError('room_not_found', 404);
      seatOf(loaded, userId);
      // Whatever this command turns out to be (new, replayed, refused), it proves the player is here, so the gate and
      // their presence are settled first; the effects of that settling are always returned (their snapshots, a result).
      const gate = await settleGate(tx, loaded);
      let l = gate.l ?? loaded;
      let carried = gate.effects;
      if (gate.l && l.row.status === 'active' && seatOf(l, userId).active) {
        const back = await presentLocked(tx, l, userId);
        if (back) {
          carried = back;
          l = (await load(tx, l.row.id)) ?? l;
        }
      }
      const previous = await roomRepo.findCommand(tx, l.row.id, userId, commandId);
      if (previous) {
        if (previous.payload_hash !== hash) return { result: { ok: false, code: 'command_id_reused' }, effects: carried };
        return { result: previous.result as RoomCommandResult, effects: carried };
      }
      const me = seatOf(l, userId);
      const record = async (result: RoomCommandResult) => { await roomRepo.insertCommand(tx, l.row.id, userId, commandId, hash, result); return result; };
      if (!gate.l || l.row.status !== 'active') return { result: await record({ ok: false, code: 'not_active' }), effects: carried };
      if (!me.admitted) return { result: await record({ ok: false, code: 'excluded' }), effects: carried };
      const advanced = await advance(tx, l);
      let state = advanced.state;
      let result: RoomCommandResult = { ok: true };
      const parsed = roomCommandSchema.safeParse(raw);
      if (!parsed.success) result = { ok: false, code: 'invalid_command' };
      else if (state.phase === 'guess' && state.round !== parsed.data.round) result = { ok: false, code: 'stale_round' };
      else {
        const nowMs = l.row.now.getTime();
        const submitted = submitGuess(state, engineConfig(l.content, state.status.length), me.seat!, parsed.data.value, nowMs);
        if (submitted.error) result = { ok: false, code: submitted.error };
        else state = tick(submitted.state, engineConfig(l.content, state.status.length), nowMs); // early close when everyone is in
      }
      await record(result);
      if (state === l.row.state && !advanced.changed) return { result, effects: carried };
      return { result, effects: await persist(tx, l, state) };
    });
  },

  /** Leave the match on purpose: at the gate the seat simply drops out; from then on it is withdrawn (final). */
  async leave(matchId: string, userId: string): Promise<RoomEffects | null> {
    return roomRepo.withTx(async (tx) => {
      const loaded = await load(tx, matchId);
      if (!loaded) return null;
      seatOf(loaded, userId);
      const gate = await settleGate(tx, loaded);
      const l = gate.l;
      if (!l) return gate.effects;
      const me = seatOf(l, userId);
      if (!me.active) return gate.effects;
      await roomRepo.deactivate(tx, l.row.id, userId, true);
      if (l.row.status === 'ready') {
        const seats = await roomRepo.seats(tx, l.row.id);
        if (seats.filter((s) => s.active).length < 2) {
          await roomRepo.finish(tx, l.row, { status: 'cancelled', state: null, result: cancelledResult() });
          return effectsOf(l.row, seats, 'cancelled', null);
        }
        return closeGate(tx, { ...l, seats }, false);
      }
      if (l.row.status !== 'active' || !me.admitted) return gate.effects;
      const advanced = await advance(tx, l);
      // The seat that left may have been the last one the open question was waiting for.
      return persist(tx, l, runClock(seatsChanged(advanced.state, [{ seat: me.seat!, change: 'leave' }]), l.content, l.row.now.getTime()));
    });
  },

  /**
   * No socket left for a seat (after the realtime debounce), fenced by the presence generation read when the
   * disconnect was seen. Rounds never pause: the seat is away with its own window, min(30 s, what is left of 60 s).
   */
  async absent(userId: string, fence: PresenceFence | null = null): Promise<RoomEffects | null> {
    const live = await roomRepo.liveMatchForUser(userId);
    if (!live || (fence && fence.matchId !== live.id)) return null;
    return roomRepo.withTx(async (tx) => {
      const loaded = await load(tx, live.id);
      if (!loaded) return null;
      const first = seatOf(loaded, userId);
      if (!first.active || !first.connected || (fence !== null && first.presence_gen !== fence.gen)) return null;
      const gate = await settleGate(tx, loaded);
      const l = gate.l;
      if (!l) return gate.effects;
      const me = seatOf(l, userId);
      if (!me.active) return gate.effects;
      if (l.row.status === 'ready') {
        await roomRepo.markAbsent(tx, l.row.id, userId, null);
        return effectsOf(l.row, l.seats, 'ready', null);
      }
      if (l.row.status !== 'active' || !me.admitted) return gate.effects;
      const advanced = await advance(tx, l);
      if (advanced.state.status[me.seat!] === 'withdrawn' || advanced.state.phase === 'over' || advanced.state.phase === 'cancelled') {
        return advanced.changed ? persist(tx, l, advanced.state) : gate.effects;
      }
      await roomRepo.markAbsent(tx, l.row.id, userId, new Date(l.row.now.getTime() + absenceWindow(me)));
      return persist(tx, l, runClock(seatsChanged(advanced.state, [{ seat: me.seat!, change: 'away' }]), l.content, l.row.now.getTime()));
    });
  },

  /**
   * A seat is here (a socket connected, or its screen resynced). A seat whose absence deadline already passed was
   * withdrawn by the catch-up; otherwise its time away is charged and it plays on (an open question is still open).
   */
  async present(userId: string): Promise<RoomEffects | null> {
    const live = await roomRepo.liveMatchForUser(userId);
    if (!live) return null;
    return roomRepo.withTx(async (tx) => {
      const loaded = await load(tx, live.id);
      if (!loaded) return null;
      const gate = await settleGate(tx, loaded);
      if (!gate.l) return gate.effects;
      return (await presentLocked(tx, gate.l, userId)) ?? gate.effects;
    });
  },

  presenceGeneration(userId: string): Promise<PresenceFence | null> {
    return roomRepo.presenceGeneration(userId);
  },

  /** The match deadline ran out (timer or recovery poll). An old phase token, or a deadline not yet due, changes nothing. */
  async expire(matchId: string, token: number | null): Promise<RoomEffects | null> {
    return roomRepo.withTx(async (tx) => {
      const l = await load(tx, matchId);
      if (!l || (l.row.status !== 'ready' && l.row.status !== 'active') || !l.row.phase_deadline_at) return null;
      if (token !== null && token !== l.row.phase_token) return null;
      if (l.row.phase_deadline_at.getTime() > l.row.now.getTime()) {
        return effectsOf(l.row, l.seats, l.row.status, { token: l.row.phase_token, dueAt: l.row.phase_deadline_at });
      }
      if (l.row.status === 'ready') return closeGate(tx, l, true);
      const advanced = await advance(tx, l);
      return persist(tx, l, advanced.state);
    });
  },

  /**
   * Everything one user's screen needs, read without locks; null when the user has no seat row. The view is built
   * field by field (allow-list): before a question's reveal it never carries that question's value, its exact window,
   * or another seat's guess.
   */
  async snapshot(matchId: string, userId: string, localeOverride?: RoomLocale) {
    return (await this.snapshots(matchId, [userId], localeOverride)).get(userId) ?? null;
  },

  /** Load shared data once, then keep each recipient's locale and guesses private. */
  async snapshots(matchId: string, userIds: readonly string[], localeOverride?: RoomLocale) {
    const snapshots = new Map<string, NonNullable<ReturnType<typeof projectSnapshot>>>();
    if (userIds.length === 0) return snapshots;
    const row = await roomRepo.getMatch(matchId);
    if (!row) return snapshots;
    const seats = await roomRepo.seats(undefined, row.id);
    const members = new Set(seats.map((s) => s.user_id));
    const recipients = [...new Set(userIds)].filter((id) => members.has(id));
    if (recipients.length === 0) return snapshots;
    const state = row.state as EngineState | null;
    const raw = state ? await roomRepo.getContent(undefined, row.id) : null;
    const content = raw ? parseContent(raw) : null;
    for (const userId of recipients) {
      const snapshot = projectSnapshot(row, seats, state, content, userId, localeOverride);
      if (snapshot) snapshots.set(userId, snapshot);
    }
    return snapshots;
  },

  async cancelStale(matchId: string): Promise<RoomEffects | null> {
    return roomRepo.withTx(async (tx) => {
      const row = await roomRepo.lockMatch(tx, matchId);
      if (!row || (row.status !== 'ready' && row.status !== 'active')) return null;
      const seats = await roomRepo.seats(tx, row.id);
      await roomRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelledResult() });
      logger.warn({ matchId, status: row.status }, 'Room match cancelled by the age cap');
      return effectsOf(row, seats, 'cancelled', null);
    });
  },

  setLocale: (matchId: string, userId: string, locale: RoomLocale) => roomRepo.setLocale(matchId, userId, locale),
  liveMatchFor: (userId: string) => roomRepo.liveMatchForUser(userId),
  livePointerFor: (userId: string) => roomRepo.livePointerFor(userId),
  connectedLiveSeats: (limit = 500, after: { userId: string; matchId: string } | null = null) => roomRepo.connectedLiveSeats(limit, after),
  hasLiveSeat: (userId: string, lobbyId: string) => roomRepo.hasLiveSeat(userId, lobbyId),
  sittingOutFor: (userId: string) => roomRepo.sittingOutMatchForUser(userId),
  dueMatches: (limit = 50) => roomRepo.dueMatches(limit),
  anyLive: () => roomRepo.anyLive(),
  staleLiveMatches: (limit = 20) => roomRepo.staleLiveMatches(ROOM_MAX_AGE_MS, limit),
  purgeEnded: () => roomRepo.purgeEnded(ROOM_RETENTION_DAYS, 5_000),
};

export { ROOM_LOCALES };
