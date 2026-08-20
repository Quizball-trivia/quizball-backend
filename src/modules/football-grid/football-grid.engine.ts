import type {
  FootballGridBoardView,
  FootballGridClaimState,
  FootballGridCompletionReason,
  FootballGridResolutionOutcome,
  FootballGridState,
} from './football-grid.types.js';

export const FOOTBALL_GRID_TURN_MS = 20_000;
export const FOOTBALL_GRID_COUNTDOWN_MS = 3_000;
export const FOOTBALL_GRID_HANDOFF_MS = 15_000;
export const FOOTBALL_GRID_READY_MS = 20_000;
export const FOOTBALL_GRID_RECONNECT_MS = 30_000;
export const FOOTBALL_GRID_INITIAL_PAUSE_BUDGET_MS = 60_000;
export const FOOTBALL_GRID_MAX_NO_ACTION_TIMEOUTS = 3;

export const FOOTBALL_GRID_WIN_LINES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export type FootballGridRuleErrorCode =
  | 'INVALID_STATE'
  | 'STALE_STATE'
  | 'NOT_PARTICIPANT'
  | 'NOT_YOUR_TURN'
  | 'CELL_OCCUPIED'
  | 'PLAYER_ALREADY_USED'
  | 'INVALID_CELL';

export class FootballGridRuleError extends Error {
  constructor(public readonly code: FootballGridRuleErrorCode, message: string) {
    super(message);
    this.name = 'FootballGridRuleError';
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cloneState(state: FootballGridState): FootballGridState {
  return {
    ...state,
    players: state.players.map((player) => ({ ...player })) as FootballGridState['players'],
    claims: state.claims.map((claim) => ({ ...claim })),
  };
}

function assertParticipant(state: FootballGridState, userId: string): void {
  if (!state.players.some((player) => player.userId === userId)) {
    throw new FootballGridRuleError('NOT_PARTICIPANT', 'User is not a match participant');
  }
}

function assertExpectedVersion(state: FootballGridState, expectedStateVersion: number): void {
  if (state.stateVersion !== expectedStateVersion) {
    throw new FootballGridRuleError('STALE_STATE', 'Match state version is stale');
  }
}

function assertTurn(state: FootballGridState, userId: string, expectedStateVersion: number): void {
  assertParticipant(state, userId);
  assertExpectedVersion(state, expectedStateVersion);
  if (state.status !== 'active' || state.phase !== 'turn') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match is not accepting turn commands');
  }
  if (state.currentPlayerUserId !== userId) {
    throw new FootballGridRuleError('NOT_YOUR_TURN', 'It is not this player\'s turn');
  }
}

function otherPlayerId(state: FootballGridState, userId: string): string {
  const player = state.players.find((candidate) => candidate.userId !== userId);
  if (!player) throw new FootballGridRuleError('INVALID_STATE', 'Opponent is missing');
  return player.userId;
}

function resetActionTimeouts(state: FootballGridState, userId: string): void {
  const player = state.players.find((candidate) => candidate.userId === userId);
  if (player) player.noActionTimeouts = 0;
}

function advanceTurn(state: FootballGridState, actorUserId: string, nowMs: number): void {
  state.turnNumber += 1;
  state.currentPlayerUserId = otherPlayerId(state, actorUserId);
  state.turnDeadlineAt = iso(nowMs + FOOTBALL_GRID_TURN_MS);
  state.phaseDeadlineAt = state.turnDeadlineAt;
  state.turnRemainingMs = FOOTBALL_GRID_TURN_MS;
  state.stateVersion += 1;
}

function complete(
  state: FootballGridState,
  winnerUserId: string | null,
  reason: FootballGridCompletionReason,
  nowMs: number,
): void {
  state.status = reason === 'forfeit' || reason === 'no_action_timeouts' || reason === 'disconnect_timeout'
    ? 'forfeited'
    : reason === 'loading_no_show' || reason === 'simultaneous_disconnect' || reason === 'administrative_cancel'
      ? 'cancelled'
      : 'completed';
  state.phase = 'terminal';
  state.winnerUserId = winnerUserId;
  state.currentPlayerUserId = null;
  state.phaseDeadlineAt = null;
  state.turnDeadlineAt = null;
  state.reconnectDeadlineAt = null;
  state.turnRemainingMs = null;
  state.pausedAt = null;
  state.pausedFromPhase = null;
  state.completionReason = reason;
  state.stateVersion += 1;
  void nowMs;
}

export function createFootballGridState(input: {
  matchId: string;
  board: FootballGridBoardView;
  players: Array<{ userId: string; seat: 1 | 2; isBot?: boolean }>;
  openerUserId: string;
  nowMs: number;
  wrongAnswerVisibility?: boolean;
}): FootballGridState {
  if (input.players.length !== 2 || new Set(input.players.map((player) => player.userId)).size !== 2) {
    throw new FootballGridRuleError('INVALID_STATE', 'Football Grid requires exactly two unique players');
  }
  if (!input.players.some((player) => player.userId === input.openerUserId)) {
    throw new FootballGridRuleError('INVALID_STATE', 'Opener must be a participant');
  }

  return {
    matchId: input.matchId,
    status: 'handoff',
    phase: 'handoff',
    board: input.board,
    players: [...input.players]
      .sort((a, b) => a.seat - b.seat)
      .map((player) => ({
        userId: player.userId,
        seat: player.seat,
        isBot: player.isBot ?? false,
        handoffAcknowledged: player.isBot ?? false,
        ready: player.isBot ?? false,
        noActionTimeouts: 0,
        pauseBudgetRemainingMs: FOOTBALL_GRID_INITIAL_PAUSE_BUDGET_MS,
      })) as FootballGridState['players'],
    openerUserId: input.openerUserId,
    currentPlayerUserId: null,
    winnerUserId: null,
    turnNumber: 0,
    stateVersion: 0,
    wrongAnswerVisibility: input.wrongAnswerVisibility ?? false,
    claims: [],
    phaseDeadlineAt: iso(input.nowMs + FOOTBALL_GRID_HANDOFF_MS),
    turnDeadlineAt: null,
    turnRemainingMs: null,
    pausedAt: null,
    pausedFromPhase: null,
    reconnectDeadlineAt: null,
    completionReason: null,
  };
}

export function acknowledgeHandoff(
  inputState: FootballGridState,
  userId: string,
  expectedStateVersion: number,
  nowMs: number,
): FootballGridState {
  assertParticipant(inputState, userId);
  assertExpectedVersion(inputState, expectedStateVersion);
  if (inputState.status !== 'handoff') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match is not waiting for handoff acknowledgement');
  }
  const state = cloneState(inputState);
  const player = state.players.find((candidate) => candidate.userId === userId)!;
  if (!player.handoffAcknowledged) {
    player.handoffAcknowledged = true;
    state.stateVersion += 1;
  }
  if (state.players.every((candidate) => candidate.handoffAcknowledged)) {
    state.status = 'loading';
    state.phase = 'loading';
    state.phaseDeadlineAt = iso(nowMs + FOOTBALL_GRID_READY_MS);
    state.stateVersion += 1;
  }
  return state;
}

export function markReady(
  inputState: FootballGridState,
  userId: string,
  expectedStateVersion: number,
  nowMs: number,
): FootballGridState {
  assertParticipant(inputState, userId);
  assertExpectedVersion(inputState, expectedStateVersion);
  if (inputState.status !== 'loading') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match is not waiting for client readiness');
  }
  const state = cloneState(inputState);
  const player = state.players.find((candidate) => candidate.userId === userId)!;
  if (!player.ready) {
    player.ready = true;
    state.stateVersion += 1;
  }
  if (state.players.every((candidate) => candidate.ready)) {
    state.status = 'countdown';
    state.phase = 'countdown';
    state.phaseDeadlineAt = iso(nowMs + FOOTBALL_GRID_COUNTDOWN_MS);
    state.stateVersion += 1;
  }
  return state;
}

export function startTurnAfterCountdown(
  inputState: FootballGridState,
  expectedStateVersion: number,
  nowMs: number,
): FootballGridState {
  assertExpectedVersion(inputState, expectedStateVersion);
  if (inputState.status !== 'countdown' || inputState.phase !== 'countdown') {
    throw new FootballGridRuleError('INVALID_STATE', 'Countdown is not active');
  }
  const state = cloneState(inputState);
  state.status = 'active';
  state.phase = 'turn';
  state.currentPlayerUserId = state.openerUserId;
  state.turnDeadlineAt = iso(nowMs + FOOTBALL_GRID_TURN_MS);
  state.phaseDeadlineAt = state.turnDeadlineAt;
  state.turnRemainingMs = FOOTBALL_GRID_TURN_MS;
  state.stateVersion += 1;
  return state;
}

export function detectWinningUser(claims: FootballGridClaimState[]): string | null {
  const byCell = new Map(claims.map((claim) => [claim.cellIndex, claim.claimantUserId]));
  for (const [a, b, c] of FOOTBALL_GRID_WIN_LINES) {
    const userId = byCell.get(a);
    if (userId && byCell.get(b) === userId && byCell.get(c) === userId) return userId;
  }
  return null;
}

export function applyResolvedAnswer(
  inputState: FootballGridState,
  input: {
    userId: string;
    expectedStateVersion: number;
    cellIndex: number;
    outcome: FootballGridResolutionOutcome;
    footballPlayerId: string | null;
    nowMs: number;
  },
): FootballGridState {
  assertTurn(inputState, input.userId, input.expectedStateVersion);
  if (!Number.isInteger(input.cellIndex) || input.cellIndex < 0 || input.cellIndex > 8) {
    throw new FootballGridRuleError('INVALID_CELL', 'Cell index must be between 0 and 8');
  }
  if (inputState.claims.some((claim) => claim.cellIndex === input.cellIndex)) {
    throw new FootballGridRuleError('CELL_OCCUPIED', 'Cell is already occupied');
  }
  if (
    input.outcome === 'correct'
    && input.footballPlayerId
    && inputState.claims.some((claim) => claim.footballPlayerId === input.footballPlayerId)
  ) {
    throw new FootballGridRuleError('PLAYER_ALREADY_USED', 'Footballer is already used');
  }
  if (input.outcome === 'ambiguous') return cloneState(inputState);

  const state = cloneState(inputState);
  resetActionTimeouts(state, input.userId);
  if (input.outcome === 'correct') {
    if (!input.footballPlayerId) {
      throw new FootballGridRuleError('INVALID_STATE', 'Correct resolution requires a footballer');
    }
    state.claims.push({
      cellIndex: input.cellIndex,
      footballPlayerId: input.footballPlayerId,
      claimantUserId: input.userId,
      turnNumber: state.turnNumber,
    });
    const winner = detectWinningUser(state.claims);
    if (winner) {
      complete(state, winner, 'line', input.nowMs);
      return state;
    }
    if (state.claims.length === 9) {
      complete(state, null, 'board_full', input.nowMs);
      return state;
    }
  }
  advanceTurn(state, input.userId, input.nowMs);
  return state;
}

export function passTurn(
  inputState: FootballGridState,
  userId: string,
  expectedStateVersion: number,
  nowMs: number,
): FootballGridState {
  assertTurn(inputState, userId, expectedStateVersion);
  const state = cloneState(inputState);
  resetActionTimeouts(state, userId);
  advanceTurn(state, userId, nowMs);
  return state;
}

export function expireTurn(
  inputState: FootballGridState,
  expectedStateVersion: number,
  nowMs: number,
  options?: { hadActivity?: boolean },
): FootballGridState {
  assertExpectedVersion(inputState, expectedStateVersion);
  if (inputState.status !== 'active' || inputState.phase !== 'turn' || !inputState.currentPlayerUserId) {
    throw new FootballGridRuleError('INVALID_STATE', 'Turn cannot expire in the current state');
  }
  const state = cloneState(inputState);
  const actor = state.players.find((player) => player.userId === state.currentPlayerUserId)!;
  actor.noActionTimeouts = options?.hadActivity ? 0 : actor.noActionTimeouts + 1;
  if (actor.noActionTimeouts >= FOOTBALL_GRID_MAX_NO_ACTION_TIMEOUTS) {
    complete(state, otherPlayerId(state, actor.userId), 'no_action_timeouts', nowMs);
    return state;
  }
  advanceTurn(state, actor.userId, nowMs);
  return state;
}

export function pauseForDisconnect(
  inputState: FootballGridState,
  nowMs: number,
  reconnectDeadlineAtMs: number,
): FootballGridState {
  if (inputState.status !== 'active' && inputState.status !== 'countdown') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match cannot pause in the current state');
  }
  const state = cloneState(inputState);
  const turnDeadlineMs = Date.parse(state.phaseDeadlineAt ?? state.turnDeadlineAt ?? '');
  state.turnRemainingMs = Number.isFinite(turnDeadlineMs)
    ? Math.max(0, turnDeadlineMs - nowMs)
    : state.turnRemainingMs;
  state.status = 'paused';
  state.phase = 'paused';
  state.pausedFromPhase = inputState.phase === 'countdown' ? 'countdown' : 'turn';
  state.pausedAt = iso(nowMs);
  state.reconnectDeadlineAt = iso(reconnectDeadlineAtMs);
  state.phaseDeadlineAt = state.reconnectDeadlineAt;
  state.turnDeadlineAt = null;
  state.stateVersion += 1;
  return state;
}

export function shortenDisconnectPause(
  inputState: FootballGridState,
  reconnectDeadlineAtMs: number,
): FootballGridState {
  if (inputState.status !== 'paused' || inputState.phase !== 'paused') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match is not paused for disconnect');
  }
  const state = cloneState(inputState);
  const currentDeadlineMs = Date.parse(state.reconnectDeadlineAt ?? '');
  const nextDeadlineMs = Number.isFinite(currentDeadlineMs)
    ? Math.min(currentDeadlineMs, reconnectDeadlineAtMs)
    : reconnectDeadlineAtMs;
  if (nextDeadlineMs !== currentDeadlineMs) {
    state.reconnectDeadlineAt = iso(nextDeadlineMs);
    state.phaseDeadlineAt = state.reconnectDeadlineAt;
    state.stateVersion += 1;
  }
  return state;
}

export function resumeAfterReconnect(inputState: FootballGridState, nowMs: number): FootballGridState {
  if (inputState.status !== 'paused') {
    throw new FootballGridRuleError('INVALID_STATE', 'Match is not paused');
  }
  const state = cloneState(inputState);
  const remainingMs = Math.max(1, state.turnRemainingMs ?? FOOTBALL_GRID_TURN_MS);
  if (state.pausedFromPhase === 'countdown') {
    state.status = 'countdown';
    state.phase = 'countdown';
    state.turnDeadlineAt = null;
    state.phaseDeadlineAt = iso(nowMs + remainingMs);
  } else {
    state.status = 'active';
    state.phase = 'turn';
    state.turnDeadlineAt = iso(nowMs + remainingMs);
    state.phaseDeadlineAt = state.turnDeadlineAt;
  }
  state.reconnectDeadlineAt = null;
  state.pausedAt = null;
  state.pausedFromPhase = null;
  state.stateVersion += 1;
  return state;
}

export function forfeitMatch(
  inputState: FootballGridState,
  forfeitingUserId: string,
  reason: 'forfeit' | 'disconnect_timeout',
  nowMs: number,
): FootballGridState {
  assertParticipant(inputState, forfeitingUserId);
  if (inputState.phase === 'terminal') return cloneState(inputState);
  const state = cloneState(inputState);
  complete(state, otherPlayerId(state, forfeitingUserId), reason, nowMs);
  return state;
}

export function cancelNoContest(
  inputState: FootballGridState,
  reason: 'loading_no_show' | 'simultaneous_disconnect' | 'administrative_cancel',
  nowMs: number,
): FootballGridState {
  if (inputState.phase === 'terminal') return cloneState(inputState);
  const state = cloneState(inputState);
  complete(state, null, reason, nowMs);
  return state;
}

export function sanitizeFootballGridState(state: FootballGridState): FootballGridState {
  return cloneState(state);
}
