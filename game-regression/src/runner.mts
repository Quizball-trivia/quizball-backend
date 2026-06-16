/**
 * In-process match runner: boots a REAL ranked-AI match through the production
 * path (ranked:queue_join -> processFallbacks -> startRankedAiForUser -> draft ->
 * match) using the FakeIo adapter + the harness clock, and returns the EventTrace.
 *
 * IMPORTANT: the engine reads config (DATABASE_URL / REDIS_URL) at import time, so
 * callers MUST set those env vars to the LOCAL DB/Redis BEFORE importing this
 * module. The test harness does that in its setup.
 *
 * Consumed from a vitest test (fake timers live there). `vi` is injected.
 */
import { FakeIo, createTrace, type EventTrace, type FakeSocket } from './adapter.mjs';
import { seedFixtures, seedTestUserWithTicket, type SeededFixtures } from './fixtures.mjs';

// Engine imports (resolved against backend-node/src).
import { getRedisClient, initRedisClients } from '../../src/realtime/redis.js';
import { rankedMatchmakingService } from '../../src/realtime/services/ranked-matchmaking.service.js';
import { startRealtimeTimerScheduler, stopRealtimeTimerScheduler } from '../../src/realtime/realtime-timer-scheduler.js';
import { buildRealtimeTimerHandlers } from '../../src/realtime/socket-server.js';
import {
  handlePossessionAnswer,
  handlePossessionCountdownGuess,
  handlePossessionPutInOrderAnswer,
  handlePossessionCluesAnswer,
} from '../../src/realtime/possession-answer-handlers.js';
import {
  handleMatchDisconnect,
  handleMatchRejoin,
  handleResumeUiReady,
  resolveExpiredGraceWindow,
} from '../../src/realtime/services/match-disconnect.service.js';
import { handleMatchForfeit, finalizeMatchAsForfeit } from '../../src/realtime/services/match-forfeit.service.js';
import { matchPlayersRepo } from '../../src/modules/matches/match-players.repo.js';
import { matchesRepo } from '../../src/modules/matches/matches.repo.js';
import { matchRealtimeService } from '../../src/realtime/services/match-realtime.service.js';
import { devSkipToPossessionPhase } from '../../src/realtime/possession-match-flow.js';
import {
  createLobby,
  joinByCode,
  setReady,
  updateSettings,
  startFriendlyMatch,
} from '../../src/realtime/services/lobby-commands.service.js';
// Variant-routing answer entry (party_quiz -> handlePartyQuizAnswer; else possession).
import { handleAnswer } from '../../src/realtime/services/match-question-dispatch.service.js';
// Party-quiz advances to the next question via a ready-ack gate; the bot must ack
// (like a real client) or each round waits the full ~8s ceiling.
import { handlePartyQuizReadyForNextQuestion } from '../../src/realtime/party-quiz-match-flow.js';

export interface RunMatchResult {
  trace: EventTrace;
  fixtures: SeededFixtures;
  botUserId: string;
  matchId: string | null;
  io: FakeIo;
  botSocket: FakeSocket;
}

export interface RunMatchOptions {
  botUserId?: string;
  seed?: string;
  /** Max real-ms to wait for the match to start. With REGRESSION_FAST_TIMERS the
   *  whole boot is a few hundred ms, so a couple of seconds is ample. */
  startTimeoutMs?: number;
}

const BOT_USER_ID = '00000000-0000-0000-0000-0000000000b0';
// Second human seat for friendly human-vs-human lobby matches.
const BOT2_USER_ID = '00000000-0000-0000-0000-0000000000b1';

/** A friendly lobby match driven by TWO human bot seats (no AI). */
export interface RunLobbyResult {
  trace: EventTrace;
  fixtures: SeededFixtures;
  lobbyId: string | null;
  inviteCode: string | null;
  matchId: string | null;
  variant: 'friendly_possession' | 'friendly_party_quiz';
  io: FakeIo;
  /** seat sockets, host first. */
  hostUserId: string;
  joinerUserId: string;
  hostSocket: FakeSocket;
  joinerSocket: FakeSocket;
  /** all human seats, for play loops. */
  seats: Array<{ userId: string; socket: FakeSocket }>;
}

/** Real-time poll until `predicate` is true or `maxMs` elapses. */
async function waitUntil(predicate: () => boolean, maxMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  if (predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    if (predicate()) return true;
  }
  return false;
}

/** Boot a ranked-AI match and return the trace once a match:start is observed. */
export async function bootMatch(options: RunMatchOptions = {}): Promise<RunMatchResult> {
  const botUserId = options.botUserId ?? BOT_USER_ID;

  const now = () => Date.now();
  const trace = createTrace(now);
  const io = new FakeIo(trace);

  // 1. Seed fixtures + ticketed bot user.
  const fixtures = await seedFixtures({ categoryCount: 3, mcqPerCategory: 5 });
  await seedTestUserWithTicket({ userId: botUserId, nickname: 'RegressionBot', tickets: 1 });

  // 2. Redis + the durable timer scheduler + the matchmaking loop.
  await initRedisClients();
  // Flush the selected regression Redis DB so leftover matchmaking/queue/timer
  // entries from a prior (or killed) run can't confuse this one. Keep this scoped
  // to the selected DB so a local dev backend on DB 0 cannot be disrupted.
  const redisForFlush = getRedisClient();
  if (redisForFlush?.isOpen) await redisForFlush.flushDb();
  startRealtimeTimerScheduler(io as never, buildRealtimeTimerHandlers());
  rankedMatchmakingService.start(io as never);

  // 3. The bot socket (one human seat), joined to its own user room.
  const botSocket: FakeSocket = io.createSocket('bot-socket-1', {
    user: { id: botUserId },
    connectedAt: now(),
  });
  botSocket.join(`user:${botUserId}`);

  // 4. Join the ranked queue (real production entry point).
  await rankedMatchmakingService.handleQueueJoin(io as never, botSocket as never);

  // 5. Wait (real, fast time) for queue -> AI fallback -> draft -> match:start ->
  //    first question. With REGRESSION_FAST_TIMERS the delays are ~5ms each.
  const startTimeout = options.startTimeoutMs ?? 10_000;
  const started = await waitUntil(
    () => trace.byEvent('match:start').length > 0 && trace.byEvent('match:question').length > 0,
    startTimeout,
  );

  let matchId: string | null = null;
  if (started) {
    const startEvt = trace.byEvent('match:start')[0];
    const payload = startEvt.payload as { matchId?: string } | undefined;
    matchId = payload?.matchId ?? null;
    if (matchId) botSocket.data.matchId = matchId;
  }

  return { trace, fixtures, botUserId, matchId, io, botSocket };
}

interface QuestionEventPayload {
  matchId: string;
  qIndex: number;
  question?: { kind?: string; items?: Array<{ id: string }> };
  correctIndex?: number;
  playableAt?: string;
  deadlineAt?: string;
}

/** ms until a question becomes answerable (`playableAt`), clamped to >= 0. A real
 *  client cannot submit before the reveal window ends; on RESUME the engine sets a
 *  fresh reveal-remaining `playableAt` in the future, so answering instantly is a
 *  fidelity violation that can look like a stuck match. */
function msUntilPlayable(q: QuestionEventPayload): number {
  if (!q.playableAt) return 0;
  const at = new Date(q.playableAt).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at - Date.now());
}

/** How the bot answers. 'correct' scores; 'wrong' submits a deliberately-wrong
 *  answer (0 points) so neither side accumulates possession — useful for steering
 *  the match toward a low-scoring draw → PENALTY_SHOOTOUT. */
export type AnswerMode = 'correct' | 'wrong';

/** Submit a bot answer for whatever question kind was dispatched, so the round
 *  resolves on both-answered instead of waiting for the timeout. */
async function answerQuestion(
  io: FakeIo,
  botSocket: FakeSocket,
  q: QuestionEventPayload,
  mode: AnswerMode = 'correct',
): Promise<void> {
  const base = { matchId: q.matchId, qIndex: q.qIndex, timeMs: 300 };
  const kind = q.question?.kind;
  if (kind === 'multipleChoice') {
    // 'wrong' picks any index != correctIndex (engine validates → 0 points).
    const correct = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
    const wrong = correct === 0 ? 1 : 0;
    await handlePossessionAnswer(io as never, botSocket as never, {
      ...base,
      selectedIndex: mode === 'wrong' ? wrong : correct,
    });
  } else if (kind === 'countdown') {
    await handlePossessionCountdownGuess(botSocket as never, {
      matchId: q.matchId, qIndex: q.qIndex,
      guess: mode === 'wrong' ? 'zzzznotananswer' : 'one',
    });
  } else if (kind === 'putInOrder') {
    const ids = (q.question?.items ?? []).map((i) => i.id);
    // 'wrong' reverses the order so it scores 0 (or near-0).
    await handlePossessionPutInOrderAnswer(io as never, botSocket as never, {
      ...base,
      orderedItemIds: mode === 'wrong' ? [...ids].reverse() : ids,
    });
  } else if (kind === 'clues') {
    await handlePossessionCluesAnswer(io as never, botSocket as never, {
      kind: 'guess', matchId: q.matchId, qIndex: q.qIndex,
      guess: mode === 'wrong' ? 'zzzznotananswer' : 'answer', timeMs: 300,
    });
  }
}

/**
 * Drive the bot to play the match to completion. The bot answers MCQ questions
 * (correctly, deterministically — score control comes later via the planner) and
 * lets non-MCQ specials time out (the engine resolves them); the AI side is
 * server-driven. Halftime banning auto-resolves via its timer. Returns when
 * match:final_results is observed or the timeout elapses.
 */
export async function playMatch(
  run: RunMatchResult,
  opts: {
    maxMs?: number;
    answerEveryMs?: number;
    answerMode?: AnswerMode;
    /** qIndexes the bot deliberately does NOT answer, forcing the engine's
     *  question-timeout to resolve those rounds (the timeout-expire scenario). */
    skipQIndices?: Iterable<number>;
  } = {},
): Promise<void> {
  const { trace, io, botSocket } = run;
  const maxMs = opts.maxMs ?? 30_000;
  const answerMode = opts.answerMode ?? 'correct';
  const skip = new Set<number>(opts.skipQIndices ?? []);
  const answered = new Set<number>();
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    if (trace.byEvent('match:final_results').length > 0) return;

    // Answer the latest unanswered question (any kind) so the round resolves.
    const questions = trace.byEvent('match:question');
    const latest = questions[questions.length - 1]?.payload as QuestionEventPayload | undefined;
    if (latest && !answered.has(latest.qIndex) && !skip.has(latest.qIndex)) {
      answered.add(latest.qIndex);
      // Respect the reveal window: don't answer before playableAt (a real client
      // can't). Matters on RESUME, where the question's playableAt is pushed into
      // the future by the reveal-remaining offset.
      const wait = msUntilPlayable(latest);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + 5));
      try {
        await answerQuestion(io, botSocket, latest, answerMode);
      } catch {
        // A late/duplicate/invalid answer can throw; ignore — the engine guards
        // it and the round still resolves on timeout if needed.
      }
    }
    await new Promise((r) => setTimeout(r, opts.answerEveryMs ?? 50));
  }
}

/** Boot + play a full match to completion; returns the result with its trace. */
export async function runFullMatch(options: RunMatchOptions = {}): Promise<RunMatchResult> {
  const run = await bootMatch(options);
  if (run.matchId) await playMatch(run);
  return run;
}

/**
 * Drive a FRIENDLY (human-vs-human) match where EVERY seat answers each question.
 * For friendly_possession both seats answer the current question; for
 * friendly_party_quiz all seats answer (MCQ only). Each seat answers a given
 * qIndex at most once. Returns when final_results is observed or maxMs elapses.
 */
export async function playLobbyMatch(
  run: RunLobbyResult,
  opts: { maxMs?: number; answerEveryMs?: number; answerMode?: AnswerMode } = {},
): Promise<void> {
  const { trace, io, seats } = run;
  const maxMs = opts.maxMs ?? 90_000;
  const answerMode = opts.answerMode ?? 'correct';
  // qIndexes each seat has already answered.
  const answeredBySeat = new Map<string, Set<number>>(seats.map((s) => [s.userId, new Set<number>()]));
  // Party quiz advances via a ready-ack gate per resolved round; track which
  // qIndexes each seat has acked so the bot "taps next" like a real client.
  const ackedBySeat = new Map<string, Set<number>>(seats.map((s) => [s.userId, new Set<number>()]));
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    if (trace.byEvent('match:final_results').length > 0) return;

    const questions = trace.byEvent('match:question');
    const latest = questions[questions.length - 1]?.payload as QuestionEventPayload | undefined;
    if (latest) {
      const wait = msUntilPlayable(latest);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait + 5));
      for (const seat of seats) {
        const done = answeredBySeat.get(seat.userId)!;
        if (done.has(latest.qIndex)) continue;
        done.add(latest.qIndex);
        try {
          if (run.variant === 'friendly_party_quiz') {
            // Party quiz is MCQ-only; route through the variant-aware entry.
            const correct = typeof latest.correctIndex === 'number' ? latest.correctIndex : 0;
            await handleAnswer(io as never, seat.socket as never, {
              matchId: latest.matchId, qIndex: latest.qIndex, timeMs: 300,
              selectedIndex: answerMode === 'wrong' ? (correct === 0 ? 1 : 0) : correct,
            } as never);
          } else {
            await answerQuestion(io, seat.socket, latest, answerMode);
          }
        } catch {
          // late/duplicate/invalid — engine guards it; round still resolves.
        }
      }
    }

    // Party quiz: after a round resolves, every seat acks "ready for next" so the
    // post-round gate advances immediately instead of waiting the ~8s ceiling.
    if (run.variant === 'friendly_party_quiz' && run.matchId) {
      for (const evt of trace.byEvent('match:round_result')) {
        const qIndex = (evt.payload as { qIndex?: number }).qIndex;
        if (typeof qIndex !== 'number') continue;
        for (const seat of seats) {
          const acked = ackedBySeat.get(seat.userId)!;
          if (acked.has(qIndex)) continue;
          acked.add(qIndex);
          try { handlePartyQuizReadyForNextQuestion(seat.userId, run.matchId, qIndex); } catch { /* gate guards it */ }
        }
      }
    }
    await new Promise((r) => setTimeout(r, opts.answerEveryMs ?? 50));
  }
}

// ── Lifecycle / chaos actions (drive the REAL socket lifecycle layer) ──
// These go through the same entry points the socket server wires, so they
// exercise the session guard, presence keys, grace timer, and resume path —
// where the orphaned-match/freeze bugs live.

/** The bot disconnects (transport drop) — pauses the match, starts the grace window. */
export async function botDisconnect(run: RunMatchResult): Promise<void> {
  await handleMatchDisconnect(run.io as never, run.botSocket as never);
}

/**
 * Force the grace window to expire NOW (what the durable match_disconnect_forfeit
 * timer would do after 60s). Resolves the match: forfeit the absent bot / abandon.
 */
export async function expireGrace(run: RunMatchResult): Promise<void> {
  if (run.matchId) {
    await resolveExpiredGraceWindow(run.io as never, run.matchId, run.botUserId);
  }
}

/**
 * The bot reconnects: drop the old fake socket, make a NEW one for the same user,
 * run connect hydration + rejoin (the real reconnect path).
 */
export async function botReconnect(run: RunMatchResult): Promise<void> {
  run.io.removeSocket(run.botSocket);
  const fresh = run.io.createSocket(`bot-socket-${Date.now()}`, {
    user: { id: run.botUserId },
    connectedAt: Date.now(),
    ...(run.matchId ? { matchId: run.matchId } : {}),
  });
  fresh.join(`user:${run.botUserId}`);
  run.botSocket = fresh;
  // Connect hydration (rejoinActiveMatchOnConnect) then explicit rejoin.
  await matchRealtimeService.rejoinActiveMatchOnConnect(run.io as never, fresh as never);
  if (run.matchId) {
    await handleMatchRejoin(run.io as never, fresh as never, run.matchId);
    await handleResumeUiReady(run.io as never, fresh as never, { matchId: run.matchId });
    // Rejoin schedules a resume countdown (collapsed under fast-timers) that emits
    // match:resume + re-dispatches the question. Wait for it so play can continue.
    // THROW if it never fires — "resume never happened" was a real bug, so this
    // helper must fail loudly rather than silently continue on a stuck match.
    const before = run.trace.byEvent('match:resume').length;
    const resumed = await waitUntil(() => run.trace.byEvent('match:resume').length > before, 8_000);
    if (!resumed) {
      throw new Error('botReconnect: match:resume never fired after rejoin (resume stuck).');
    }
  }
}

/** The bot explicitly forfeits/quits the match. */
export async function botForfeit(run: RunMatchResult): Promise<void> {
  await handleMatchForfeit(run.io as never, run.botSocket as never, run.matchId);
}

/**
 * The OPPONENT (AI) forfeits, leaving the bot as the surviving winner — drives
 * `finalizeMatchAsForfeit` directly with the opponent's userId (the AI has no
 * socket to emit from). Used to verify the winner-side economy: forfeit-win base
 * + goal-margin bonus when the bot was ahead. Returns the opponent's userId.
 */
export async function opponentForfeit(run: RunMatchResult): Promise<string | null> {
  if (!run.matchId) return null;
  const roster = await matchPlayersRepo.listMatchPlayers(run.matchId);
  const opponent = roster.find((p) => p.user_id !== run.botUserId);
  if (!opponent) return null;
  const activeMatch = await matchesRepo.getMatch(run.matchId);
  if (!activeMatch) return null;
  await finalizeMatchAsForfeit({
    matchId: run.matchId,
    forfeitingUserId: opponent.user_id,
    activeMatch: activeMatch as never,
    cacheSnapshot: null,
    cleanupRedisKeys: [],
  });
  return opponent.user_id;
}

/**
 * Deterministically jump the match to a phase via the production dev-skip seam
 * (`devSkipToPossessionPhase`). Used to reach phases that are otherwise gated on
 * a stochastic outcome — e.g. 'penalty_ban' (a tied match) routes through the
 * HALFTIME ban interlude into PENALTY_SHOOTOUT, which a normal run only reaches
 * on a draw (the harness AI is non-deterministic, so a draw can't be forced by
 * play alone). This goes through the same engine path the dev route uses.
 */
export async function botSkipToPhase(
  run: RunMatchResult,
  target: 'halftime' | 'last_attack' | 'shot' | 'penalties' | 'penalty_ban' | 'second_half',
): Promise<void> {
  if (!run.matchId) throw new Error('botSkipToPhase: no matchId');
  await devSkipToPossessionPhase(run.io as never, run.matchId, target);
}

// ── Friendly lobby (human-vs-human) boot ──
// Drives the REAL lobby flow: createLobby -> joinByCode -> setReady(x2) ->
// startFriendlyMatch -> beginMatchForLobby. No AI; both seats are bot humans.

export interface FriendlyLobbyOptions {
  variant?: 'friendly_possession' | 'friendly_party_quiz';
  /** extra joiners for party_quiz (3..6 players). Each gets a derived bot user. */
  extraPlayers?: number;
  startTimeoutMs?: number;
}

/** Boot a friendly human-vs-human match through the production lobby path. */
export async function bootFriendlyLobbyMatch(opts: FriendlyLobbyOptions = {}): Promise<RunLobbyResult> {
  const variant = opts.variant ?? 'friendly_possession';
  const now = () => Date.now();
  const trace = createTrace(now);
  const io = new FakeIo(trace);

  // 1. Fixtures + the two (or more) ticketed bot users. Friendly doesn't spend a
  //    ranked ticket, but seedTestUserWithTicket also creates the users row.
  const fixtures = await seedFixtures({ categoryCount: 3, mcqPerCategory: 5 });
  const extra = variant === 'friendly_party_quiz' ? Math.max(0, opts.extraPlayers ?? 0) : 0;
  const playerIds = [BOT_USER_ID, BOT2_USER_ID];
  for (let i = 0; i < extra; i++) {
    // Derive stable extra user ids: ...b2, b3, ...
    playerIds.push(`00000000-0000-0000-0000-0000000000b${i + 2}`);
  }
  for (let i = 0; i < playerIds.length; i++) {
    await seedTestUserWithTicket({ userId: playerIds[i], nickname: `LobbyBot${i + 1}`, tickets: 1 });
  }

  // 2. Redis + scheduler (no matchmaking loop needed for friendly).
  await initRedisClients();
  const redisForFlush = getRedisClient();
  if (redisForFlush?.isOpen) await redisForFlush.flushDb();
  startRealtimeTimerScheduler(io as never, buildRealtimeTimerHandlers());

  // 3. Sockets, one per seat, each in its own user room.
  const sockets = playerIds.map((userId, i) => {
    const s = io.createSocket(`lobby-bot-${i}`, { user: { id: userId }, connectedAt: now() });
    s.join(`user:${userId}`);
    return s;
  });
  const hostSocket = sockets[0];
  const joinerSockets = sockets.slice(1);

  // 4. Host creates the lobby.
  const created = await createLobby(io as never, hostSocket as never, { mode: 'friendly' });
  const lobbyId = created.ok ? created.lobbyId : null;
  const inviteCode = created.ok ? created.inviteCode : null;
  if (!lobbyId || !inviteCode) {
    return buildLobbyResult(trace, fixtures, null, inviteCode, null, variant, io, playerIds, sockets);
  }

  // 5. Everyone else joins by code.
  for (const js of joinerSockets) {
    await joinByCode(io as never, js as never, inviteCode);
  }

  // 6. Host sets the game mode/variant (possession is the default; switch for party).
  if (variant === 'friendly_party_quiz') {
    await updateSettings(io as never, hostSocket as never, { gameMode: 'friendly_party_quiz', friendlyRandom: true });
  } else {
    await updateSettings(io as never, hostSocket as never, { gameMode: 'friendly_possession', friendlyRandom: true });
  }

  // 7. Everyone readies up.
  for (const s of sockets) {
    await setReady(io as never, s as never, true);
  }

  // 8. Host starts → beginMatchForLobby → match:start + countdown + first question.
  await startFriendlyMatch(io as never, hostSocket as never);

  const startTimeout = opts.startTimeoutMs ?? 25_000;
  const started = await waitUntil(
    () => trace.byEvent('match:start').length > 0 && trace.byEvent('match:question').length > 0,
    startTimeout,
  );
  let matchId: string | null = null;
  if (started) {
    const startEvt = trace.byEvent('match:start')[0];
    matchId = (startEvt.payload as { matchId?: string } | undefined)?.matchId ?? null;
    if (matchId) for (const s of sockets) s.data.matchId = matchId;
  }

  return buildLobbyResult(trace, fixtures, lobbyId, inviteCode, matchId, variant, io, playerIds, sockets);
}

function buildLobbyResult(
  trace: EventTrace, fixtures: SeededFixtures, lobbyId: string | null, inviteCode: string | null,
  matchId: string | null, variant: 'friendly_possession' | 'friendly_party_quiz', io: FakeIo,
  playerIds: string[], sockets: FakeSocket[],
): RunLobbyResult {
  return {
    trace, fixtures, lobbyId, inviteCode, matchId, variant, io,
    hostUserId: playerIds[0], joinerUserId: playerIds[1],
    hostSocket: sockets[0], joinerSocket: sockets[1],
    seats: playerIds.map((userId, i) => ({ userId, socket: sockets[i] })),
  };
}

/** Tear down scheduler + matchmaking loop + redis between runs. */
export async function teardownRun(): Promise<void> {
  rankedMatchmakingService.stop();
  stopRealtimeTimerScheduler();
  const redis = getRedisClient();
  if (redis?.isOpen) {
    // best-effort flush of harness keys is left to the caller's DB/redis reset
  }
}
