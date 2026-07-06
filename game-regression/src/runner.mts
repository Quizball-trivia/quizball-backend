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
import { draftRealtimeService } from '../../src/realtime/services/draft-realtime.service.js';
import {
  handlePossessionAnswer,
  handlePossessionCountdownGuess,
  handlePossessionPutInOrderAnswer,
  handlePossessionCluesAnswer,
} from '../../src/realtime/possession-answer-handlers.js';
import {
  handleMatchDisconnect,
  handleMatchRejoin,
  pauseMatchForDisconnectedPlayer,
  resolveExpiredGraceWindow,
} from '../../src/realtime/services/match-disconnect.service.js';
import { handleMatchForfeit, finalizeMatchAsForfeit } from '../../src/realtime/services/match-forfeit.service.js';
import { matchPlayersRepo } from '../../src/modules/matches/match-players.repo.js';
import { matchesRepo } from '../../src/modules/matches/matches.repo.js';
import { matchRealtimeService } from '../../src/realtime/services/match-realtime.service.js';
import {
  devSkipToPossessionPhase,
  handlePossessionReadyForNextQuestion,
} from '../../src/realtime/possession-match-flow.js';
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
import { recordMatchStagePresenceHeartbeat } from '../../src/realtime/services/match-stage-presence.service.js';
import type { ChaosAction, ChaosPlan } from './chaos.mjs';

export interface RunMatchResult {
  trace: EventTrace;
  fixtures: SeededFixtures;
  botUserId: string;
  matchId: string | null;
  io: FakeIo;
  botSocket: FakeSocket;
  autoClientReadyAcks: boolean;
  lastSupersededSocket?: { id: string; connectedAt: number };
  suppressAutoRejoinAvailable?: boolean;
  suppressedRejoinAvailableThroughSeq?: number;
}

export interface RunMatchOptions {
  botUserId?: string;
  seed?: string;
  /** Max real-ms to wait for the match to start. With REGRESSION_FAST_TIMERS the
   *  whole boot is a few hundred ms, so a couple of seconds is ample. */
  startTimeoutMs?: number;
  /** Opt out only for withheld-ack regression scenarios. */
  autoClientReadyAcks?: boolean;
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

interface BotClientAckState {
  draftUiReady: Set<string>;
  kickoffUiReady: Set<string>;
  resumeUiReady: Set<string>;
  readyForNextQuestion: Set<string>;
  lastRejoinAvailableSeq: number;
}

function createBotClientAckState(): BotClientAckState {
  return {
    draftUiReady: new Set(),
    kickoffUiReady: new Set(),
    resumeUiReady: new Set(),
    readyForNextQuestion: new Set(),
    lastRejoinAvailableSeq: -1,
  };
}

function matchIdFromPayload(payload: unknown): string | null {
  const matchId = (payload as { matchId?: unknown } | undefined)?.matchId;
  return typeof matchId === 'string' ? matchId : null;
}

function qIndexFromPayload(payload: unknown): number | null {
  const qIndex = (payload as { qIndex?: unknown } | undefined)?.qIndex;
  return typeof qIndex === 'number' ? qIndex : null;
}

function latestDraftStart(trace: EventTrace) {
  const starts = trace.byEvent('draft:start');
  return starts[starts.length - 1];
}

async function ackBotDraftUiReady(
  io: FakeIo,
  botSocket: FakeSocket,
  trace: EventTrace,
  acks: BotClientAckState,
): Promise<void> {
  const start = latestDraftStart(trace);
  if (!start) return;
  const lobbyId = (start.payload as { lobbyId?: unknown } | undefined)?.lobbyId;
  if (typeof lobbyId !== 'string') return;

  const banCount = trace.events.filter((event) =>
    event.seq > start.seq
    && event.event === 'draft:banned'
    && event.target === `lobby:${lobbyId}`
  ).length;
  const key = `${botSocket.data.user.id}:${lobbyId}:${banCount}`;
  if (acks.draftUiReady.has(key)) return;

  await draftRealtimeService.handleUiReady(io as never, botSocket as never, { lobbyId, banCount });
  acks.draftUiReady.add(key);
}

function collectKickoffMatchIds(trace: EventTrace): string[] {
  const matchIds = new Set<string>();
  for (const event of trace.byEvent('match:start')) {
    const matchId = matchIdFromPayload(event.payload);
    if (matchId) matchIds.add(matchId);
  }
  for (const event of trace.byEvent('match:waiting_for_ready')) {
    const payload = event.payload as { phase?: unknown } | undefined;
    if (payload?.phase !== 'kickoff') continue;
    const matchId = matchIdFromPayload(event.payload);
    if (matchId) matchIds.add(matchId);
  }
  return [...matchIds];
}

async function ackKickoffUiReadyFromTrace(
  io: FakeIo,
  trace: EventTrace,
  sockets: FakeSocket[],
  acks: BotClientAckState,
): Promise<void> {
  for (const matchId of collectKickoffMatchIds(trace)) {
    for (const socket of sockets) {
      const key = `${socket.data.user.id}:${matchId}`;
      if (acks.kickoffUiReady.has(key)) continue;
      await matchRealtimeService.handleKickoffUiReady(io as never, socket as never, { matchId });
      acks.kickoffUiReady.add(key);
    }
  }
}

async function ackResumeUiReadyFromTrace(
  io: FakeIo,
  trace: EventTrace,
  sockets: FakeSocket[],
  acks: BotClientAckState,
  recordClientEvents = false,
): Promise<void> {
  for (const event of trace.byEvent('match:waiting_for_ready')) {
    const payload = event.payload as { phase?: unknown; forceStartsAt?: unknown } | undefined;
    if (payload?.phase !== 'resume') continue;
    const matchId = matchIdFromPayload(event.payload);
    if (!matchId) continue;
    const gateId = typeof payload.forceStartsAt === 'string' ? payload.forceStartsAt : String(event.seq);
    for (const socket of sockets) {
      const key = `${socket.data.user.id}:${matchId}:${gateId}`;
      if (acks.resumeUiReady.has(key)) continue;
      if (recordClientEvents) {
        trace.record('client->server', 'match:resume_ui_ready', {
          matchId,
          userId: socket.data.user.id,
        }, socket.id);
      }
      await matchRealtimeService.handleResumeUiReady(io as never, socket as never, { matchId });
      acks.resumeUiReady.add(key);
    }
  }
}

function latestTraceSeq(trace: EventTrace): number {
  return trace.events[trace.events.length - 1]?.seq ?? -1;
}

async function botSocketIsLive(run: RunMatchResult): Promise<boolean> {
  const sockets = await run.io.in(run.botSocket.id).fetchSockets();
  return sockets.some((socket) => socket.id === run.botSocket.id);
}

async function handleBotRejoinAvailableFromTrace(
  run: RunMatchResult,
  acks: BotClientAckState,
): Promise<boolean> {
  if (run.autoClientReadyAcks === false) return false;

  const userRoom = `user:${run.botUserId}`;
  if (run.suppressAutoRejoinAvailable) {
    const latest = Math.max(
      run.suppressedRejoinAvailableThroughSeq ?? -1,
      ...run.trace.events
        .filter((event) => event.event === 'match:rejoin_available' && event.target === userRoom)
        .map((event) => event.seq),
    );
    run.suppressedRejoinAvailableThroughSeq = latest;
    return false;
  }

  let handled = false;
  const suppressedThrough = run.suppressedRejoinAvailableThroughSeq ?? -1;
  for (const event of run.trace.events) {
    if (event.seq <= acks.lastRejoinAvailableSeq || event.seq <= suppressedThrough) continue;
    if (event.event !== 'match:rejoin_available' || event.target !== userRoom) continue;

    acks.lastRejoinAvailableSeq = event.seq;
    const matchId = matchIdFromPayload(event.payload);
    if (!matchId || (run.matchId && matchId !== run.matchId)) continue;
    if (!(await botSocketIsLive(run))) continue;

    run.trace.record('client->server', 'match:rejoin', {
      matchId,
      userId: run.botUserId,
      socketId: run.botSocket.id,
      source: 'autoRejoinAvailable',
    }, run.botSocket.id);
    await handleMatchRejoin(run.io as never, run.botSocket as never, matchId);
    if (run.trace.byEvent('match:final_results').length > 0) return true;
    await ackResumeUiReadyFromTrace(run.io, run.trace, [run.botSocket], acks, true);
    handled = true;
  }
  return handled;
}

function ackPossessionReadyForNextQuestionFromTrace(
  trace: EventTrace,
  seats: Array<{ userId: string }>,
  acks: BotClientAckState,
): void {
  for (const event of trace.byEvent('match:round_result')) {
    const matchId = matchIdFromPayload(event.payload);
    const qIndex = qIndexFromPayload(event.payload);
    if (!matchId || qIndex === null) continue;
    for (const seat of seats) {
      const key = `${seat.userId}:${matchId}:${qIndex}`;
      if (acks.readyForNextQuestion.has(key)) continue;
      handlePossessionReadyForNextQuestion(seat.userId, matchId, qIndex);
      acks.readyForNextQuestion.add(key);
    }
  }
}

/** Real-time poll until `predicate` is true or `maxMs` elapses. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  maxMs: number,
  stepMs = 25,
  onPoll?: () => void | Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  await onPoll?.();
  if (await predicate()) return true;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
    await onPoll?.();
    if (await predicate()) return true;
  }
  return false;
}

/** Boot a ranked-AI match and return the trace once a match:start is observed. */
export async function bootMatch(options: RunMatchOptions = {}): Promise<RunMatchResult> {
  const botUserId = options.botUserId ?? BOT_USER_ID;
  const autoClientReadyAcks = options.autoClientReadyAcks ?? true;

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
  const bootAcks = createBotClientAckState();
  const started = await waitUntil(
    () => trace.byEvent('match:start').length > 0 && trace.byEvent('match:question').length > 0,
    startTimeout,
    25,
    autoClientReadyAcks
      ? async () => {
          await ackBotDraftUiReady(io, botSocket, trace, bootAcks);
          await ackKickoffUiReadyFromTrace(io, trace, [botSocket], bootAcks);
        }
      : undefined,
  );

  let matchId: string | null = null;
  if (started) {
    const startEvt = trace.byEvent('match:start')[0];
    const payload = startEvt.payload as { matchId?: string } | undefined;
    matchId = payload?.matchId ?? null;
    if (matchId) botSocket.data.matchId = matchId;
  }

  return { trace, fixtures, botUserId, matchId, io, botSocket, autoClientReadyAcks };
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

export interface BotAnswerPlan {
  mode?: AnswerMode;
  timeMs?: number;
  emitRevealAckAtMs?: number;
  answerAtMs?: number;
}

function msUntilQuestionOffset(q: QuestionEventPayload, offsetMs: number): number {
  if (!q.playableAt) return 0;
  const at = new Date(q.playableAt).getTime();
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at + offsetMs - Date.now());
}

async function waitMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function executeChaosAction(run: RunMatchResult, action: ChaosAction): Promise<void> {
  run.trace.record('client->server', 'chaos:action', {
    matchId: run.matchId,
    userId: run.botUserId,
    atQIndex: action.atQIndex,
    kind: action.kind,
    params: action.params ?? null,
  }, run.botSocket.id);

  if (action.kind === 'flap') {
    await flap(run, Math.max(1, Math.floor(Number(action.params?.n ?? 1) || 1)));
  } else if (action.kind === 'staleDisconnect') {
    await staleDisconnect(run);
  } else if (action.kind === 'quitRejoin') {
    await quitRejoin(run);
  } else if (action.kind === 'multiTab') {
    await multiTab(run);
  } else if (action.kind === 'zombieReconnect') {
    await zombieReconnect(run);
  } else if (action.kind === 'expireGraceAfterDisconnect') {
    await expireGraceAfterDisconnect(run);
  }
}

/** Submit a bot answer for whatever question kind was dispatched, so the round
 *  resolves on both-answered instead of waiting for the timeout. */
async function answerQuestion(
  io: FakeIo,
  botSocket: FakeSocket,
  q: QuestionEventPayload,
  mode: AnswerMode = 'correct',
  timeMs = 300,
): Promise<void> {
  const base = { matchId: q.matchId, qIndex: q.qIndex, timeMs };
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
      guess: mode === 'wrong' ? 'zzzznotananswer' : 'answer', timeMs,
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
    answerPlan?: Record<number, BotAnswerPlan>;
    chaosPlan?: ChaosPlan;
  } = {},
): Promise<void> {
  const { trace, io } = run;
  const maxMs = opts.maxMs ?? 30_000;
  const answerMode = opts.answerMode ?? 'correct';
  const skip = new Set<number>(opts.skipQIndices ?? []);
  const answered = new Set<number>();
  const executedChaos = new Set<number>();
  const playAcks = createBotClientAckState();
  const deadline = Date.now() + maxMs;

  while (Date.now() < deadline) {
    if (trace.byEvent('match:final_results').length > 0) return;
    if (run.autoClientReadyAcks !== false) {
      await handleBotRejoinAvailableFromTrace(run, playAcks);
      if (trace.byEvent('match:final_results').length > 0) return;
      ackPossessionReadyForNextQuestionFromTrace(trace, [{ userId: run.botUserId }], playAcks);
      await ackResumeUiReadyFromTrace(io, trace, [run.botSocket], playAcks);
    }

    // Answer the latest unanswered question (any kind) so the round resolves.
    const questions = trace.byEvent('match:question');
    let latest = questions[questions.length - 1]?.payload as QuestionEventPayload | undefined;
    if (latest && !answered.has(latest.qIndex) && !skip.has(latest.qIndex)) {
      let ranChaos = false;
      for (let i = 0; i < (opts.chaosPlan?.actions.length ?? 0); i += 1) {
        const action = opts.chaosPlan!.actions[i]!;
        if (executedChaos.has(i) || action.atQIndex !== latest.qIndex) continue;
        executedChaos.add(i);
        await executeChaosAction(run, action);
        ranChaos = true;
        if (trace.byEvent('match:final_results').length > 0) return;
      }
      if (ranChaos) {
        const refreshedQuestions = trace.byEvent('match:question');
        const refreshed = refreshedQuestions[refreshedQuestions.length - 1]?.payload as QuestionEventPayload | undefined;
        if (refreshed?.qIndex === latest.qIndex) latest = refreshed;
      }
      answered.add(latest.qIndex);
      const plan = opts.answerPlan?.[latest.qIndex];
      if (typeof plan?.emitRevealAckAtMs === 'number') {
        await waitMs(msUntilQuestionOffset(latest, plan.emitRevealAckAtMs));
        trace.record('client->server', 'match:question_revealed', {
          matchId: latest.matchId,
          qIndex: latest.qIndex,
          userId: run.botUserId,
        }, run.botSocket.id);
        await matchRealtimeService.handleQuestionRevealed(run.botSocket as never, {
          matchId: latest.matchId,
          qIndex: latest.qIndex,
        });
      }
      const wait = typeof plan?.answerAtMs === 'number'
        ? msUntilQuestionOffset(latest, plan.answerAtMs)
        : (() => {
            const untilPlayable = msUntilPlayable(latest);
            return untilPlayable > 0 ? untilPlayable + 5 : 0;
          })();
      await waitMs(wait);
      try {
        trace.record('client->server', 'match:answer', {
          matchId: latest.matchId,
          qIndex: latest.qIndex,
          userId: run.botUserId,
          questionKind: latest.question?.kind ?? null,
          timeMs: plan?.timeMs ?? 300,
        }, run.botSocket.id);
        await answerQuestion(io, run.botSocket, latest, plan?.mode ?? answerMode, plan?.timeMs);
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
  const playAcks = createBotClientAckState();
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

    if (run.variant === 'friendly_possession') {
      ackPossessionReadyForNextQuestionFromTrace(
        trace,
        seats.map((seat) => ({ userId: seat.userId })),
        playAcks,
      );
    } else if (run.matchId) {
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
  run.trace.record('client->server', 'match:disconnect', {
    matchId: run.matchId,
    userId: run.botUserId,
    socketId: run.botSocket.id,
    connectedAt: run.botSocket.data.connectedAt ?? null,
  }, run.botSocket.id);
  await handleMatchDisconnect(run.io as never, run.botSocket as never);
}

export async function flap(run: RunMatchResult, n: number): Promise<void> {
  const count = Math.max(1, Math.floor(n));
  for (let i = 0; i < count; i += 1) {
    await botDisconnect(run);
    if (run.trace.byEvent('match:final_results').length > 0) return;
    await waitMs(5);
    await botReconnect(run);
    if (run.trace.byEvent('match:final_results').length > 0) return;
    await waitMs(5);
  }
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

export async function expireGraceAfterDisconnect(run: RunMatchResult): Promise<void> {
  await botDisconnect(run);
  await expireGrace(run);
}

/**
 * The bot reconnects: drop the old fake socket, make a NEW one for the same user,
 * run connect hydration + rejoin (the real reconnect path).
 */
export async function botReconnect(run: RunMatchResult): Promise<void> {
  const oldSocket = run.botSocket;
  const oldConnectedAt = typeof oldSocket.data.connectedAt === 'number' ? oldSocket.data.connectedAt : Date.now();
  run.lastSupersededSocket = { id: oldSocket.id, connectedAt: oldConnectedAt };
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
  if (run.trace.byEvent('match:final_results').length > 0) return;
  if (run.matchId) {
    run.trace.record('client->server', 'match:rejoin', {
      matchId: run.matchId,
      userId: run.botUserId,
      socketId: fresh.id,
      supersededSocketId: oldSocket.id,
    }, fresh.id);
    await handleMatchRejoin(run.io as never, fresh as never, run.matchId);
    if (run.trace.byEvent('match:final_results').length > 0) return;
    if (run.autoClientReadyAcks !== false) {
      run.trace.record('client->server', 'match:resume_ui_ready', {
        matchId: run.matchId,
        userId: run.botUserId,
      }, fresh.id);
      await matchRealtimeService.handleResumeUiReady(run.io as never, fresh as never, { matchId: run.matchId });
    }
    // Rejoin schedules a resume countdown (collapsed under fast-timers) that emits
    // match:resume + re-dispatches the question. Wait for it so play can continue.
    // THROW if it never fires — "resume never happened" was a real bug, so this
    // helper must fail loudly rather than silently continue on a stuck match.
    const before = run.trace.byEvent('match:resume').length;
    const resumeAcks = createBotClientAckState();
    const resumed = await waitUntil(
      () => run.trace.byEvent('match:resume').length > before || run.trace.byEvent('match:final_results').length > 0,
      8_000,
      25,
      run.autoClientReadyAcks !== false
        ? () => ackResumeUiReadyFromTrace(run.io, run.trace, [fresh], resumeAcks)
        : undefined,
    );
    if (run.trace.byEvent('match:final_results').length > 0) return;
    if (!resumed) {
      throw new Error('botReconnect: match:resume never fired after rejoin (resume stuck).');
    }
  }
}

async function recordQuestionPresence(run: RunMatchResult): Promise<void> {
  if (!run.matchId) return;
  run.trace.record('client->server', 'match:presence_heartbeat', {
    matchId: run.matchId,
    userId: run.botUserId,
    stageKey: 'question',
    socketId: run.botSocket.id,
  }, run.botSocket.id);
  await recordMatchStagePresenceHeartbeat({
    matchId: run.matchId,
    userId: run.botUserId,
    stageKey: 'question',
    socketId: run.botSocket.id,
  });
}

export async function staleDisconnect(run: RunMatchResult): Promise<void> {
  if (!run.matchId) return;
  const now = Date.now();
  const oldConnectedAt = run.lastSupersededSocket?.connectedAt ?? now - 12_000;
  run.botSocket.data.connectedAt = Math.max(oldConnectedAt + 1, now - 6_000);
  await recordQuestionPresence(run);
  run.trace.record('client->server', 'match:stale_disconnect', {
    matchId: run.matchId,
    userId: run.botUserId,
    staleSocketId: run.lastSupersededSocket?.id ?? 'old-superseded-id',
    liveSocketId: run.botSocket.id,
    disconnectedConnectedAt: oldConnectedAt,
  }, run.botSocket.id);
  const before = run.trace.byEvent('match:resume').length;
  await pauseMatchForDisconnectedPlayer(run.io as never, run.matchId, run.botUserId, {
    ignoreSocketId: run.lastSupersededSocket?.id ?? 'old-superseded-id',
    disconnectedConnectedAt: oldConnectedAt,
    autoResumeReplacementSocket: true,
  });
  const resumeAcks = createBotClientAckState();
  await waitUntil(
    () => run.trace.byEvent('match:resume').length > before,
    1_000,
    25,
    run.autoClientReadyAcks !== false
      ? async () => {
          await handleBotRejoinAvailableFromTrace(run, resumeAcks);
          await ackResumeUiReadyFromTrace(run.io, run.trace, [run.botSocket], resumeAcks);
        }
      : undefined,
  );
  await recordQuestionPresence(run);
}

export async function quitRejoin(run: RunMatchResult): Promise<void> {
  if (!run.matchId) return;
  run.trace.record('client->server', 'match:leave', {
    matchId: run.matchId,
    userId: run.botUserId,
    socketId: run.botSocket.id,
  }, run.botSocket.id);
  await matchRealtimeService.handleMatchLeave(run.io as never, run.botSocket as never, run.matchId);
  run.trace.record('client->server', 'match:rejoin', {
    matchId: run.matchId,
    userId: run.botUserId,
    socketId: run.botSocket.id,
  }, run.botSocket.id);
  await handleMatchRejoin(run.io as never, run.botSocket as never, run.matchId);
  if (run.autoClientReadyAcks !== false) {
    run.trace.record('client->server', 'match:resume_ui_ready', {
      matchId: run.matchId,
      userId: run.botUserId,
    }, run.botSocket.id);
    await matchRealtimeService.handleResumeUiReady(run.io as never, run.botSocket as never, { matchId: run.matchId });
  }
  const before = run.trace.byEvent('match:resume').length;
  const resumeAcks = createBotClientAckState();
  await waitUntil(
    () => run.trace.byEvent('match:resume').length > before || run.trace.byEvent('match:final_results').length > 0,
    8_000,
    25,
    run.autoClientReadyAcks !== false
      ? async () => {
          await handleBotRejoinAvailableFromTrace(run, resumeAcks);
          await ackResumeUiReadyFromTrace(run.io, run.trace, [run.botSocket], resumeAcks);
        }
      : undefined,
  );
}

export async function multiTab(run: RunMatchResult): Promise<void> {
  if (!run.matchId) return;
  const first = run.botSocket;
  const second = run.io.createSocket(`bot-socket-tab-${Date.now()}`, {
    user: { id: run.botUserId },
    // Newer than the socket being killed: the engine only accepts a REPLACEMENT
    // (connectedAt >= dying socket's) as presence proof. An OLDER live tab is
    // rejected by that rule — a real engine gap, tracked in CHAOS-FINDINGS.md.
    connectedAt: Date.now(),
    matchId: run.matchId,
  });
  second.join(`user:${run.botUserId}`);
  run.trace.record('client->server', 'match:rejoin', {
    matchId: run.matchId,
    userId: run.botUserId,
    socketId: second.id,
    source: 'multiTab',
  }, second.id);
  await handleMatchRejoin(run.io as never, second as never, run.matchId);
  run.botSocket = second;
  await recordQuestionPresence(run);
  run.io.removeSocket(first);
  run.trace.record('client->server', 'match:disconnect', {
    matchId: run.matchId,
    userId: run.botUserId,
    socketId: first.id,
    connectedAt: first.data.connectedAt ?? null,
    source: 'multiTabFirstSocketRemoved',
  }, first.id);
  await handleMatchDisconnect(run.io as never, first as never);
  await recordQuestionPresence(run);
}

export async function zombieReconnect(run: RunMatchResult): Promise<void> {
  if (!run.matchId) return;
  const previousSuppressedThrough = run.suppressedRejoinAvailableThroughSeq ?? -1;
  run.suppressAutoRejoinAvailable = true;
  try {
    const markerBefore = Date.now() - 10_000;
    await botDisconnect(run);
    const zombie = run.io.createSocket(`bot-socket-zombie-${Date.now()}`, {
      user: { id: run.botUserId },
      connectedAt: markerBefore,
    });
    zombie.join(`user:${run.botUserId}`);
    run.trace.record('client->server', 'match:zombie_reconnect', {
      matchId: run.matchId,
      userId: run.botUserId,
      socketId: zombie.id,
      connectedAt: markerBefore,
    }, zombie.id);
    await expireGrace(run);
  } finally {
    run.suppressAutoRejoinAvailable = false;
    run.suppressedRejoinAvailableThroughSeq = Math.max(previousSuppressedThrough, latestTraceSeq(run.trace));
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
  const bootAcks = createBotClientAckState();
  const started = await waitUntil(
    () => trace.byEvent('match:start').length > 0 && trace.byEvent('match:question').length > 0,
    startTimeout,
    25,
    () => ackKickoffUiReadyFromTrace(io, trace, sockets, bootAcks),
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
