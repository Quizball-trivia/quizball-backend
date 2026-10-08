import { createHash } from 'node:crypto';
import type { TransactionSql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import type { AnyRoomEngine, RoomEngineState, RoomRefusal, RoomSeatChange } from './room.engine.js';
import { clientCanPlay, currentRoomEngine, roomEngineFor } from './room.registry.js';
import { roomRepo, type PresenceFence, type RoomMatchRow, type RoomSeatRow } from './room.repo.js';
import { ROOM_LOCALES, RoomError, type RoomGameId, type RoomLocale, type RoomResult, type RoomStatus } from './room.types.js';

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
/** A scheduler deadline missed by more than this is an outage (server or database stalled), not a slow timer. */
const ROOM_OUTAGE_MS = 5_000;

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

type EngineState = RoomEngineState;

const ENGINE_UNSUPPORTED = 'engine_unsupported';
/** For callers nobody is waiting on (a timer, a presence check): another replica owns a match this build cannot run. */
const unlessUnsupported = <T>(work: Promise<T | null>): Promise<T | null> => work.catch((error: unknown) => {
  if (error instanceof RoomError && error.code === ENGINE_UNSUPPORTED) return null;
  throw error;
});

const hydrated = async (engine: AnyRoomEngine, content: unknown): Promise<unknown> => (engine.hydrate ? engine.hydrate(content) : content);

/** A schema error can quote the content (an answer): callers and logs only ever get a code. */
function parseContent(engine: AnyRoomEngine, raw: unknown): unknown {
  const content = engine.parseContent(raw);
  if (content === null) throw new RoomError('room_content_invalid', 500);
  return content;
}

/** Parsed content of the live matches this replica is serving, most recently used last. */
const contentCache = new Map<string, unknown>();
const CONTENT_CACHE_MAX = 300;
const isLive = (status: RoomStatus) => status === 'ready' || status === 'active';

/**
 * A match's content, parsed; null when its row is gone. The row is written once, with the match, and never changes,
 * so while the match is live each replica keeps it instead of reading it back (about 10 KB for a match of club pairs)
 * on every action and every delivery. Ended matches are read from the table.
 */
async function contentOf(tx: TransactionSql | undefined, row: Pick<RoomMatchRow, 'id' | 'status' | 'has_content'>, engine: AnyRoomEngine): Promise<unknown | null> {
  // The row is gone (deleted by hand, or a bug): the same answer whether or not this replica had it in memory.
  if (!row.has_content) {
    contentCache.delete(row.id);
    return null;
  }
  const live = isLive(row.status);
  const cached = live ? contentCache.get(row.id) : undefined;
  if (cached !== undefined) {
    contentCache.delete(row.id);
    contentCache.set(row.id, cached);
    return cached;
  }
  const raw = await roomRepo.getContent(tx, row.id);
  if (raw === null) return null;
  const content = parseContent(engine, raw);
  if (live) {
    contentCache.set(row.id, content);
    if (contentCache.size > CONTENT_CACHE_MAX) contentCache.delete(contentCache.keys().next().value!);
  } else {
    contentCache.delete(row.id);
  }
  return content;
}

const effectsOf = (row: RoomMatchRow, seats: RoomSeatRow[], status: RoomStatus, timer: RoomEffects['timer']): RoomEffects => ({
  matchId: row.id, lobbyId: row.lobby_id, userIds: seats.map((s) => s.user_id), status, timer,
  finished: status === 'completed' || status === 'cancelled',
});

const admittedSeats = (seats: RoomSeatRow[]) => seats.filter((s) => s.admitted).sort((a, b) => a.seat! - b.seat!);

function resultOf(engine: AnyRoomEngine, state: EngineState, seats: RoomSeatRow[]): RoomResult {
  const userOf = new Map(admittedSeats(seats).map((s) => [s.seat!, s.user_id]));
  return {
    reason: 'score',
    standings: engine.standings(state).map((s) => ({
      seat: s.seat, userId: userOf.get(s.seat)!, points: s.points, roundWins: s.roundWins, place: s.place, withdrawn: state.status[s.seat] === 'withdrawn',
    })),
  };
}

const cancelledResult = (): RoomResult => ({ reason: 'cancelled', standings: [] });

interface Loaded { row: RoomMatchRow; seats: RoomSeatRow[]; content: unknown; engine: AnyRoomEngine }

async function load(tx: TransactionSql, matchId: string): Promise<Loaded | null> {
  const row = await roomRepo.lockMatch(tx, matchId);
  if (!row) return null;
  const seats = await roomRepo.seats(tx, row.id);
  const engine = roomEngineFor(row.game, row.engine_version);
  // A game or engine version this build does not have (a newer replica started the match during a deploy): it is not
  // ours to touch. Interactive callers get a retryable refusal; timers and presence checks let it be.
  if (!engine) throw new RoomError(ENGINE_UNSUPPORTED, 503);
  const content = await contentOf(tx, row, engine);
  if (content === null) {
    // Content gone (retention or a bug): only a cancel can end it cleanly.
    if (isLive(row.status)) await roomRepo.finish(tx, row, { status: 'cancelled', state: row.state, result: cancelledResult() });
    return null;
  }
  return { row, seats, content: await hydrated(engine, content), engine };
}

/**
 * Writes the state after any change, under the caller's lock. A terminal engine phase ends the match in the same
 * transaction. The match deadline is the earliest of the engine's own deadline and every away seat's absence deadline.
 */
async function persist(tx: TransactionSql, l: Loaded, state: EngineState, started = false): Promise<RoomEffects> {
  const seats = await roomRepo.seats(tx, l.row.id);
  const status = l.engine.terminal(state);
  if (status) {
    contentCache.delete(l.row.id);
    await roomRepo.finish(tx, l.row, { status, state, result: status === 'completed' ? resultOf(l.engine, state, seats) : cancelledResult() });
    return effectsOf(l.row, seats, status, null);
  }
  const absences = admittedSeats(seats)
    .filter((s) => state.status[s.seat!] === 'away' && s.absence_deadline_at)
    .map((s) => s.absence_deadline_at!.getTime());
  const deadline = new Date(Math.min(state.deadline, ...absences));
  const saved = await roomRepo.saveState(tx, l.row.id, { status: 'active', state, deadlineAt: deadline, started });
  return effectsOf(l.row, seats, 'active', { token: saved.phase_token, dueAt: saved.phase_deadline_at });
}

/** The engine's clock up to `nowMs`: every boundary already due, and an early close once everyone eligible is in. */
function runClock(l: Loaded, state: EngineState, nowMs: number): EngineState {
  for (let i = 0; i < 4 && !l.engine.terminal(state); i += 1) {
    const next = l.engine.tick(state, l.content, nowMs);
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
 * A scheduler deadline missed by more than ROOM_OUTAGE_MS means the server was not running: every open absence window
 * is rebased (what it had left, at least ROOM_OUTAGE_GRACE_MS, from now; the outage is not charged) and the engine
 * gives its open phase a fresh window, whichever deadline revealed the outage.
 * `changed` also covers rebased absence rows, so the caller persists the new scheduler deadline (never rebasing twice).
 */
async function advance(tx: TransactionSql, l: Loaded): Promise<{ state: EngineState; changed: boolean }> {
  const nowMs = l.row.now.getTime();
  const outageStart = l.row.phase_deadline_at;
  let state = l.row.state as EngineState;
  const before = state;
  if (outageStart && nowMs - outageStart.getTime() > ROOM_OUTAGE_MS) {
    const rebased = l.seats.some((s) => s.active && !s.connected && s.absence_deadline_at);
    if (rebased) {
      await roomRepo.rebaseAbsences(tx, l.row.id, outageStart, l.row.now, ROOM_OUTAGE_GRACE_MS);
      l.seats = await roomRepo.seats(tx, l.row.id);
    }
    state = runClock(l, l.engine.afterOutage(state, l.content, nowMs), nowMs);
    return { state, changed: rebased || state !== before };
  }
  for (let i = 0; i < 40 && !l.engine.terminal(state); i += 1) {
    const current = state;
    const away = admittedSeats(l.seats).filter((s) => current.status[s.seat!] === 'away' && s.absence_deadline_at);
    const nextAbsence = Math.min(...away.map((s) => s.absence_deadline_at!.getTime()));
    const nextEngine = current.deadline;
    if (Math.min(nextAbsence, nextEngine) > nowMs) break;
    if (nextAbsence < nextEngine) {
      const batch = away.filter((s) => s.absence_deadline_at!.getTime() === nextAbsence);
      state = l.engine.seatsChanged(current, batch.map((s): RoomSeatChange => ({ seat: s.seat!, change: 'leave' })), nextAbsence);
      for (const s of batch) await roomRepo.deactivate(tx, l.row.id, s.user_id);
    } else {
      state = l.engine.tick(current, l.content, nextEngine);
      if (state === current) break;
    }
  }
  // Then the present moment: the early close, once everyone eligible is in.
  state = runClock(l, state, nowMs);
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
  let state = l.engine.start(admitted.length, l.content, nowMs);
  // Admitted but without a socket right now: away from the start, with its own absence window.
  const away = ready.filter((s) => !s.connected);
  if (away.length > 0) {
    const seatOf = new Map(admitted.map((a) => [a.userId, a.seat]));
    state = l.engine.seatsChanged(state, away.map((s): RoomSeatChange => ({ seat: seatOf.get(s.user_id)!, change: 'away' })), nowMs);
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
  return persist(tx, l, runClock(l, l.engine.seatsChanged(advanced.state, [{ seat: me.seat!, change: 'back' }], nowMs), nowMs));
}

const absenceWindow = (s: RoomSeatRow) => Math.max(0, Math.min(ROOM_AWAY_MS, ROOM_AWAY_BUDGET_MS - s.absence_used_ms));

function seatOf(l: Loaded, userId: string): RoomSeatRow {
  const me = l.seats.find((s) => s.user_id === userId);
  if (!me) throw new RoomError('not_in_match', 403);
  return me;
}

function projectSnapshot(row: RoomMatchRow, seats: RoomSeatRow[], state: EngineState | null, content: unknown, engine: AnyRoomEngine | null, userId: string, localeOverride?: RoomLocale) {
  const me = seats.find((s) => s.user_id === userId);
  if (!me) return null;
  const locale = localeOverride ?? me.locale;
  const seatView = (s: RoomSeatRow) => ({
    seat: s.seat, slot: s.slot, userId: s.user_id, username: s.nickname ?? 'Jugador', avatarUrl: s.avatar_url,
    avatarCustomization: s.avatar_customization, isGuest: s.is_guest, ready: s.ready_at !== null, connected: s.connected,
    admitted: s.admitted, active: s.active,
  });
  const view = state && content !== null && engine && me.admitted ? engine.view(state, content, me.seat!, locale) : null;
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
  async createFromLobby(input: { lobbyId: string; game: RoomGameId; options?: unknown; players: Array<{ userId: string; isGuest: boolean }> }): Promise<RoomEffects> {
    if (input.players.length < 2 || input.players.length > ROOM_MAX_SEATS) throw new RoomError('room_needs_players');
    const engine = currentRoomEngine(input.game);
    const options = engine.parseOptions(input.options ?? null);
    if (options === undefined) throw new RoomError('room_options_invalid');
    const dealt = await engine.deal((wanted, tag) => roomRepo.pickPool(input.game, input.players.map((p) => p.userId), wanted, tag ?? null), options);
    if (!dealt) throw new RoomError('room_pool_short', 503);
    // Checked before the room is claimed; what is stored is the pack as dealt (an engine may parse it into more).
    parseContent(engine, dealt.content);
    const created = await roomRepo.withTx(async (tx) => {
      // The room must still hold the options this content was dealt for (the host may have changed them meanwhile).
      const claimed = await roomRepo.claimLobby(tx, input.lobbyId, input.game, input.players.map((p) => p.userId), input.options ?? null);
      if (!claimed) throw new RoomError('room_changed', 409);
      const created = await roomRepo.insertMatch(tx, {
        game: input.game, engineVersion: engine.version, lobbyId: input.lobbyId, readyMs: ROOM_READY_MS,
        itemIds: dealt.itemIds, content: dealt.content, seats: input.players,
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
  async ready(matchId: string, userId: string, locale: RoomLocale, clientGames?: readonly string[]): Promise<RoomEffects | null> {
    return roomRepo.withTx(async (tx) => {
      const l = await load(tx, matchId);
      if (!l) return null;
      const me = seatOf(l, userId);
      if (!clientCanPlay(l.row.game, clientGames)) throw new RoomError('client_outdated', 409);
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
      const parsed = l.engine.commandSchema.safeParse(raw);
      if (!parsed.success) result = { ok: false, code: 'invalid_command' };
      else {
        const nowMs = l.row.now.getTime();
        const applied = l.engine.apply(state, l.content, me.seat!, parsed.data, nowMs);
        if (applied.error) result = { ok: false, code: applied.error };
        else state = l.engine.tick(applied.state, l.content, nowMs); // early close when everyone is in
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
      return persist(tx, l, runClock(l, l.engine.seatsChanged(advanced.state, [{ seat: me.seat!, change: 'leave' }], l.row.now.getTime()), l.row.now.getTime()));
    });
  },

  /**
   * No socket left for a seat (after the realtime debounce), fenced by the presence generation read when the
   * disconnect was seen. Rounds never pause: the seat is away with its own window, min(30 s, what is left of 60 s).
   */
  async absent(userId: string, fence: PresenceFence | null = null): Promise<RoomEffects | null> {
    const live = await roomRepo.liveMatchForUser(userId);
    if (!live || (fence && fence.matchId !== live.id)) return null;
    return unlessUnsupported(roomRepo.withTx(async (tx) => {
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
      if (advanced.state.status[me.seat!] === 'withdrawn' || l.engine.terminal(advanced.state)) {
        return advanced.changed ? persist(tx, l, advanced.state) : gate.effects;
      }
      await roomRepo.markAbsent(tx, l.row.id, userId, new Date(l.row.now.getTime() + absenceWindow(me)));
      return persist(tx, l, runClock(l, l.engine.seatsChanged(advanced.state, [{ seat: me.seat!, change: 'away' }], l.row.now.getTime()), l.row.now.getTime()));
    }));
  },

  /**
   * A seat is here (a socket connected, or its screen resynced). A seat whose absence deadline already passed was
   * withdrawn by the catch-up; otherwise its time away is charged and it plays on (an open question is still open).
   */
  async present(userId: string, clientGames?: readonly string[]): Promise<RoomEffects | null> {
    const live = await roomRepo.liveMatchForUser(userId);
    if (!live) return null;
    return unlessUnsupported(roomRepo.withTx(async (tx) => {
      const loaded = await load(tx, live.id);
      if (!loaded) return null;
      const gate = await settleGate(tx, loaded);
      if (!gate.l) return gate.effects;
      // A socket that cannot draw this game (a tab loaded before it shipped) does not bring the seat back.
      if (!clientCanPlay(gate.l.row.game, clientGames)) return gate.effects;
      return (await presentLocked(tx, gate.l, userId)) ?? gate.effects;
    }));
  },

  presenceGeneration(userId: string): Promise<PresenceFence | null> {
    return roomRepo.presenceGeneration(userId);
  },

  /** The match deadline ran out (timer or recovery poll). An old phase token, or a deadline not yet due, changes nothing. */
  async expire(matchId: string, token: number | null): Promise<RoomEffects | null> {
    return unlessUnsupported(roomRepo.withTx(async (tx) => {
      const l = await load(tx, matchId);
      if (!l || (l.row.status !== 'ready' && l.row.status !== 'active') || !l.row.phase_deadline_at) return null;
      if (token !== null && token !== l.row.phase_token) return null;
      if (l.row.phase_deadline_at.getTime() > l.row.now.getTime()) {
        return effectsOf(l.row, l.seats, l.row.status, { token: l.row.phase_token, dueAt: l.row.phase_deadline_at });
      }
      if (l.row.status === 'ready') return closeGate(tx, l, true);
      const advanced = await advance(tx, l);
      return persist(tx, l, advanced.state);
    }));
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
    const engine = roomEngineFor(row.game, row.engine_version);
    const parsed = state && engine ? await contentOf(undefined, row, engine) : null;
    const content = parsed !== null && engine ? await hydrated(engine, parsed) : null;
    for (const userId of recipients) {
      const snapshot = projectSnapshot(row, seats, state, content, engine, userId, localeOverride);
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

  /** What a seat's refused text was about, for a report; null when there is nothing to report (see RoomEngine.refusal). */
  async refusal(matchId: string, userId: string, round: number, text: string): Promise<(RoomRefusal & { game: RoomGameId }) | null> {
    const found = await roomRepo.seatedMatch(matchId, userId);
    if (!found || found.state === null) return null;
    const engine = roomEngineFor(found.game, found.engine_version);
    const content = engine?.refusal ? engine.parseContent(found.content) : null;
    if (!engine?.refusal || content === null) return null;
    const refusal = engine.refusal(found.state as EngineState, await hydrated(engine, content), round, text);
    return refusal && { ...refusal, game: found.game };
  },
};

export { ROOM_LOCALES };
