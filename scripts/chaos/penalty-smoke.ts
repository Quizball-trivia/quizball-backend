/* eslint-disable no-console */
// Staging smoke test for the penalty shootout against an ephemeral bot.
//
// One real (non-guest) chaos user boots `dev:quick_match { skipTo: 'penalties' }`
// N times and plays every kick with a deliberately varied strategy so that some
// shootouts end level (draw) and others are decided. Every kick records the
// human's answer ack, the bot's `match:opponent_answered` broadcast, the
// round result and the shootout outcome; every completion records the final
// results + ranked settlement. The assertions cover the #687 behaviour:
//
//   - the bot's `match:opponent_answered` arrives BEFORE `match:round_result`;
//   - `match:answer_ack` carries opponentPointsEarned/opponentIsCorrect whenever
//     oppAnswered is true;
//   - penalty outcome: (shooter correct && keeper wrong) || shooterPts > keeperPts
//     is a goal, EQUAL points is a save;
//   - bot answer times are human-like (0.6–9 s) and not all identical;
//   - a level shootout after 5 + POSSESSION_MAX_SUDDEN_DEATH_ROUNDS kicks each
//     completes as a draw (+10 RP / 475 coins), a decided one via
//     'penalty_goals', and no shootout exceeds 2 * (5 + N) kicks.
//
// Usage (worktree cwd, staging only — production is hard-blocked):
//   CHAOS_BYPASS_TOKEN=... POSSESSION_MAX_SUDDEN_DEATH_ROUNDS=3 \
//   npx tsx scripts/chaos/penalty-smoke.ts --matches=8 \
//     --env-file=/path/to/backend-node/.env \
//     --wait-deploy-commit=<sha> --railway-cwd=/path/to/linked/backend-node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { provisionUsers } from './auth.js';
import { autoHalftime, autoRecover } from '../../game-regression/staging/bot-behaviors.mjs';
import { clearActiveMatch, connectStaging, type StagingClient } from '../../game-regression/staging/staging-client.mjs';

// ---------------------------------------------------------------------------
// Args / env
// ---------------------------------------------------------------------------

type Strategy = 'level' | 'correct' | 'wrong' | 'random';
const STRATEGY_ROTATION: Strategy[] = ['level', 'correct', 'wrong', 'random'];

interface Args {
  matches: number;
  api: string;
  envFile: string;
  offset: number;
  suddenDeathRounds: number;
  waitDeployCommit?: string;
  waitDeployMaxMin: number;
  railwayCwd: string;
  report?: string;
  matchTimeoutMs: number;
  strategies: Strategy[];
}

function value(argv: string[], key: string): string | undefined {
  const exact = argv.indexOf(`--${key}`);
  if (exact >= 0) return argv[exact + 1]?.startsWith('--') ? undefined : argv[exact + 1];
  const prefix = `--${key}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function integer(argv: string[], key: string, fallback: number, minimum: number): number {
  const parsed = Number(value(argv, key) ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`--${key} must be an integer >= ${minimum}.`);
  return parsed;
}

function readEnv(path: string): Record<string, string> {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[2]!;
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
    out[match[1]!] = raw;
  }
  return out;
}

function parseArgs(argv: string[]): Args {
  const strategiesRaw = value(argv, 'strategies');
  const strategies = strategiesRaw
    ? strategiesRaw.split(',').map((s) => s.trim()).filter(Boolean) as Strategy[]
    : STRATEGY_ROTATION;
  for (const s of strategies) {
    if (!STRATEGY_ROTATION.includes(s)) throw new Error(`Unknown strategy "${s}". Valid: ${STRATEGY_ROTATION.join(',')}`);
  }
  const envSudden = process.env.POSSESSION_MAX_SUDDEN_DEATH_ROUNDS;
  return {
    matches: integer(argv, 'matches', 8, 1),
    api: value(argv, 'api') ?? 'https://api-staging.quizball.io',
    envFile: value(argv, 'env-file') ?? resolve(process.cwd(), '.env'),
    offset: integer(argv, 'offset', 0, 0),
    suddenDeathRounds: integer(argv, 'sudden-death-rounds', envSudden ? Number(envSudden) : 0, 0),
    waitDeployCommit: value(argv, 'wait-deploy-commit'),
    waitDeployMaxMin: integer(argv, 'wait-deploy-max-min', 15, 1),
    railwayCwd: value(argv, 'railway-cwd') ?? process.cwd(),
    report: value(argv, 'report'),
    matchTimeoutMs: integer(argv, 'match-timeout-s', 420, 30) * 1_000,
    strategies,
  };
}

function assertSafeTarget(apiBase: string, supabaseUrl: string): void {
  if (apiBase.includes('api.quizball.io') || supabaseUrl.includes('lfbwhxvwubzeqkztghok')) {
    throw new Error('PROD GUARD: penalty smoke resolved to production.');
  }
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(apiBase);
  if (!local && !apiBase.startsWith('https://api-staging.quizball.io')) {
    throw new Error(`PROD GUARD: only api-staging.quizball.io or localhost are allowed, got "${apiBase}".`);
  }
}

// ---------------------------------------------------------------------------
// Deploy readiness
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(apiBase: string, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiBase}/health`, { signal: AbortSignal.timeout(5_000) });
      const body = await res.json().catch(() => null) as { ok?: boolean } | null;
      if (res.ok && body?.ok) return;
    } catch {
      // retry
    }
    await sleep(3_000);
  }
  throw new Error(`${apiBase}/health did not report ok within ${Math.round(maxMs / 1000)}s`);
}

interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string;
  meta?: { commitHash?: string; commitMessage?: string };
}

function listStagingDeployments(cwd: string): RailwayDeployment[] {
  const raw = execFileSync('railway', ['deployment', 'list', '--environment', 'staging', '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const parsed = JSON.parse(raw) as RailwayDeployment[] | { deployments?: RailwayDeployment[] };
  const list = Array.isArray(parsed) ? parsed : parsed.deployments ?? [];
  return [...list].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function waitForDeploy(commit: string, cwd: string, maxMin: number): Promise<RailwayDeployment> {
  const deadline = Date.now() + maxMin * 60_000;
  const wanted = commit.toLowerCase();
  let last: RailwayDeployment | undefined;
  while (Date.now() < deadline) {
    const deployments = listStagingDeployments(cwd);
    last = deployments[0];
    const target = deployments.find((d) => (d.meta?.commitHash ?? '').toLowerCase().startsWith(wanted));
    if (target && target.status === 'SUCCESS' && deployments[0]?.id === target.id) return target;
    if (target && (target.status === 'FAILED' || target.status === 'CRASHED')) {
      throw new Error(`staging deployment ${target.id} for ${commit} is ${target.status}`);
    }
    console.log(`  deploy wait: newest=${last?.status ?? 'none'} ${(last?.meta?.commitHash ?? '').slice(0, 10)} target=${target?.status ?? 'not listed'}`);
    await sleep(20_000);
  }
  throw new Error(`staging did not reach SUCCESS for commit ${commit} within ${maxMin} min (newest: ${last?.status} ${last?.meta?.commitHash?.slice(0, 10)})`);
}

// ---------------------------------------------------------------------------
// Match recording
// ---------------------------------------------------------------------------

type Seat = 1 | 2;

interface KickRecord {
  qIndex: number;
  phaseRound: number | null;
  shooterSeat: Seat | null;
  role: 'shooter' | 'keeper' | 'unknown';
  strategy: Strategy;
  plan: { selectedIndex: number | null; intent: 'correct' | 'wrong' | 'random'; delayMs: number };
  questionAtMs: number;
  playableAtMs: number | null;
  me: {
    selectedIndex: number | null;
    isCorrect: boolean | null;
    pointsEarned: number | null;
    ackTimeMs: number | null; // wall-clock from playable to ack
    timeMs: number | null; // server-authoritative, from round_result
    ackOppAnswered: boolean | null;
    ackOpponentPointsEarned: number | null | undefined;
    ackOpponentIsCorrect: boolean | null | undefined;
    ackOpponentTotalPoints: number | null | undefined;
  };
  bot: {
    oppAnsweredSeen: boolean;
    oppAnsweredBeforeRoundResult: boolean | null;
    oppAnsweredAtMs: number | null; // wall-clock from playable to event
    pointsEarned: number | null;
    isCorrect: boolean | null;
    selectedIndex: number | null;
    timeMs: number | null; // server-authoritative, from round_result
    rrPointsEarned: number | null;
    rrIsCorrect: boolean | null;
  };
  roundResultAtMs: number | null;
  penaltyOutcome: 'goal' | 'saved' | null;
  goalScoredBySeat: Seat | null;
  scoreAfter: { seat1: number; seat2: number } | null;
}

interface FinalRecord {
  matchId: string;
  winnerId: string | null;
  winnerDecisionMethod: string | null;
  isDraw: boolean;
  totalPointsFallbackUsed: boolean;
  penaltyGoals: Record<string, number | undefined>;
  myRanked: { result?: string; deltaRp?: number; coinsAwarded?: number; oldRp?: number; newRp?: number } | null;
  botRanked: { result?: string; deltaRp?: number; coinsAwarded?: number } | null;
  resultVersion: number | null;
  durationMs: number | null;
}

interface MatchRecord {
  index: number;
  strategy: Strategy;
  matchId: string | null;
  mySeat: Seat | null;
  botUserId: string | null;
  kicks: KickRecord[];
  final: FinalRecord | null;
  errors: string[];
  startedAt: string;
  finishedAt: string | null;
  failure: string | null;
}

interface Assertion {
  id: string;
  match: number;
  qIndex?: number;
  ok: boolean;
  detail: string;
  raw?: unknown;
}

type QuestionPayload = {
  matchId: string;
  qIndex: number;
  question?: { kind?: string; options?: unknown[] };
  playableAt?: string;
  deadlineAt?: string;
  correctIndex?: number;
  phaseKind?: string;
  phaseRound?: number | null;
  shooterSeat?: Seat | null;
};

type AnswerAck = {
  matchId: string;
  qIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex?: number;
  pointsEarned: number;
  myTotalPoints: number;
  oppAnswered: boolean;
  opponentPointsEarned?: number;
  opponentTotalPoints?: number;
  opponentIsCorrect?: boolean;
  opponentSelectedIndex?: number | null;
  phaseKind?: string;
  shooterSeat?: Seat | null;
};

type OpponentAnswered = {
  matchId: string;
  qIndex: number;
  pointsEarned: number;
  isCorrect: boolean;
  selectedIndex: number | null;
  opponentTotalPoints: number;
};

type RoundResult = {
  matchId: string;
  qIndex: number;
  phaseKind?: string;
  phaseRound?: number | null;
  shooterSeat?: Seat | null;
  players: Record<string, { selectedIndex: number | null; isCorrect: boolean; timeMs: number; pointsEarned: number; totalPoints: number }>;
  deltas?: { penaltyOutcome: 'goal' | 'saved' | null; goalScoredBySeat: Seat | null };
};

type FinalResults = {
  matchId: string;
  winnerId: string | null;
  winnerDecisionMethod?: string | null;
  isDraw?: boolean;
  totalPointsFallbackUsed?: boolean;
  players: Record<string, { totalPoints: number; penaltyGoals?: number; goals?: number }>;
  rankedOutcome?: { byUserId: Record<string, { result?: string; deltaRp: number; coinsAwarded?: number; oldRp: number; newRp: number }> } | null;
  resultVersion: number;
  durationMs: number;
};

const randomBetween = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

function planAnswer(
  strategy: Strategy,
  q: QuestionPayload,
  role: 'shooter' | 'keeper' | 'unknown',
  score: { mine: number; bot: number },
): KickRecord['plan'] {
  const optionCount = Math.max(2, q.question?.options?.length ?? 4);
  const correct = typeof q.correctIndex === 'number' ? q.correctIndex : 0;
  const wrongIndex = () => {
    const candidates = Array.from({ length: optionCount }, (_, i) => i).filter((i) => i !== correct);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? (correct === 0 ? 1 : 0);
  };
  // A real player reads for a bit: 1–4 s. "Fast" intents sit at the low end of
  // that window so the tie-breaking-by-points stays meaningful.
  const slow = () => randomBetween(1_000, 4_000);
  const fast = () => randomBetween(1_000, 1_600);
  switch (strategy) {
    case 'correct':
      return { selectedIndex: correct, intent: 'correct', delayMs: slow() };
    case 'wrong':
      return { selectedIndex: wrongIndex(), intent: 'wrong', delayMs: slow() };
    case 'random': {
      const idx = Math.floor(Math.random() * optionCount);
      return { selectedIndex: idx, intent: 'random', delayMs: slow() };
    }
    case 'level':
    default: {
      // Seek a level shootout. Shooter: score (fast, correct) only when behind,
      // otherwise miss on purpose. Keeper: let the bot score (answer wrong) when
      // we are ahead, otherwise try to save (fast, correct).
      if (role === 'shooter') {
        if (score.mine < score.bot) return { selectedIndex: correct, intent: 'correct', delayMs: fast() };
        return { selectedIndex: wrongIndex(), intent: 'wrong', delayMs: slow() };
      }
      if (role === 'keeper') {
        if (score.mine > score.bot) return { selectedIndex: wrongIndex(), intent: 'wrong', delayMs: slow() };
        return { selectedIndex: correct, intent: 'correct', delayMs: fast() };
      }
      return { selectedIndex: correct, intent: 'correct', delayMs: slow() };
    }
  }
}

async function playMatch(
  client: StagingClient,
  index: number,
  strategy: Strategy,
  timeoutMs: number,
): Promise<MatchRecord> {
  const rec: MatchRecord = {
    index,
    strategy,
    matchId: null,
    mySeat: null,
    botUserId: null,
    kicks: [],
    final: null,
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    failure: null,
  };
  const me = client.userId;
  const kicksByQ = new Map<number, KickRecord>();
  const answered = new Set<number>();
  const revealed = new Set<number>();
  let score = { seat1: 0, seat2: 0 };
  const myScore = () => (rec.mySeat === 1 ? score.seat1 : score.seat2);
  const botScore = () => (rec.mySeat === 1 ? score.seat2 : score.seat1);
  let timers: NodeJS.Timeout[] = [];

  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => { resolveDone = r; });

  const isMine = (p: { matchId?: string } | undefined) => Boolean(p?.matchId && rec.matchId && p.matchId === rec.matchId);

  const onStart = (p: { matchId: string; mySeat?: number; opponent?: { id?: string }; participants?: Array<{ userId?: string; id?: string }> }) => {
    if (rec.matchId && p.matchId !== rec.matchId) return;
    rec.matchId = p.matchId;
    rec.mySeat = p.mySeat === 1 || p.mySeat === 2 ? p.mySeat : null;
    rec.botUserId = p.opponent?.id ?? null;
  };

  const onQuestion = (q: QuestionPayload) => {
    if (!rec.matchId) rec.matchId = q.matchId;
    if (!isMine(q)) return;
    if (kicksByQ.has(q.qIndex)) return;
    const now = Date.now();
    const playableAtMs = q.playableAt ? new Date(q.playableAt).getTime() : null;
    const role: KickRecord['role'] = q.shooterSeat && rec.mySeat
      ? (q.shooterSeat === rec.mySeat ? 'shooter' : 'keeper')
      : 'unknown';
    const plan = planAnswer(strategy, q, role, { mine: myScore(), bot: botScore() });
    const kick: KickRecord = {
      qIndex: q.qIndex,
      phaseRound: q.phaseRound ?? null,
      shooterSeat: q.shooterSeat ?? null,
      role,
      strategy,
      plan,
      questionAtMs: now,
      playableAtMs,
      me: {
        selectedIndex: null, isCorrect: null, pointsEarned: null, ackTimeMs: null, timeMs: null,
        ackOppAnswered: null, ackOpponentPointsEarned: undefined, ackOpponentIsCorrect: undefined, ackOpponentTotalPoints: undefined,
      },
      bot: {
        oppAnsweredSeen: false, oppAnsweredBeforeRoundResult: null, oppAnsweredAtMs: null,
        pointsEarned: null, isCorrect: null, selectedIndex: null, timeMs: null, rrPointsEarned: null, rrIsCorrect: null,
      },
      roundResultAtMs: null,
      penaltyOutcome: null,
      goalScoredBySeat: null,
      scoreAfter: null,
    };
    kicksByQ.set(q.qIndex, kick);
    rec.kicks.push(kick);
    if (q.phaseKind !== 'penalty') rec.errors.push(`q${q.qIndex} phaseKind=${q.phaseKind ?? 'undefined'} (expected penalty)`);

    const waitMs = playableAtMs ? Math.max(0, playableAtMs - now) : 0;
    // Reveal ack like the web client: the question is on screen at playableAt.
    timers.push(setTimeout(() => {
      if (revealed.has(q.qIndex)) return;
      revealed.add(q.qIndex);
      client.socket.emit('match:question_revealed', { matchId: q.matchId, qIndex: q.qIndex });
    }, waitMs + 30));
    timers.push(setTimeout(() => {
      if (answered.has(q.qIndex)) return;
      answered.add(q.qIndex);
      client.socket.emit('match:answer', {
        matchId: q.matchId,
        qIndex: q.qIndex,
        selectedIndex: plan.selectedIndex,
        timeMs: plan.delayMs,
      });
    }, waitMs + 30 + plan.delayMs));
  };

  const onAck = (ack: AnswerAck) => {
    if (!isMine(ack)) return;
    const kick = kicksByQ.get(ack.qIndex);
    if (!kick) return;
    kick.me.selectedIndex = ack.selectedIndex;
    kick.me.isCorrect = ack.isCorrect;
    kick.me.pointsEarned = ack.pointsEarned;
    kick.me.ackTimeMs = Date.now() - (kick.playableAtMs ?? kick.questionAtMs);
    kick.me.ackOppAnswered = ack.oppAnswered;
    kick.me.ackOpponentPointsEarned = ack.opponentPointsEarned;
    kick.me.ackOpponentIsCorrect = ack.opponentIsCorrect;
    kick.me.ackOpponentTotalPoints = ack.opponentTotalPoints;
  };

  const onOpponentAnswered = (p: OpponentAnswered) => {
    if (!isMine(p)) return;
    const kick = kicksByQ.get(p.qIndex);
    if (!kick) return;
    kick.bot.oppAnsweredSeen = true;
    kick.bot.oppAnsweredAtMs = Date.now() - (kick.playableAtMs ?? kick.questionAtMs);
    kick.bot.oppAnsweredBeforeRoundResult = kick.roundResultAtMs === null;
    kick.bot.pointsEarned = p.pointsEarned;
    kick.bot.isCorrect = p.isCorrect;
    kick.bot.selectedIndex = p.selectedIndex;
  };

  const onRoundResult = (r: RoundResult) => {
    if (!isMine(r)) return;
    const kick = kicksByQ.get(r.qIndex);
    if (kick) {
      kick.roundResultAtMs = Date.now();
      if (kick.bot.oppAnsweredBeforeRoundResult === null) kick.bot.oppAnsweredBeforeRoundResult = false;
      kick.penaltyOutcome = r.deltas?.penaltyOutcome ?? null;
      kick.goalScoredBySeat = r.deltas?.goalScoredBySeat ?? null;
      const mine = r.players[me];
      if (mine) {
        kick.me.timeMs = mine.timeMs;
        if (kick.me.isCorrect === null) {
          kick.me.isCorrect = mine.isCorrect;
          kick.me.pointsEarned = mine.pointsEarned;
          kick.me.selectedIndex = mine.selectedIndex;
        }
      }
      const botId = rec.botUserId ?? Object.keys(r.players).find((id) => id !== me) ?? null;
      if (botId) {
        rec.botUserId ??= botId;
        const bot = r.players[botId];
        if (bot) {
          kick.bot.timeMs = bot.timeMs;
          kick.bot.rrPointsEarned = bot.pointsEarned;
          kick.bot.rrIsCorrect = bot.isCorrect;
          if (kick.bot.selectedIndex === null) kick.bot.selectedIndex = bot.selectedIndex;
        }
      }
      if (kick.goalScoredBySeat === 1) score = { ...score, seat1: score.seat1 + 1 };
      if (kick.goalScoredBySeat === 2) score = { ...score, seat2: score.seat2 + 1 };
      kick.scoreAfter = { ...score };
    }
    client.socket.emit('match:ready_for_next_question', { matchId: r.matchId, qIndex: r.qIndex });
  };

  const onFinal = (f: FinalResults) => {
    if (!isMine(f)) return;
    const botId = rec.botUserId ?? Object.keys(f.players).find((id) => id !== me) ?? null;
    const penaltyGoals: Record<string, number | undefined> = {};
    for (const [id, p] of Object.entries(f.players)) penaltyGoals[id === me ? 'me' : 'bot'] = p.penaltyGoals;
    rec.final = {
      matchId: f.matchId,
      winnerId: f.winnerId,
      winnerDecisionMethod: f.winnerDecisionMethod ?? null,
      isDraw: f.isDraw === true,
      totalPointsFallbackUsed: f.totalPointsFallbackUsed === true,
      penaltyGoals,
      myRanked: f.rankedOutcome?.byUserId[me] ?? null,
      botRanked: botId ? f.rankedOutcome?.byUserId[botId] ?? null : null,
      resultVersion: f.resultVersion ?? null,
      durationMs: f.durationMs ?? null,
    };
    client.socket.emit('match:final_results_ack', { matchId: f.matchId, resultVersion: f.resultVersion });
    resolveDone('final');
  };

  const onError = (e: { code?: string; message?: string } | undefined) => {
    const line = `error ${e?.code ?? '?'}: ${e?.message ?? ''}`;
    rec.errors.push(line);
    if (e?.code === 'DEV_ERROR' || e?.code === 'CAPABILITY_REQUIRED' || e?.code === 'CONNECT_ERROR') resolveDone(line);
  };
  const onBlocked = (p: { reason?: string; message?: string } | undefined) => {
    const line = `session:blocked ${p?.reason ?? '?'}: ${p?.message ?? ''}`;
    rec.errors.push(line);
    resolveDone(line);
  };

  client.socket.on('match:start', onStart);
  client.socket.on('match:question', onQuestion);
  client.socket.on('match:answer_ack', onAck);
  client.socket.on('match:opponent_answered', onOpponentAnswered);
  client.socket.on('match:round_result', onRoundResult);
  client.socket.on('match:final_results', onFinal);
  client.socket.on('error', onError);
  client.socket.on('session:blocked', onBlocked);

  const timeout = setTimeout(() => resolveDone('timeout'), timeoutMs);
  try {
    client.socket.emit('dev:quick_match', { skipTo: 'penalties' });
    const reason = await done;
    if (reason !== 'final') rec.failure = reason;
  } finally {
    clearTimeout(timeout);
    for (const t of timers) clearTimeout(t);
    timers = [];
    client.socket.off('match:start', onStart);
    client.socket.off('match:question', onQuestion);
    client.socket.off('match:answer_ack', onAck);
    client.socket.off('match:opponent_answered', onOpponentAnswered);
    client.socket.off('match:round_result', onRoundResult);
    client.socket.off('match:final_results', onFinal);
    client.socket.off('error', onError);
    client.socket.off('session:blocked', onBlocked);
    rec.finishedAt = new Date().toISOString();
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function evaluate(matches: MatchRecord[], suddenDeathRounds: number, meUserId: string): Assertion[] {
  const out: Assertion[] = [];
  const push = (a: Assertion) => out.push(a);
  const maxKicksEach = 5 + suddenDeathRounds;
  const maxKicksTotal = 2 * maxKicksEach;

  for (const m of matches) {
    const n = m.index;
    if (m.failure) {
      push({ id: 'match.completed', match: n, ok: false, detail: `match did not complete: ${m.failure}`, raw: { errors: m.errors, kicks: m.kicks.length } });
      continue;
    }
    push({ id: 'match.completed', match: n, ok: true, detail: `${m.kicks.length} kicks, ${m.final?.winnerDecisionMethod}` });

    for (const k of m.kicks) {
      const shooterIsMe = k.role === 'shooter';
      const shooter = shooterIsMe
        ? { correct: k.me.isCorrect, points: k.me.pointsEarned }
        : { correct: k.bot.rrIsCorrect ?? k.bot.isCorrect, points: k.bot.rrPointsEarned ?? k.bot.pointsEarned };
      const keeper = shooterIsMe
        ? { correct: k.bot.rrIsCorrect ?? k.bot.isCorrect, points: k.bot.rrPointsEarned ?? k.bot.pointsEarned }
        : { correct: k.me.isCorrect, points: k.me.pointsEarned };
      const raw = {
        qIndex: k.qIndex, role: k.role, shooterSeat: k.shooterSeat, plan: k.plan, me: k.me, bot: k.bot,
        penaltyOutcome: k.penaltyOutcome, goalScoredBySeat: k.goalScoredBySeat,
      };

      // 1. bot's opponent_answered arrives before round_result
      push({
        id: 'kick.opp_answered_before_round_result', match: n, qIndex: k.qIndex,
        ok: k.bot.oppAnsweredSeen && k.bot.oppAnsweredBeforeRoundResult === true,
        detail: k.bot.oppAnsweredSeen
          ? `opponent_answered at +${k.bot.oppAnsweredAtMs}ms, round_result at +${k.roundResultAtMs !== null ? k.roundResultAtMs - (k.playableAtMs ?? k.questionAtMs) : '?'}ms`
          : 'no match:opponent_answered received for this kick',
        raw,
      });

      // 2. ack carries opponent fields when oppAnswered
      if (k.me.ackOppAnswered === true) {
        const ok = typeof k.me.ackOpponentPointsEarned === 'number' && typeof k.me.ackOpponentIsCorrect === 'boolean';
        const consistent = !ok || k.bot.rrPointsEarned === null
          || (k.me.ackOpponentPointsEarned === k.bot.rrPointsEarned && k.me.ackOpponentIsCorrect === k.bot.rrIsCorrect);
        push({
          id: 'kick.ack_opponent_fields', match: n, qIndex: k.qIndex, ok: ok && consistent,
          detail: `oppAnswered=true opponentPointsEarned=${String(k.me.ackOpponentPointsEarned)} opponentIsCorrect=${String(k.me.ackOpponentIsCorrect)} (round_result bot pts=${k.bot.rrPointsEarned} correct=${k.bot.rrIsCorrect})`,
          raw,
        });
      } else if (k.me.ackOppAnswered === false) {
        // Bot answered after us: opponent_answered must still arrive before round_result (asserted above).
        push({ id: 'kick.ack_opponent_fields', match: n, qIndex: k.qIndex, ok: true, detail: 'oppAnswered=false (bot answered after us) — n/a' });
      }

      // 3. outcome rule
      if (shooter.correct !== null && keeper.correct !== null && shooter.points !== null && keeper.points !== null && k.penaltyOutcome) {
        const expected = ((shooter.correct && !keeper.correct) || (shooter.points > keeper.points)) ? 'goal' : 'saved';
        const equalCorrect = shooter.correct && keeper.correct && shooter.points === keeper.points;
        const shooterOnly = shooter.correct && !keeper.correct;
        const tag = equalCorrect ? 'both-correct-equal-points' : shooterOnly ? 'shooter-correct-keeper-wrong' : 'general';
        push({
          id: `kick.outcome.${tag}`, match: n, qIndex: k.qIndex, ok: k.penaltyOutcome === expected,
          detail: `shooter(${shooterIsMe ? 'me' : 'bot'}) correct=${shooter.correct} pts=${shooter.points} keeper correct=${keeper.correct} pts=${keeper.points} → ${k.penaltyOutcome} (expected ${expected})`,
          raw,
        });
      } else {
        push({ id: 'kick.outcome.general', match: n, qIndex: k.qIndex, ok: false, detail: 'incomplete kick data', raw });
      }

      // 4. bot answer time range
      const botTime = k.bot.timeMs;
      push({
        id: 'kick.bot_time_range', match: n, qIndex: k.qIndex,
        ok: botTime !== null && botTime >= 600 && botTime <= 9_000,
        detail: `bot timeMs=${botTime} (wall-clock opponent_answered +${k.bot.oppAnsweredAtMs}ms)`,
        raw,
      });
    }

    // Completion
    const f = m.final!;
    const kicksMe = m.kicks.filter((k) => k.role === 'shooter').length;
    const kicksBot = m.kicks.filter((k) => k.role === 'keeper').length;
    const last = m.kicks[m.kicks.length - 1]?.scoreAfter ?? { seat1: 0, seat2: 0 };
    const myGoals = m.mySeat === 1 ? last.seat1 : last.seat2;
    const botGoals = m.mySeat === 1 ? last.seat2 : last.seat1;
    const level = myGoals === botGoals;
    const rawFinal = { final: f, kicks: m.kicks.length, kicksMe, kicksBot, myGoals, botGoals, mySeat: m.mySeat };

    push({
      id: 'final.max_kicks', match: n, ok: m.kicks.length <= maxKicksTotal && kicksMe <= maxKicksEach && kicksBot <= maxKicksEach,
      detail: `${m.kicks.length} kicks (me ${kicksMe}, bot ${kicksBot}) ≤ ${maxKicksTotal} (5+${suddenDeathRounds} each)`, raw: rawFinal,
    });
    if (level) {
      const okDraw = f.winnerDecisionMethod === 'draw' && f.isDraw && f.winnerId === null;
      push({ id: 'final.draw.method', match: n, ok: okDraw, detail: `level ${myGoals}-${botGoals}: winnerDecisionMethod=${f.winnerDecisionMethod} isDraw=${f.isDraw} winnerId=${f.winnerId}`, raw: rawFinal });
      push({ id: 'final.draw.kicks', match: n, ok: kicksMe === maxKicksEach && kicksBot === maxKicksEach, detail: `draw after ${kicksMe}/${kicksBot} kicks (expected ${maxKicksEach} each)`, raw: rawFinal });
      const r = f.myRanked;
      push({
        id: 'final.draw.ranked', match: n,
        ok: r?.result === 'draw' && r?.deltaRp === 10 && r?.coinsAwarded === 475,
        detail: `my ranked: result=${r?.result} deltaRp=${r?.deltaRp} coins=${r?.coinsAwarded} (expected draw/+10/475)`, raw: rawFinal,
      });
    } else {
      const expectedWinner = myGoals > botGoals ? 'me' : 'bot';
      const winnerIsMe = f.winnerId !== null && f.winnerId === meUserId;
      push({
        id: 'final.decided.method', match: n,
        ok: f.winnerDecisionMethod === 'penalty_goals' && f.winnerId !== null && !f.isDraw && (expectedWinner === 'me') === winnerIsMe,
        detail: `decided ${myGoals}-${botGoals}: winnerDecisionMethod=${f.winnerDecisionMethod} winnerId=${f.winnerId} (${winnerIsMe ? 'me' : 'bot'}, expected ${expectedWinner}) isDraw=${f.isDraw}`, raw: rawFinal,
      });
      const r = f.myRanked;
      const expectedResult = expectedWinner === 'me' ? 'win' : 'loss';
      const expectedCoins = expectedWinner === 'me' ? 700 : 250;
      push({
        id: 'final.decided.ranked', match: n,
        ok: r?.result === expectedResult && r?.coinsAwarded === expectedCoins && (expectedWinner === 'me' ? (r?.deltaRp ?? 0) > 0 : (r?.deltaRp ?? 0) <= 0),
        detail: `my ranked: result=${r?.result} deltaRp=${r?.deltaRp} coins=${r?.coinsAwarded} (expected ${expectedResult}/${expectedCoins})`, raw: rawFinal,
      });
    }
    push({ id: 'final.penalty_goals_match_kicks', match: n, ok: f.penaltyGoals.me === myGoals && f.penaltyGoals.bot === botGoals, detail: `final penaltyGoals me=${f.penaltyGoals.me} bot=${f.penaltyGoals.bot} vs tracked ${myGoals}-${botGoals}`, raw: rawFinal });
  }

  // Bot times not all identical (across the run)
  const botTimes = matches.flatMap((m) => m.kicks.map((k) => k.bot.timeMs)).filter((t): t is number => t !== null);
  const distinct = new Set(botTimes);
  push({ id: 'run.bot_times_vary', match: 0, ok: botTimes.length > 1 && distinct.size > 1, detail: `${botTimes.length} bot answer times, ${distinct.size} distinct: ${[...botTimes].sort((a, b) => a - b).slice(0, 5).join(',')}…${[...botTimes].sort((a, b) => a - b).slice(-3).join(',')}` });
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(s: string | number, w: number): string {
  const str = String(s);
  return str.length >= w ? str : str + ' '.repeat(w - str.length);
}

function renderMatch(m: MatchRecord): string {
  const lines: string[] = [];
  lines.push(`Match ${m.index} strategy=${m.strategy} matchId=${m.matchId ?? '-'} mySeat=${m.mySeat ?? '-'} bot=${m.botUserId ?? '-'}${m.failure ? ` FAILURE=${m.failure}` : ''}`);
  lines.push(`  ${pad('q', 4)}${pad('rnd', 4)}${pad('shooter', 8)}${pad('intent', 8)}${pad('me c/pts/ms', 16)}${pad('ack opp(pts,c)', 20)}${pad('bot c/pts/ms', 16)}${pad('oppAns<rr', 10)}${pad('outcome', 8)}score`);
  for (const k of m.kicks) {
    const role = k.role === 'shooter' ? 'me' : k.role === 'keeper' ? 'bot' : '?';
    const meCell = `${k.me.isCorrect === null ? '?' : k.me.isCorrect ? 'Y' : 'N'}/${k.me.pointsEarned ?? '?'}/${k.me.timeMs ?? '?'}`;
    const ackCell = k.me.ackOppAnswered === null ? '?' : k.me.ackOppAnswered
      ? `true(${String(k.me.ackOpponentPointsEarned)},${String(k.me.ackOpponentIsCorrect)})`
      : 'false';
    const botCell = `${k.bot.rrIsCorrect === null ? '?' : k.bot.rrIsCorrect ? 'Y' : 'N'}/${k.bot.rrPointsEarned ?? '?'}/${k.bot.timeMs ?? '?'}`;
    const oppCell = k.bot.oppAnsweredSeen ? (k.bot.oppAnsweredBeforeRoundResult ? `yes +${k.bot.oppAnsweredAtMs}` : 'NO (after)') : 'MISSING';
    const sc = k.scoreAfter ? (m.mySeat === 1 ? `${k.scoreAfter.seat1}-${k.scoreAfter.seat2}` : `${k.scoreAfter.seat2}-${k.scoreAfter.seat1}`) : '?';
    lines.push(`  ${pad(k.qIndex, 4)}${pad(k.phaseRound ?? '-', 4)}${pad(role, 8)}${pad(k.plan.intent, 8)}${pad(meCell, 16)}${pad(ackCell, 20)}${pad(botCell, 16)}${pad(oppCell, 10)}${pad(k.penaltyOutcome ?? '?', 8)}${sc}`);
  }
  if (m.final) {
    const r = m.final.myRanked;
    lines.push(`  final: winnerId=${m.final.winnerId ?? 'null'} method=${m.final.winnerDecisionMethod} isDraw=${m.final.isDraw} penaltyGoals me=${m.final.penaltyGoals.me} bot=${m.final.penaltyGoals.bot} ranked(me)=${r ? `${r.result} ${(r.deltaRp ?? 0) >= 0 ? '+' : ''}${r.deltaRp}rp ${r.coinsAwarded}c (${r.oldRp}→${r.newRp})` : 'none'}`);
  }
  if (m.errors.length) lines.push(`  errors: ${m.errors.join(' | ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: tsx scripts/chaos/penalty-smoke.ts [--matches=8] [--env-file=.env] [--sudden-death-rounds=N] [--wait-deploy-commit=sha --railway-cwd=dir] [--strategies=level,correct,wrong,random]');
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const env = readEnv(args.envFile);
  const supabaseUrl = process.env.SUPABASE_URL ?? env.SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const bypassToken = process.env.CHAOS_BYPASS_TOKEN ?? env.CHAOS_BYPASS_TOKEN;
  assertSafeTarget(args.api, supabaseUrl);
  const staging = args.api.startsWith('https://api-staging.quizball.io');
  if (staging && !supabaseUrl.includes('nsdfiprfmhdqhbfxfwpv')) throw new Error('PROD GUARD: staging run requires the staging Supabase URL.');
  if (staging && !bypassToken) throw new Error('CHAOS_BYPASS_TOKEN is required on staging.');
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (env or --env-file).');

  console.log('═'.repeat(72));
  console.log('PENALTY SHOOTOUT vs BOT — STAGING SMOKE (PRODUCTION BLOCKED)');
  console.log(`api=${args.api} matches=${args.matches} suddenDeathRounds=${args.suddenDeathRounds} (max ${2 * (5 + args.suddenDeathRounds)} kicks) strategies=${args.strategies.join(',')}`);
  console.log('═'.repeat(72));

  if (args.waitDeployCommit) {
    console.log(`Waiting for staging deployment of ${args.waitDeployCommit} (max ${args.waitDeployMaxMin} min)…`);
    const dep = await waitForDeploy(args.waitDeployCommit, args.railwayCwd, args.waitDeployMaxMin);
    console.log(`  deployment ${dep.id} ${dep.status} ${dep.meta?.commitHash?.slice(0, 10)} "${(dep.meta?.commitMessage ?? '').split('\n')[0]}"`);
  }
  await waitForHealth(args.api, 2 * 60_000);
  console.log('  /health ok');

  const [user] = await provisionUsers({
    apiBase: args.api,
    supabaseUrl,
    serviceRoleKey,
    count: 1,
    startIndex: args.offset,
    password: 'ChaosTest12345!',
    emailPrefix: 'penalty',
    emailDomain: staging ? 'quizball.io' : 'example.com',
    concurrency: 1,
    loginIntervalMs: 0,
    bypassToken,
  });
  if (!user) throw new Error('user provisioning returned nothing');
  console.log(`user ${user.email} id=${user.userId}`);

  const client = connectStaging(args.api, user.token, user.userId);
  const connected = await new Promise<boolean>((r) => {
    if (client.socket.connected) return r(true);
    const t = setTimeout(() => r(false), 20_000);
    client.socket.once('connect', () => { clearTimeout(t); r(true); });
  });
  if (!connected) throw new Error('socket did not connect');
  autoRecover(client);
  autoHalftime(client);
  const cleared = await clearActiveMatch(client);
  if (cleared) console.log(`  cleared stale active match ${cleared}`);

  const matches: MatchRecord[] = [];
  for (let i = 1; i <= args.matches; i += 1) {
    const strategy = args.strategies[(i - 1) % args.strategies.length]!;
    console.log(`\n▶ match ${i}/${args.matches} strategy=${strategy}`);
    const rec = await playMatch(client, i, strategy, args.matchTimeoutMs);
    matches.push(rec);
    console.log(renderMatch(rec));
    if (rec.failure) {
      // Self-heal so the next dev:quick_match is not blocked by an active match.
      try { await clearActiveMatch(client); } catch (e) { console.log(`  cleanup failed: ${(e as Error).message}`); }
    }
    await sleep(2_500);
  }
  client.disconnect();

  const assertions = evaluate(matches, args.suddenDeathRounds, user.userId);
  const failures = assertions.filter((a) => !a.ok);
  const byId = new Map<string, { pass: number; fail: number }>();
  for (const a of assertions) {
    const e = byId.get(a.id) ?? { pass: 0, fail: 0 };
    if (a.ok) e.pass += 1; else e.fail += 1;
    byId.set(a.id, e);
  }
  console.log('\n' + '═'.repeat(72));
  console.log('ASSERTIONS');
  for (const [id, e] of [...byId.entries()].sort()) console.log(`  ${e.fail === 0 ? 'PASS' : 'FAIL'} ${pad(id, 44)} pass=${e.pass} fail=${e.fail}`);
  if (failures.length) {
    console.log('\nFAILURES (raw):');
    for (const f of failures) {
      console.log(`  [${f.id}] match=${f.match}${f.qIndex !== undefined ? ` q=${f.qIndex}` : ''}: ${f.detail}`);
      if (f.raw !== undefined) console.log(`    ${JSON.stringify(f.raw)}`);
    }
  }
  const draws = matches.filter((m) => m.final?.isDraw).length;
  const decided = matches.filter((m) => m.final && !m.final.isDraw).length;
  console.log(`\ndraws=${draws} decided=${decided} incomplete=${matches.filter((m) => m.failure).length} (at least one draw: ${draws > 0 ? 'yes' : 'NO'})`);
  console.log(`VERDICT: ${failures.length === 0 && draws > 0 ? 'PASS' : 'FAIL'} (${failures.length} failed assertions)`);

  const report = { schemaVersion: 1, api: args.api, config: args, user: { email: user.email, userId: user.userId }, matches, assertions, draws, decided };
  const defaultPath = resolve(process.cwd(), 'scripts/chaos/reports', `penalty-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const reportPath = args.report ? (isAbsolute(args.report) ? args.report : resolve(process.cwd(), args.report)) : defaultPath;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Full JSON report: ${reportPath}`);
  if (failures.length > 0 || draws === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
