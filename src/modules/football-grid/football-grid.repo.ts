import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  FootballGridAliasRecord,
  FootballGridBoardView,
  FootballGridCriterionView,
  FootballGridOrigin,
  FootballGridState,
} from './football-grid.types.js';
import {
  FOOTBALL_GRID_HANDOFF_MS,
  FOOTBALL_GRID_INITIAL_PAUSE_BUDGET_MS,
  FOOTBALL_GRID_SERVICE_INTERRUPTION_MS,
} from './football-grid.engine.js';
import { footballGridBotGovernorService } from './football-grid-bot-governor.service.js';
import { parseFootballGridBotStrengthAdjustment } from './football-grid-bot-governor.js';

type SqlExecutor = Pick<typeof sql, 'unsafe'> | Pick<TransactionSql, 'unsafe'>;

interface GridMatchRow {
  match_id: string;
  board_id: string;
  content_release_id: string;
  alias_release_id: string;
  resolver_policy_version: number;
  board_checksum: string;
  status: FootballGridState['status'];
  phase: FootballGridState['phase'];
  opener_user_id: string;
  current_player_user_id: string | null;
  winner_user_id: string | null;
  turn_number: number;
  state_version: number;
  last_event_sequence: string | number;
  pending_command_id: string | null;
  wrong_answer_visibility: boolean;
  phase_deadline_at: string | null;
  turn_deadline_at: string | null;
  turn_remaining_ms: number | null;
  paused_at: string | null;
  paused_from_phase: 'countdown' | 'turn' | null;
  reconnect_deadline_at: string | null;
  completion_reason: FootballGridState['completionReason'];
  database_now?: string;
}

interface GridParticipantRow {
  user_id: string;
  seat: 1 | 2;
  is_bot: boolean;
  handoff_ack_at: string | null;
  ready_at: string | null;
  no_action_timeout_count: number;
  pause_budget_remaining_ms: number;
}

interface GridClaimRow {
  cell_index: number;
  football_player_id: string;
  display_name: string;
  image_url: string | null;
  claimant_user_id: string;
  turn_number: number;
}

interface GridRelatedStateRow {
  participants: GridParticipantRow[];
  claims: GridClaimRow[];
}

interface GridBoardRow {
  id: string;
  version: number;
  release_id: string;
  row_criteria: string[];
  column_criteria: string[];
  canonical_checksum: string;
}

interface GridCriterionRow {
  id: string;
  criterion_key: string;
  family: FootballGridCriterionView['family'];
  label_en: string;
  label_ka: string;
  asset_key: string | null;
  difficulty: FootballGridCriterionView['difficulty'];
}

export interface FootballGridCommandInboxRow {
  id: string;
  match_id: string;
  actor_user_id: string;
  command_id: string;
  expected_state_version: number;
  turn_number: number;
  command_type: 'answer' | 'pass' | 'forfeit';
  cell_index: number | null;
  locale: 'en' | 'ka' | null;
  submitted_text: string | null;
  payload_hash: string;
  admitted_at: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  processing_fence: string | null;
  processing_lease_until: string | null;
  retry_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  result_code: string | null;
  result_payload: Record<string, unknown> | null;
}

interface GridCommandAdmissionResultRow {
  inbox: FootballGridCommandInboxRow | null;
  error_code: string | null;
}

export interface FootballGridResultDeliveryRow {
  match_id: string;
  user_id: string;
  terminal_state_version: number;
  attempt_count: number;
  ack_token: string;
}

export interface FootballGridCompletionAnalyticsFacts {
  matchId: string;
  origin: FootballGridOrigin;
  winnerUserId: string | null;
  completionReason: string;
  startedAt: string;
  endedAt: string;
  boardId: string;
  boardVersion: number;
  boardDifficulty: 'easy' | 'normal' | 'hard';
  turns: number;
  participants: Array<{
    userId: string;
    isBot: boolean;
    claimCount: number;
    correctAnswers: number;
    wrongAnswers: number;
    ambiguousAnswers: number;
    alreadyUsedAnswers: number;
    passes: number;
    noActionTimeouts: number;
    averageResponseMs: number | null;
  }>;
}

export interface FootballGridCuratedSampleCandidate {
  cellIndex: number;
  playerId: string;
  name: string;
  imageAssetKey: string | null;
}

export interface FootballGridCuratedCellSamples {
  cellIndex: number;
  players: Array<{
    playerId: string;
    name: string;
    imageUrl: null;
    imageAssetKey: string | null;
  }>;
}

/**
 * Select result examples across the whole board instead of independently per
 * cell. A recognizable player that qualifies for several intersections is
 * shown once while distinct alternatives exist, which makes the result screen
 * demonstrate the breadth of accepted answers instead of repeating one star.
 */
export function selectDiverseFootballGridSamples(
  candidates: FootballGridCuratedSampleCandidate[],
  maxPerCell = 5,
): FootballGridCuratedCellSamples[] {
  const byCell = new Map<number, FootballGridCuratedSampleCandidate[]>();
  for (const candidate of candidates) {
    const current = byCell.get(candidate.cellIndex) ?? [];
    if (!current.some((entry) => entry.playerId === candidate.playerId)) current.push(candidate);
    byCell.set(candidate.cellIndex, current);
  }

  const cellIndexes = [...byCell.keys()].sort((left, right) => left - right);
  const selectedByCell = new Map<number, FootballGridCuratedSampleCandidate[]>();
  const usedAcrossBoard = new Set<string>();

  for (let sampleIndex = 0; sampleIndex < maxPerCell; sampleIndex += 1) {
    for (const cellIndex of cellIndexes) {
      const selected = selectedByCell.get(cellIndex) ?? [];
      const selectedIds = new Set(selected.map((candidate) => candidate.playerId));
      const available = (byCell.get(cellIndex) ?? []).filter((candidate) => !selectedIds.has(candidate.playerId));
      const next = available.find((candidate) => !usedAcrossBoard.has(candidate.playerId)) ?? available[0];
      if (!next) continue;
      selected.push(next);
      selectedByCell.set(cellIndex, selected);
      usedAcrossBoard.add(next.playerId);
    }
  }

  return cellIndexes.map((cellIndex) => ({
    cellIndex,
    players: (selectedByCell.get(cellIndex) ?? []).map((candidate) => ({
      playerId: candidate.playerId,
      name: candidate.name,
      imageUrl: null,
      imageAssetKey: candidate.imageAssetKey,
    })),
  }));
}

function toCriterionView(row: GridCriterionRow): FootballGridCriterionView {
  return {
    id: row.id,
    key: row.criterion_key,
    family: row.family,
    labelEn: row.label_en,
    labelKa: row.label_ka,
    assetKey: row.asset_key,
    difficulty: row.difficulty,
  };
}

const BOARD_VIEW_CACHE_TTL_MS = 60 * 60_000;
const BOARD_VIEW_CACHE_MAX_ENTRIES = 1_024;
const boardViewCache = new Map<string, {
  expiresAt: number;
  value: Promise<FootballGridBoardView>;
}>();

function trimBoardViewCache(): void {
  while (boardViewCache.size > BOARD_VIEW_CACHE_MAX_ENTRIES) {
    const oldestKey = boardViewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    boardViewCache.delete(oldestKey);
  }
}

async function loadBoardUncached(executor: SqlExecutor, boardId: string): Promise<FootballGridBoardView> {
  const boards = await executor.unsafe<GridBoardRow[]>(
    `SELECT id, version, release_id, row_criteria, column_criteria, canonical_checksum
       FROM football_grid_boards
      WHERE id = $1`,
    [boardId],
  );
  const board = boards[0];
  if (!board) throw new Error(`Football Grid board not found: ${boardId}`);
  const criterionIds = [...board.row_criteria, ...board.column_criteria];
  const criteria = await executor.unsafe<GridCriterionRow[]>(
    `SELECT id, criterion_key, family, label_en, label_ka, asset_key, difficulty
       FROM football_grid_criteria
      WHERE id = ANY($1::uuid[])`,
    [criterionIds],
  );
  const byId = new Map(criteria.map((criterion) => [criterion.id, toCriterionView(criterion)]));
  const get = (id: string): FootballGridCriterionView => {
    const criterion = byId.get(id);
    if (!criterion) throw new Error(`Football Grid criterion not found: ${id}`);
    return criterion;
  };
  return {
    boardId: board.id,
    boardVersion: board.version,
    checksum: board.canonical_checksum,
    rows: board.row_criteria.map(get) as FootballGridBoardView['rows'],
    columns: board.column_criteria.map(get) as FootballGridBoardView['columns'],
  };
}

async function loadBoard(executor: SqlExecutor, boardId: string): Promise<FootballGridBoardView> {
  const now = Date.now();
  const cached = boardViewCache.get(boardId);
  if (cached && cached.expiresAt > now) {
    boardViewCache.delete(boardId);
    boardViewCache.set(boardId, cached);
    return cached.value;
  }
  if (cached) boardViewCache.delete(boardId);
  const entry = {
    expiresAt: now + BOARD_VIEW_CACHE_TTL_MS,
    value: loadBoardUncached(executor, boardId),
  };
  boardViewCache.set(boardId, entry);
  trimBoardViewCache();
  try {
    return await entry.value;
  } catch (error) {
    if (boardViewCache.get(boardId) === entry) boardViewCache.delete(boardId);
    throw error;
  }
}

interface LoadedGridState {
  state: FootballGridState;
  databaseNowMs: number;
}

async function loadStateRecordWithExecutor(
  executor: SqlExecutor,
  matchId: string,
  lock: boolean,
): Promise<LoadedGridState | null> {
  const matches = await executor.unsafe<GridMatchRow[]>(
    `SELECT *, clock_timestamp() AS database_now
       FROM football_grid_matches
      WHERE match_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [matchId],
  );
  const match = matches[0];
  if (!match) return null;
  const databaseNowMs = Date.parse(match.database_now ?? '');
  if (!Number.isFinite(databaseNowMs)) throw new Error('Football Grid database clock is unavailable');
  const [related, board] = await Promise.all([
    executor.unsafe<GridRelatedStateRow[]>(
      `SELECT
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'user_id', p.user_id,
             'seat', p.seat,
             'is_bot', p.is_bot,
             'handoff_ack_at', p.handoff_ack_at,
             'ready_at', p.ready_at,
             'no_action_timeout_count', p.no_action_timeout_count,
             'pause_budget_remaining_ms', p.pause_budget_remaining_ms
           ) ORDER BY p.seat)
             FROM football_grid_participants p
            WHERE p.match_id = $1
         ), '[]'::jsonb) AS participants,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'cell_index', c.cell_index,
             'football_player_id', c.football_player_id,
             'display_name', fp.name,
             'image_url', fp.image_url,
             'claimant_user_id', c.claimant_user_id,
             'turn_number', c.turn_number
           ) ORDER BY c.created_at, c.cell_index)
             FROM football_grid_claims c
             JOIN football_players fp ON fp.id = c.football_player_id
            WHERE c.match_id = $1
         ), '[]'::jsonb) AS claims`,
      [matchId],
    ),
    loadBoard(executor, match.board_id),
  ]);
  const participants = related[0]?.participants ?? [];
  const claims = related[0]?.claims ?? [];
  if (participants.length !== 2) throw new Error(`Football Grid match ${matchId} has invalid roster`);
  const state: FootballGridState = {
    matchId,
    status: match.status,
    phase: match.phase,
    board,
    players: participants.map((participant) => ({
      userId: participant.user_id,
      seat: participant.seat,
      isBot: participant.is_bot,
      handoffAcknowledged: participant.handoff_ack_at !== null,
      ready: participant.ready_at !== null,
      noActionTimeouts: participant.no_action_timeout_count,
      pauseBudgetRemainingMs: participant.pause_budget_remaining_ms,
    })) as FootballGridState['players'],
    openerUserId: match.opener_user_id,
    currentPlayerUserId: match.current_player_user_id,
    winnerUserId: match.winner_user_id,
    turnNumber: match.turn_number,
    stateVersion: match.state_version,
    wrongAnswerVisibility: match.wrong_answer_visibility,
    claims: claims.map((claim) => ({
      cellIndex: claim.cell_index,
      footballPlayerId: claim.football_player_id,
      displayName: claim.display_name,
      imageUrl: claim.image_url,
      claimantUserId: claim.claimant_user_id,
      turnNumber: claim.turn_number,
    })),
    phaseDeadlineAt: match.phase_deadline_at,
    turnDeadlineAt: match.turn_deadline_at,
    turnRemainingMs: match.turn_remaining_ms,
    pausedAt: match.paused_at,
    pausedFromPhase: match.paused_from_phase,
    reconnectDeadlineAt: match.reconnect_deadline_at,
    completionReason: match.completion_reason,
  };
  return { state, databaseNowMs };
}

async function loadStateWithExecutor(
  executor: SqlExecutor,
  matchId: string,
  lock: boolean,
): Promise<FootballGridState | null> {
  return (await loadStateRecordWithExecutor(executor, matchId, lock))?.state ?? null;
}

async function insertEvent(
  tx: TransactionSql,
  input: {
    matchId: string;
    eventSequence: number;
    stateVersion: number;
    eventType: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.unsafe(
    `INSERT INTO football_grid_events (
       match_id, event_sequence, state_version, event_type, payload
     ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.matchId,
      input.eventSequence,
      input.stateVersion,
      input.eventType,
      sql.json((input.payload ?? {}) as Json),
    ],
  );
}

function parseEventSequence(value: string | number): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Football Grid event sequence is outside the safe integer range');
  }
  return sequence;
}

async function pauseMatchForFailedCommandInTx(
  tx: TransactionSql,
  matchId: string,
  commandInboxId: string,
): Promise<void> {
  const updated = await tx.unsafe<Array<{ state_version: number; last_event_sequence: string | number }>>(
    `UPDATE football_grid_matches
        SET status = 'paused', phase = 'service_interruption',
            turn_remaining_ms = CASE
              WHEN turn_deadline_at IS NULL THEN turn_remaining_ms
              ELSE greatest(0, extract(epoch FROM (turn_deadline_at - clock_timestamp())) * 1000)::int
            END,
            turn_deadline_at = null,
            phase_deadline_at = now() + make_interval(secs => $3 / 1000.0),
            bot_action_deadline_at = null, pending_command_id = null,
            updated_at = now(), state_version = state_version + 1,
            last_event_sequence = last_event_sequence + 1
      WHERE match_id = $1 AND pending_command_id = $2
        AND phase <> 'terminal'
      RETURNING state_version, last_event_sequence`,
    [matchId, commandInboxId, FOOTBALL_GRID_SERVICE_INTERRUPTION_MS],
  );
  const row = updated[0];
  if (!row) {
    await tx.unsafe(
      `UPDATE football_grid_matches SET pending_command_id = null
        WHERE match_id = $1 AND pending_command_id = $2 AND phase = 'terminal'`,
      [matchId, commandInboxId],
    );
    return;
  }
  await insertEvent(tx, {
    matchId,
    eventSequence: parseEventSequence(row.last_event_sequence),
    stateVersion: row.state_version,
    eventType: 'service_interruption',
    payload: { commandInboxId },
  });
}

export const footballGridRepo = {
  runInTransaction<T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(callback) as Promise<T>;
  },

  async loadState(matchId: string): Promise<FootballGridState | null> {
    return loadStateWithExecutor(sql, matchId, false);
  },

  async loadStateForUpdate(tx: TransactionSql, matchId: string): Promise<FootballGridState | null> {
    return loadStateWithExecutor(tx, matchId, true);
  },

  async loadStateForUpdateAtDatabaseTime(
    tx: TransactionSql,
    matchId: string,
  ): Promise<LoadedGridState | null> {
    return loadStateRecordWithExecutor(tx, matchId, true);
  },

  async getMatchPhase(matchId: string): Promise<FootballGridState['phase'] | null> {
    const rows = await sql<Array<{ phase: FootballGridState['phase'] }>>`
      SELECT phase FROM football_grid_matches WHERE match_id = ${matchId}
    `;
    return rows[0]?.phase ?? null;
  },

  async getClaimedPlayerIds(matchId: string): Promise<string[]> {
    const rows = await sql<Array<{ football_player_id: string }>>`
      SELECT football_player_id
        FROM football_grid_claims
       WHERE match_id = ${matchId}
    `;
    return rows.map((row) => row.football_player_id);
  },

  async databaseNowMs(tx: TransactionSql): Promise<number> {
    const rows = await tx.unsafe<Array<{ now_ms: string }>>(
      `SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms`,
    );
    return Number(rows[0].now_ms);
  },

  async getPendingCommandIdInTx(tx: TransactionSql, matchId: string): Promise<string | null> {
    const rows = await tx.unsafe<Array<{ pending_command_id: string | null }>>(
      `SELECT pending_command_id FROM football_grid_matches WHERE match_id = $1 FOR UPDATE`,
      [matchId],
    );
    return rows[0]?.pending_command_id ?? null;
  },

  async hasTurnActivityInTx(
    tx: TransactionSql,
    matchId: string,
    actorUserId: string,
    turnNumber: number,
  ): Promise<boolean> {
    const rows = await tx.unsafe<Array<{ found: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM football_grid_attempts
          WHERE match_id = $1 AND actor_user_id = $2 AND turn_number = $3
            AND outcome = 'ambiguous'
       ) AS found`,
      [matchId, actorUserId, turnNumber],
    );
    return rows[0]?.found === true;
  },

  async getActiveMatchIdForUser(userId: string): Promise<string | null> {
    const rows = await sql<Array<{ match_id: string }>>`
      SELECT p.match_id
        FROM football_grid_participants p
        JOIN football_grid_matches gm ON gm.match_id = p.match_id
       WHERE p.user_id = ${userId}
         AND gm.status NOT IN ('completed', 'forfeited', 'cancelled')
       ORDER BY gm.created_at DESC
       LIMIT 1
    `;
    return rows[0]?.match_id ?? null;
  },

  async recordRewardRiskObservation(input: {
    matchId: string;
    userId: string;
    deviceHash: string | null;
    networkHash: string | null;
    source: string;
  }): Promise<void> {
    if (!input.deviceHash && !input.networkHash) return;
    await sql`
      INSERT INTO football_grid_reward_risk_observations (
        match_id, user_id, device_hash, network_hash, source
      ) VALUES (
        ${input.matchId}, ${input.userId}, ${input.deviceHash}, ${input.networkHash}, ${input.source}
      )
      ON CONFLICT (match_id, user_id) DO UPDATE
        SET device_hash = COALESCE(football_grid_reward_risk_observations.device_hash, EXCLUDED.device_hash),
            network_hash = COALESCE(football_grid_reward_risk_observations.network_hash, EXCLUDED.network_hash),
            source = EXCLUDED.source, observed_at = now()
    `;
  },

  async listNonterminalMatchIds(limit = 500, afterMatchId: string | null = null): Promise<string[]> {
    const rows = await sql.unsafe<Array<{ match_id: string }>>(
      `SELECT match_id FROM football_grid_matches
        WHERE phase <> 'terminal'
          AND ($2::uuid IS NULL OR match_id > $2::uuid)
        ORDER BY match_id
        LIMIT $1`,
      [limit, afterMatchId],
    );
    return rows.map((row) => row.match_id);
  },

  async listDuePhaseDeadlines(limit = 100): Promise<Array<{ matchId: string; stateVersion: number }>> {
    const rows = await sql<Array<{ match_id: string; state_version: number }>>`
      SELECT match_id, state_version FROM football_grid_matches
       WHERE phase <> 'terminal' AND phase_deadline_at <= clock_timestamp()
       ORDER BY phase_deadline_at, match_id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ matchId: row.match_id, stateVersion: row.state_version }));
  },

  async listDueBotActionDeadlines(limit = 100): Promise<Array<{
    matchId: string;
    stateVersion: number;
    turnNumber: number;
  }>> {
    const rows = await sql<Array<{ match_id: string; state_version: number; turn_number: number }>>`
      SELECT match_id, state_version, turn_number FROM football_grid_matches
       WHERE phase = 'turn' AND bot_user_id = current_player_user_id
         AND bot_action_deadline_at <= clock_timestamp()
       ORDER BY bot_action_deadline_at, match_id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      matchId: row.match_id,
      stateVersion: row.state_version,
      turnNumber: row.turn_number,
    }));
  },

  async listPendingHandoffMatchIds(limit = 100, afterMatchId: string | null = null): Promise<string[]> {
    const rows = await sql.unsafe<Array<{ match_id: string }>>(
      `SELECT gm.match_id
         FROM football_grid_matches gm
        WHERE gm.phase = 'handoff'
          AND gm.phase_deadline_at > clock_timestamp()
          AND ($2::uuid IS NULL OR gm.match_id > $2::uuid)
          AND EXISTS (
            SELECT 1 FROM football_grid_participants p
             WHERE p.match_id = gm.match_id AND NOT p.is_bot AND p.handoff_ack_at IS NULL
          )
        ORDER BY gm.match_id
        LIMIT $1`,
      [limit, afterMatchId],
    );
    return rows.map((row) => row.match_id);
  },

  async claimPendingResultDeliveries(input: {
    matchId?: string | null;
    limit?: number;
  } = {}): Promise<FootballGridResultDeliveryRow[]> {
    const limit = input.limit ?? 100;
    return this.runInTransaction(async (tx) => tx.unsafe<FootballGridResultDeliveryRow[]>(
      `WITH candidates AS (
         SELECT d.match_id, d.user_id
           FROM football_grid_result_deliveries d
          WHERE ($1::uuid IS NULL OR d.match_id = $1::uuid)
            AND (
              (d.status = 'pending' AND d.next_attempt_at <= clock_timestamp())
              OR (d.status = 'awaiting_ack' AND d.next_attempt_at <= clock_timestamp())
              OR (d.status = 'processing' AND d.processing_lease_until < clock_timestamp())
            )
          ORDER BY d.next_attempt_at, d.match_id, d.user_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE football_grid_result_deliveries d
          SET status = 'processing', attempt_count = d.attempt_count + 1,
              ack_token = gen_random_uuid(),
              processing_lease_until = clock_timestamp() + interval '60 seconds',
              last_error = null, updated_at = now()
         FROM candidates c
        WHERE d.match_id = c.match_id AND d.user_id = c.user_id
       RETURNING d.match_id, d.user_id, d.terminal_state_version, d.attempt_count, d.ack_token`,
      [input.matchId ?? null, limit],
    ));
  },

  async awaitResultDeliveryAck(
    matchId: string,
    userId: string,
    terminalStateVersion: number,
    ackToken: string,
  ): Promise<boolean> {
    const rows = await sql<Array<{ match_id: string }>>`
      UPDATE football_grid_result_deliveries
         SET status = 'awaiting_ack', processing_lease_until = null,
             next_attempt_at = now() + interval '30 seconds', last_error = null, updated_at = now()
       WHERE match_id = ${matchId} AND user_id = ${userId}
         AND terminal_state_version = ${terminalStateVersion}
         AND ack_token = ${ackToken}
         AND status = 'processing'
      RETURNING match_id
    `;
    return Boolean(rows[0]);
  },

  async acknowledgeResultDelivery(
    matchId: string,
    userId: string,
    terminalStateVersion: number,
    ackToken: string,
  ): Promise<boolean> {
    const rows = await sql<Array<{ match_id: string }>>`
      UPDATE football_grid_result_deliveries
         SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()),
             processing_lease_until = null, next_attempt_at = now(),
             last_error = null, updated_at = now()
       WHERE match_id = ${matchId} AND user_id = ${userId}
         AND terminal_state_version = ${terminalStateVersion}
         AND ack_token = ${ackToken}
         AND status = 'awaiting_ack'
      RETURNING match_id
    `;
    if (rows[0]) return true;
    const existing = await sql<Array<{ found: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM football_grid_result_deliveries
         WHERE match_id = ${matchId} AND user_id = ${userId}
           AND terminal_state_version = ${terminalStateVersion}
           AND ack_token = ${ackToken} AND status = 'delivered'
      ) AS found
    `;
    return existing[0]?.found === true;
  },

  async makeResultDeliveryDue(matchId: string, userId: string): Promise<void> {
    await sql`
      UPDATE football_grid_result_deliveries
         SET status = CASE WHEN status = 'processing' AND processing_lease_until >= now()
                           THEN status ELSE 'pending' END,
             next_attempt_at = now(),
             processing_lease_until = CASE
               WHEN status = 'processing' AND processing_lease_until >= now()
               THEN processing_lease_until ELSE null END,
             ack_token = CASE
               WHEN status = 'processing' AND processing_lease_until >= now()
               THEN ack_token ELSE null END,
             updated_at = now()
       WHERE match_id = ${matchId} AND user_id = ${userId} AND status <> 'delivered'
    `;
  },

  async deferResultDelivery(input: {
    matchId: string;
    userId: string;
    terminalStateVersion: number;
    ackToken: string;
    reason: string;
  }): Promise<void> {
    await sql`
      UPDATE football_grid_result_deliveries
         SET status = 'pending', processing_lease_until = null, ack_token = null,
             next_attempt_at = now() + interval '5 seconds'
               * power(2, least(greatest(attempt_count - 1, 0), 7))::int,
             last_error = ${input.reason.slice(0, 500)}, updated_at = now()
       WHERE match_id = ${input.matchId} AND user_id = ${input.userId}
         AND terminal_state_version = ${input.terminalStateVersion}
         AND ack_token = ${input.ackToken}
         AND status IN ('processing', 'awaiting_ack')
    `;
  },

  async countRecentPairingsForCandidates(userId: string, opponentIds: string[]): Promise<Map<string, number>> {
    if (opponentIds.length === 0) return new Map();
    const rows = await sql.unsafe<Array<{ opponent_id: string; count: string }>>(
      `SELECT opponent.user_id AS opponent_id, count(DISTINCT gm.match_id)::text AS count
         FROM football_grid_matches gm
         JOIN football_grid_participants anchor
           ON anchor.match_id = gm.match_id AND anchor.user_id = $1
         JOIN football_grid_participants opponent
           ON opponent.match_id = gm.match_id
          AND opponent.user_id = ANY($2::uuid[])
        WHERE gm.origin = 'random'
          AND gm.status IN ('completed', 'forfeited')
          AND gm.ended_at >= now() - interval '24 hours'
        GROUP BY opponent.user_id`,
      [userId, opponentIds],
    );
    const counts = new Map(opponentIds.map((opponentId) => [opponentId, 0]));
    for (const row of rows) counts.set(row.opponent_id, Number(row.count));
    return counts;
  },

  async createPairing(input: {
    pairingToken: string;
    searchAId: string;
    searchBId?: string | null;
    userAId: string;
    userBId: string;
    opponentType: 'human' | 'bot';
    searchASnapshot?: Record<string, unknown> | null;
    searchBSnapshot?: Record<string, unknown> | null;
  }): Promise<void> {
    await sql`
      INSERT INTO football_grid_pairings (
        pairing_token, search_a_id, search_b_id, user_a_id, user_b_id,
        opponent_type, status, search_a_snapshot, search_b_snapshot
      ) VALUES (
        ${input.pairingToken}, ${input.searchAId}, ${input.searchBId ?? null},
        ${input.userAId}, ${input.userBId}, ${input.opponentType}, 'claimed',
        ${sql.json((input.searchASnapshot ?? null) as Json)},
        ${sql.json((input.searchBSnapshot ?? null) as Json)}
      )
      ON CONFLICT (pairing_token) DO NOTHING
    `;
  },

  async createSeries(input: {
    origin: Exclude<FootballGridOrigin, 'random'>;
    lobbyId: string | null;
  }): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO football_grid_series (origin, lobby_id, next_opener_seat)
      VALUES (${input.origin}, ${input.lobbyId}, 1)
      RETURNING id
    `;
    return rows[0].id;
  },

  async closeSeries(seriesId: string): Promise<void> {
    await sql`
      UPDATE football_grid_series
         SET status = 'closed', rematch_expires_at = null,
             next_pairing_token = null, state_version = state_version + 1,
             updated_at = now()
       WHERE id = ${seriesId} AND current_match_id IS NULL
    `;
  },

  async offerRematch(input: {
    matchId: string;
    userId: string;
    commandId: string;
    expectedSeriesVersion: number;
    proposedPairingToken: string;
  }): Promise<{
    seriesId: string;
    seriesVersion: number;
    expiresAt: string;
    acceptedUserIds: string[];
    pairingToken: string;
    readyToCreate: boolean;
    rematchIndex: number;
    openerSeat: 1 | 2;
    players: Array<{ userId: string; seat: 1 | 2 }>;
    origin: Exclude<FootballGridOrigin, 'random'>;
    lobbyId: string | null;
    decisionAt: string;
  }> {
    return this.runInTransaction(async (tx) => {
      const rows = await tx.unsafe<Array<{
        id: string;
        origin: Exclude<FootballGridOrigin, 'random'>;
        lobby_id: string | null;
        rematch_index: number;
        next_opener_seat: 1 | 2;
        state_version: number;
        status: 'active' | 'rematch_pending' | 'closed';
        rematch_expires_at: string | null;
        next_pairing_token: string | null;
      }>>(
        `SELECT s.id, s.origin, s.lobby_id, s.rematch_index, s.next_opener_seat,
                s.state_version, s.status, s.rematch_expires_at, s.next_pairing_token
           FROM football_grid_series s
           JOIN football_grid_matches gm ON gm.series_id = s.id
          WHERE gm.match_id = $1 AND s.current_match_id = $1
            AND gm.phase = 'terminal' AND s.origin <> 'random'
          FOR UPDATE OF s`,
        [input.matchId],
      );
      const series = rows[0];
      if (!series) throw new Error('REMATCH_UNAVAILABLE');
      const players = await tx.unsafe<Array<{ user_id: string; seat: 1 | 2; is_bot: boolean }>>(
        `SELECT user_id, seat, is_bot FROM football_grid_participants
          WHERE match_id = $1 ORDER BY seat`,
        [input.matchId],
      );
      if (players.length !== 2 || players.some((player) => player.is_bot)) throw new Error('REMATCH_UNAVAILABLE');
      if (!players.some((player) => player.user_id === input.userId)) throw new Error('NOT_PARTICIPANT');
      const nowMs = await this.databaseNowMs(tx);
      if (series.status === 'closed') throw new Error('REMATCH_UNAVAILABLE');
      if (
        series.status === 'rematch_pending'
        && (!series.rematch_expires_at || Date.parse(series.rematch_expires_at) <= nowMs)
      ) {
        throw new Error('REMATCH_EXPIRED');
      }
      const nextIndex = series.rematch_index + 1;
      const existing = await tx.unsafe<Array<{ command_id: string; decision: string; created_at: string }>>(
        `SELECT command_id, decision, created_at FROM football_grid_series_acceptances
          WHERE series_id = $1 AND rematch_index = $2 AND user_id = $3`,
        [series.id, nextIndex, input.userId],
      );
      if (existing[0] && existing[0].command_id !== input.commandId) throw new Error('REMATCH_ALREADY_DECIDED');
      const replayed = Boolean(existing[0]);
      if (!replayed) {
        // Tolerate exactly one concurrent bump: the peer accepting a moment
        // earlier and opening the rematch window. Any other divergence is a
        // genuinely stale client view.
        if (
          series.state_version !== input.expectedSeriesVersion
          && !(series.status === 'rematch_pending' && series.state_version === input.expectedSeriesVersion + 1)
        ) throw new Error('STALE_SERIES');
        await tx.unsafe(
          `INSERT INTO football_grid_series_acceptances (
             series_id, rematch_index, user_id, command_id, expected_series_version, decision
           ) VALUES ($1,$2,$3,$4,$5,'accept')`,
          [series.id, nextIndex, input.userId, input.commandId, input.expectedSeriesVersion],
        );
      }
      const accepted = await tx.unsafe<Array<{ user_id: string; created_at: string }>>(
        `SELECT user_id, created_at FROM football_grid_series_acceptances
          WHERE series_id = $1 AND rematch_index = $2 AND decision = 'accept'
          ORDER BY user_id`,
        [series.id, nextIndex],
      );
      const pairingToken = series.next_pairing_token ?? input.proposedPairingToken;
      const expiresAt = series.rematch_expires_at
        ? series.rematch_expires_at
        : new Date(nowMs + 30_000).toISOString();
      const updatedVersion = replayed
        ? series.state_version
        : (await tx.unsafe<Array<{ state_version: number }>>(
            `UPDATE football_grid_series
                SET status = 'rematch_pending', rematch_expires_at = $2,
                    next_pairing_token = COALESCE(next_pairing_token, $3),
                    state_version = state_version + 1, updated_at = now()
              WHERE id = $1 RETURNING state_version`,
            [series.id, expiresAt, pairingToken],
          ))[0].state_version;
      const decisionAt = accepted.find((entry) => entry.user_id === input.userId)?.created_at;
      if (!decisionAt) throw new Error('REMATCH_DECISION_MISSING');
      return {
        seriesId: series.id,
        seriesVersion: updatedVersion,
        expiresAt,
        acceptedUserIds: accepted.map((entry) => entry.user_id),
        pairingToken,
        readyToCreate: accepted.length === 2,
        rematchIndex: nextIndex,
        openerSeat: series.next_opener_seat,
        players: players.map((player) => ({ userId: player.user_id, seat: player.seat })),
        origin: series.origin,
        lobbyId: series.lobby_id,
        decisionAt,
      };
    });
  },

  async declineRematch(input: { matchId: string; userId: string; expectedSeriesVersion: number }): Promise<{
    seriesId: string;
    pairingToken: string | null;
    userIds: string[];
    lobbyId: string | null;
    decisionAt: string;
  }> {
    return this.runInTransaction(async (tx) => {
      // Declining is only meaningful while the series' CURRENT match is over
      // and the series is still open. Without these guards a crafted request
      // could close an active series mid-rematch.
      const rows = await tx.unsafe<Array<{ id: string; state_version: number; next_pairing_token: string | null; lobby_id: string | null }>>(
        `SELECT s.id, s.state_version, s.next_pairing_token, s.lobby_id
           FROM football_grid_series s
           JOIN football_grid_matches gm ON gm.series_id = s.id
          WHERE gm.match_id = $1 AND s.current_match_id = $1
            AND gm.phase = 'terminal' AND s.origin <> 'random'
            AND s.status IN ('active', 'rematch_pending')
          FOR UPDATE OF s`,
        [input.matchId],
      );
      const series = rows[0];
      if (!series) throw new Error('REMATCH_UNAVAILABLE');
      const players = await tx.unsafe<Array<{ is_bot: boolean }>>(
        `SELECT is_bot FROM football_grid_participants WHERE match_id = $1`,
        [input.matchId],
      );
      if (players.length !== 2 || players.some((player) => player.is_bot)) throw new Error('REMATCH_UNAVAILABLE');
      if (series.state_version !== input.expectedSeriesVersion) throw new Error('STALE_SERIES');
      const member = await tx.unsafe<Array<{ found: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM football_grid_participants WHERE match_id = $1 AND user_id = $2) AS found`,
        [input.matchId, input.userId],
      );
      if (!member[0]?.found) throw new Error('NOT_PARTICIPANT');
      const closed = await tx.unsafe<Array<{ updated_at: string }>>(
        `UPDATE football_grid_series SET status = 'closed', rematch_expires_at = null,
                next_pairing_token = null, state_version = state_version + 1, updated_at = now()
          WHERE id = $1 RETURNING updated_at`,
        [series.id],
      );
      if (series.lobby_id) {
        await tx.unsafe(
          `UPDATE lobbies SET status = 'waiting', updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [series.lobby_id],
        );
        await tx.unsafe(`UPDATE lobby_members SET is_ready = false WHERE lobby_id = $1`, [series.lobby_id]);
      }
      const participants = await tx.unsafe<Array<{ user_id: string }>>(
        `SELECT user_id FROM football_grid_participants WHERE match_id = $1 ORDER BY user_id`,
        [input.matchId],
      );
      return {
        seriesId: series.id,
        pairingToken: series.next_pairing_token,
        userIds: participants.map((participant) => participant.user_id),
        lobbyId: series.lobby_id,
        decisionAt: closed[0].updated_at,
      };
    });
  },

  async expireRematch(seriesId: string, expectedSeriesVersion: number): Promise<{
    pairingToken: string | null;
    userIds: string[];
    lobbyId: string | null;
  } | null> {
    return this.runInTransaction(async (tx) => {
      const current = await tx.unsafe<Array<{
        next_pairing_token: string | null;
        current_match_id: string | null;
        lobby_id: string | null;
      }>>(
        `SELECT next_pairing_token, current_match_id, lobby_id
           FROM football_grid_series
          WHERE id = $1 AND state_version = $2
            AND status = 'rematch_pending' AND rematch_expires_at <= now()
          FOR UPDATE`,
        [seriesId, expectedSeriesVersion],
      );
      const series = current[0];
      if (!series) return null;
      await tx.unsafe(
        `UPDATE football_grid_series
            SET status = 'closed', rematch_expires_at = null, next_pairing_token = null,
                state_version = state_version + 1, updated_at = now()
          WHERE id = $1`,
        [seriesId],
      );
      if (series.lobby_id) {
        await tx.unsafe(
          `UPDATE lobbies SET status = 'waiting', updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [series.lobby_id],
        );
        await tx.unsafe(`UPDATE lobby_members SET is_ready = false WHERE lobby_id = $1`, [series.lobby_id]);
      }
      const participants = series.current_match_id
        ? await tx.unsafe<Array<{ user_id: string }>>(
            `SELECT user_id FROM football_grid_participants WHERE match_id = $1 ORDER BY user_id`,
            [series.current_match_id],
          )
        : [];
      return {
        pairingToken: series.next_pairing_token,
        userIds: participants.map((participant) => participant.user_id),
        lobbyId: series.lobby_id,
      };
    });
  },

  async closeRematchAfterFailure(seriesId: string, pairingToken: string): Promise<number | null> {
    return this.runInTransaction(async (tx) => {
      const rows = await tx.unsafe<Array<{ lobby_id: string | null; state_version: number }>>(
        `UPDATE football_grid_series
            SET status = 'closed', rematch_expires_at = null,
                next_pairing_token = null, state_version = state_version + 1,
                updated_at = now()
          WHERE id = $1 AND next_pairing_token = $2
            AND status = 'rematch_pending'
          RETURNING lobby_id, state_version`,
        [seriesId, pairingToken],
      );
      const closed = rows[0];
      if (!closed) return null;
      if (closed.lobby_id) {
        await tx.unsafe(
          `UPDATE lobbies SET status = 'waiting', updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [closed.lobby_id],
        );
        await tx.unsafe(`UPDATE lobby_members SET is_ready = false WHERE lobby_id = $1`, [closed.lobby_id]);
      }
      return closed.state_version;
    });
  },

  async getSeriesUserIds(seriesId: string): Promise<string[]> {
    const rows = await sql<Array<{ user_id: string }>>`
      SELECT p.user_id
        FROM football_grid_series s
        JOIN football_grid_participants p ON p.match_id = s.current_match_id
       WHERE s.id = ${seriesId} ORDER BY p.user_id
    `;
    return rows.map((row) => row.user_id);
  },

  async listPendingRematches(limit = 200, afterSeriesId: string | null = null): Promise<Array<{
    seriesId: string;
    seriesVersion: number;
    expiresAt: string;
  }>> {
    const rows = await sql.unsafe<Array<{
      id: string;
      state_version: number;
      rematch_expires_at: string;
    }>>(
      `SELECT id, state_version, rematch_expires_at
        FROM football_grid_series
       WHERE status = 'rematch_pending' AND rematch_expires_at IS NOT NULL
         AND ($2::uuid IS NULL OR id > $2::uuid)
       ORDER BY id
       LIMIT $1`,
      [limit, afterSeriesId],
    );
    return rows.map((row) => ({
      seriesId: row.id,
      seriesVersion: row.state_version,
      expiresAt: row.rematch_expires_at,
    }));
  },

  async listDueRematches(limit = 100): Promise<Array<{
    seriesId: string;
    seriesVersion: number;
  }>> {
    const rows = await sql<Array<{ id: string; state_version: number }>>`
      SELECT id, state_version FROM football_grid_series
       WHERE status = 'rematch_pending' AND rematch_expires_at <= clock_timestamp()
       ORDER BY rematch_expires_at, id
       LIMIT ${limit}
    `;
    return rows.map((row) => ({ seriesId: row.id, seriesVersion: row.state_version }));
  },

  async getRematchInfo(matchId: string): Promise<{
    seriesId: string;
    seriesVersion: number;
    eligible: boolean;
    expiresAt: string | null;
    acceptedUserIds: string[];
  } | null> {
    const rows = await sql<Array<{
      id: string;
      state_version: number;
      origin: FootballGridOrigin;
      status: string;
      rematch_expires_at: string | null;
      accepted_user_ids: string[] | null;
      has_bot: boolean;
    }>>`
      SELECT s.id, s.state_version, s.origin, s.status, s.rematch_expires_at,
             ARRAY(
               SELECT a.user_id::text FROM football_grid_series_acceptances a
                WHERE a.series_id = s.id AND a.rematch_index = s.rematch_index + 1
                  AND a.decision = 'accept' ORDER BY a.user_id
             ) AS accepted_user_ids,
             EXISTS (
               SELECT 1 FROM football_grid_participants p
                WHERE p.match_id = gm.match_id AND p.is_bot
             ) AS has_bot
        FROM football_grid_matches gm
        JOIN football_grid_series s ON s.id = gm.series_id
       WHERE gm.match_id = ${matchId} AND s.current_match_id = gm.match_id
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      seriesId: row.id,
      seriesVersion: row.state_version,
      eligible: row.origin !== 'random' && !row.has_bot && row.status !== 'closed',
      expiresAt: row.rematch_expires_at,
      acceptedUserIds: row.accepted_user_ids ?? [],
    };
  },

  async openRematchWindow(matchId: string): Promise<{
    seriesId: string;
    seriesVersion: number;
    expiresAt: string;
  } | null> {
    return this.runInTransaction(async (tx) => {
      const rows = await tx.unsafe<Array<{
        id: string;
        state_version: number;
        status: 'active' | 'rematch_pending' | 'closed';
        rematch_expires_at: string | null;
      }>>(
        `SELECT s.id, s.state_version, s.status, s.rematch_expires_at
           FROM football_grid_series s
           JOIN football_grid_matches gm ON gm.series_id = s.id
          WHERE gm.match_id = $1 AND s.current_match_id = $1
            AND gm.phase = 'terminal' AND s.origin <> 'random'
          FOR UPDATE OF s`,
        [matchId],
      );
      const series = rows[0];
      if (!series || series.status === 'closed') return null;
      if (series.status === 'rematch_pending' && series.rematch_expires_at) {
        return {
          seriesId: series.id,
          seriesVersion: series.state_version,
          expiresAt: series.rematch_expires_at,
        };
      }
      const expiresAt = new Date((await this.databaseNowMs(tx)) + 30_000).toISOString();
      const updated = await tx.unsafe<Array<{ state_version: number; rematch_expires_at: string }>>(
        `UPDATE football_grid_series
            SET status = 'rematch_pending', rematch_expires_at = $2,
                state_version = state_version + 1, updated_at = now()
          WHERE id = $1
          RETURNING state_version, rematch_expires_at`,
        [series.id, expiresAt],
      );
      return {
        seriesId: series.id,
        seriesVersion: updated[0].state_version,
        expiresAt: updated[0].rematch_expires_at,
      };
    });
  },

  async markPairingFailed(pairingToken: string, reason: string): Promise<boolean> {
    const rows = await sql<Array<{ pairing_token: string }>>`
      UPDATE football_grid_pairings
         SET status = 'failed', failure_reason = ${reason.slice(0, 500)}, updated_at = now()
       WHERE pairing_token = ${pairingToken} AND status = 'claimed'
       RETURNING pairing_token
    `;
    return rows.length === 1;
  },

  async heartbeatPairing(pairingToken: string): Promise<boolean> {
    const rows = await sql<Array<{ pairing_token: string }>>`
      UPDATE football_grid_pairings
         SET updated_at = now()
       WHERE pairing_token = ${pairingToken} AND status = 'claimed'
       RETURNING pairing_token
    `;
    return rows.length === 1;
  },

  async listStaleClaimedPairings(limit = 50): Promise<Array<{
    pairingToken: string;
    userAId: string;
    userBId: string;
    opponentType: 'human' | 'bot';
    searchASnapshot: Record<string, unknown> | null;
    searchBSnapshot: Record<string, unknown> | null;
  }>> {
    const rows = await sql<Array<{
      pairing_token: string;
      user_a_id: string;
      user_b_id: string;
      opponent_type: 'human' | 'bot';
      search_a_snapshot: Record<string, unknown> | null;
      search_b_snapshot: Record<string, unknown> | null;
    }>>`
      SELECT pairing_token, user_a_id, user_b_id, opponent_type,
             search_a_snapshot, search_b_snapshot
       FROM football_grid_pairings
       WHERE status = 'claimed'
         AND updated_at <= now() - interval '90 seconds'
       ORDER BY updated_at ASC
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      pairingToken: row.pairing_token,
      userAId: row.user_a_id,
      userBId: row.user_b_id,
      opponentType: row.opponent_type,
      searchASnapshot: row.search_a_snapshot,
      searchBSnapshot: row.search_b_snapshot,
    }));
  },

  async markParticipantAbsentInTx(
    tx: TransactionSql,
    matchId: string,
    userId: string,
    expectedPresenceGeneration?: number,
  ): Promise<{ absentUserIds: string[]; userPauseBudgetMs: number; presenceGeneration: number; changed: boolean }> {
    const rows = await tx.unsafe<Array<{ pause_budget_remaining_ms: number; presence_generation: string }>>(
      `UPDATE football_grid_participants
          SET absent_since = clock_timestamp(),
              presence_generation = presence_generation + 1,
              updated_at = now()
        WHERE match_id = $1 AND user_id = $2 AND absent_since IS NULL
          AND ($3::bigint IS NULL OR presence_generation = $3)
        RETURNING pause_budget_remaining_ms, presence_generation`,
      [matchId, userId, expectedPresenceGeneration ?? null],
    );
    const participant = rows[0] ?? (await tx.unsafe<Array<{
      pause_budget_remaining_ms: number;
      presence_generation: string;
    }>>(
      `SELECT pause_budget_remaining_ms, presence_generation
         FROM football_grid_participants WHERE match_id = $1 AND user_id = $2`,
      [matchId, userId],
    ))[0];
    if (!participant) throw new Error('NOT_PARTICIPANT');
    const absent = await tx.unsafe<Array<{ user_id: string }>>(
      `SELECT user_id FROM football_grid_participants
        WHERE match_id = $1 AND absent_since IS NOT NULL`,
      [matchId],
    );
    return {
      absentUserIds: absent.map((row) => row.user_id),
      userPauseBudgetMs: participant.pause_budget_remaining_ms,
      presenceGeneration: Number(participant.presence_generation),
      changed: Boolean(rows[0]),
    };
  },

  async markParticipantPresentInTx(
    tx: TransactionSql,
    matchId: string,
    userId: string,
  ): Promise<{ absentUserIds: string[]; presenceGeneration: number; changed: boolean }> {
    const rows = await tx.unsafe<Array<{ user_id: string; presence_generation: string }>>(
      `UPDATE football_grid_participants
          SET pause_budget_remaining_ms = greatest(
                0,
                pause_budget_remaining_ms - CASE
                  WHEN absent_since IS NULL THEN 0
                  ELSE floor(extract(epoch FROM (clock_timestamp() - absent_since)) * 1000)::int
                END
              ),
              absent_since = null,
              presence_generation = presence_generation + 1,
              updated_at = now()
        WHERE match_id = $1 AND user_id = $2 AND absent_since IS NOT NULL
        RETURNING user_id, presence_generation`,
      [matchId, userId],
    );
    const participant = rows[0] ?? (await tx.unsafe<Array<{ user_id: string; presence_generation: string }>>(
      `SELECT user_id, presence_generation FROM football_grid_participants
        WHERE match_id = $1 AND user_id = $2`,
      [matchId, userId],
    ))[0];
    if (!participant) throw new Error('NOT_PARTICIPANT');
    const absent = await tx.unsafe<Array<{ user_id: string }>>(
      `SELECT user_id FROM football_grid_participants
        WHERE match_id = $1 AND absent_since IS NOT NULL`,
      [matchId],
    );
    return {
      absentUserIds: absent.map((row) => row.user_id),
      presenceGeneration: Number(participant.presence_generation),
      changed: Boolean(rows[0]),
    };
  },

  async getPresenceGeneration(matchId: string, userId: string): Promise<number | null> {
    const rows = await sql<Array<{ presence_generation: string }>>`
      SELECT presence_generation FROM football_grid_participants
       WHERE match_id = ${matchId} AND user_id = ${userId}
    `;
    return rows[0] ? Number(rows[0].presence_generation) : null;
  },

  async listAbsentParticipantsInTx(
    tx: TransactionSql,
    matchId: string,
  ): Promise<Array<{ userId: string; absentSince: string; pauseBudgetRemainingMs: number }>> {
    const rows = await tx.unsafe<Array<{
      user_id: string;
      absent_since: string;
      pause_budget_remaining_ms: number;
    }>>(
      `SELECT user_id, absent_since, pause_budget_remaining_ms
         FROM football_grid_participants
        WHERE match_id = $1 AND absent_since IS NOT NULL
        ORDER BY absent_since`,
      [matchId],
    );
    return rows.map((row) => ({
      userId: row.user_id,
      absentSince: row.absent_since,
      pauseBudgetRemainingMs: row.pause_budget_remaining_ms,
    }));
  },

  async selectBoardIdForUsers(
    tx: TransactionSql,
    humanUserIds: string[],
  ): Promise<string | null> {
    const rows = await tx.unsafe<{ id: string }[]>(
      `SELECT b.id
         FROM football_grid_boards b
         JOIN football_grid_content_releases r ON r.id = b.release_id
        WHERE r.status = 'published'
          AND NOT EXISTS (
            SELECT 1
              FROM football_grid_content_quarantines q
             WHERE (q.release_id = b.release_id AND (q.board_id IS NULL OR q.board_id = b.id))
               AND q.action = 'disable'
               AND (q.expires_at IS NULL OR q.expires_at > now())
               AND NOT EXISTS (
                 SELECT 1 FROM football_grid_content_quarantines newer
                  WHERE newer.release_id = q.release_id
                    AND newer.board_id IS NOT DISTINCT FROM q.board_id
                    AND newer.action = 'enable'
                    AND (newer.created_at, newer.id) > (q.created_at, q.id)
               )
          )
        ORDER BY
          EXISTS (
            SELECT 1 FROM football_grid_board_exposures e
             WHERE e.board_id = b.id
               AND e.user_id = ANY($1::uuid[])
               AND e.played_at >= now() - interval '90 days'
          ) ASC,
          (
            SELECT max(e.played_at) FROM football_grid_board_exposures e
             WHERE e.board_id = b.id AND e.user_id = ANY($1::uuid[])
          ) ASC NULLS FIRST,
          random()
        LIMIT 1`,
      [humanUserIds],
    );
    return rows[0]?.id ?? null;
  },

  async createMatch(input: {
    pairingToken: string;
    lobbyId: string | null;
    origin: FootballGridOrigin;
    players: Array<{ userId: string; seat: 1 | 2; isBot?: boolean }>;
    openerUserId: string;
    seriesId?: string | null;
    rematchOfMatchId?: string | null;
    rematchIndex?: number;
    botReservationFence?: number | null;
    botRp?: number | null;
    botTier?: string | null;
    botModelVersion?: number | null;
    botConfigVersion?: number | null;
    botRngSeed?: number | null;
    wrongAnswerVisibility?: boolean;
    afterCreateInTx?: (tx: TransactionSql, matchId: string) => Promise<void>;
  }): Promise<{ state: FootballGridState; created: boolean }> {
    return this.runInTransaction(async (tx) => {
      const existing = await tx.unsafe<{ match_id: string }[]>(
        `SELECT match_id FROM football_grid_matches WHERE pairing_token = $1`,
        [input.pairingToken],
      );
      if (existing[0]) {
        const state = await loadStateWithExecutor(tx, existing[0].match_id, true);
        if (!state) throw new Error('Idempotent Football Grid match disappeared');
        return { state, created: false };
      }
      if (input.players.length !== 2 || new Set(input.players.map((player) => player.userId)).size !== 2) {
        throw new Error('Football Grid match requires exactly two unique players');
      }
      const playerUserIds = input.players.map((player) => player.userId).sort();
      // Serialize all Grid match creation for both identities, then enforce a
      // final DB-side activity precondition. Redis session locks/fences protect
      // cross-mode transitions, while these row locks prevent two Grid sagas
      // from committing concurrent matches for the same user.
      await tx.unsafe(
        `SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [playerUserIds],
      );
      const conflicts = await tx.unsafe<Array<{ active_match: boolean; other_lobby: boolean }>>(
        `SELECT
           EXISTS (
             SELECT 1 FROM match_players mp
             JOIN matches m ON m.id = mp.match_id
              WHERE mp.user_id = ANY($1::uuid[]) AND m.status = 'active'
           ) AS active_match,
           EXISTS (
             SELECT 1 FROM lobby_members lm
             JOIN lobbies l ON l.id = lm.lobby_id
              WHERE lm.user_id = ANY($1::uuid[])
                AND l.status IN ('waiting', 'active')
                AND ($2::uuid IS NULL OR l.id <> $2::uuid)
           ) AS other_lobby`,
        [playerUserIds, input.lobbyId],
      );
      if (conflicts[0]?.active_match || conflicts[0]?.other_lobby) {
        throw new Error('GRID_ACTIVE_SESSION_CONFLICT');
      }
      const humanUserIds = input.players.filter((player) => !player.isBot).map((player) => player.userId);
      const boardId = await this.selectBoardIdForUsers(tx, humanUserIds);
      if (!boardId) throw new Error('No published Football Grid board is available');
      const boards = await tx.unsafe<GridBoardRow[]>(
        `SELECT id, version, release_id, row_criteria, column_criteria, canonical_checksum
           FROM football_grid_boards WHERE id = $1`,
        [boardId],
      );
      const board = boards[0];
      const releases = await tx.unsafe<Array<{ alias_version: number; resolver_policy_version: number }>>(
        `SELECT alias_version, resolver_policy_version
           FROM football_grid_content_releases
          WHERE id = $1 AND status = 'published'`,
        [board.release_id],
      );
      const release = releases[0];
      if (!release) throw new Error('Selected Football Grid release is not published');
      const baseMatches = await tx.unsafe<Array<{ id: string; database_now: string }>>(
        `INSERT INTO matches (
           id, lobby_id, mode, game_variant, status, category_a_id, category_b_id,
           current_q_index, total_questions, state_payload, ranked_context, is_dev, started_at
         ) VALUES (
           gen_random_uuid(), $1, 'friendly', 'football_grid', 'active', null, null,
           0, 0, '{"variant":"football_grid"}'::jsonb, null, false, now()
         ) RETURNING id, clock_timestamp() AS database_now`,
        [input.lobbyId],
      );
      const matchId = baseMatches[0].id;
      const nowMs = Date.parse(baseMatches[0].database_now);
      if (!Number.isFinite(nowMs)) throw new Error('Football Grid database clock is unavailable');
      const phaseDeadlineAt = new Date(nowMs + FOOTBALL_GRID_HANDOFF_MS).toISOString();
      const bot = input.players.find((player) => player.isBot);
      const botModelVersion = bot ? input.botModelVersion ?? 1 : null;
      const botConfigVersion = bot ? input.botConfigVersion ?? 1 : null;
      const botTier = bot && botModelVersion === 2 && botConfigVersion === 1
        ? input.botTier ?? 'Reserve'
        : input.botTier ?? null;
      const botStrengthAdjustment = bot && botModelVersion === 2 && botConfigVersion === 1
        ? await footballGridBotGovernorService.pinStrengthAdjustmentInTx(tx, {
            modelVersion: botModelVersion,
            configVersion: botConfigVersion,
            botTier: botTier!,
          })
        : null;
      await tx.unsafe(
        `INSERT INTO football_grid_matches (
           match_id, pairing_token, board_id, content_release_id, alias_release_id,
           resolver_policy_version, board_checksum, status, phase, origin, series_id,
           rematch_of_match_id, rematch_index, opener_user_id, phase_deadline_at,
           wrong_answer_visibility, bot_user_id, bot_reservation_fence,
           bot_rp, bot_tier, bot_model_version, bot_config_version, bot_rng_seed,
           bot_strength_adjustment
         ) VALUES (
           $1, $2, $3, $4, $4, $5, $6, 'handoff', 'handoff', $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
         )`,
        [
          matchId,
          input.pairingToken,
          board.id,
          board.release_id,
          release.resolver_policy_version,
          board.canonical_checksum,
          input.origin,
          input.seriesId ?? null,
          input.rematchOfMatchId ?? null,
          input.rematchIndex ?? 0,
          input.openerUserId,
          phaseDeadlineAt,
          input.wrongAnswerVisibility ?? false,
          bot?.userId ?? null,
          input.botReservationFence ?? null,
          input.botRp ?? null,
          botTier,
          botModelVersion,
          botConfigVersion,
          input.botRngSeed ?? null,
          botStrengthAdjustment,
        ],
      );
      if (input.afterCreateInTx) await input.afterCreateInTx(tx, matchId);
      const matchedPairing = await tx.unsafe<Array<{ pairing_token: string }>>(
        `UPDATE football_grid_pairings
            SET status = 'matched', match_id = $2, updated_at = now()
          WHERE pairing_token = $1 AND status IN ('claimed', 'matched')
          RETURNING pairing_token`,
        [input.pairingToken, matchId],
      );
      if (matchedPairing.length !== 1) {
        // A recovery worker may have expired the claim while the transaction
        // was preparing the match. Never commit a match behind a failed claim:
        // rolling back here keeps users from being requeued into an active
        // session conflict.
        throw new Error('GRID_PAIRING_CLAIM_LOST');
      }
      const [firstPlayer, secondPlayer] = input.players;
      await tx.unsafe(
        `WITH roster(user_id, seat, is_bot) AS (
           VALUES
             ($2::uuid, $3::smallint, $4::boolean),
             ($5::uuid, $6::smallint, $7::boolean)
         ), inserted_match_players AS (
           INSERT INTO match_players (match_id, user_id, seat)
           SELECT $1, user_id, seat FROM roster
         ), inserted_participants AS (
           INSERT INTO football_grid_participants (
             match_id, user_id, seat, is_bot, handoff_ack_at, ready_at,
             pause_budget_remaining_ms, reward_eligibility_type
           )
           SELECT $1, user_id, seat, is_bot,
                  CASE WHEN is_bot THEN now() ELSE null END,
                  CASE WHEN is_bot THEN now() ELSE null END,
                  $8, CASE WHEN is_bot THEN 'bot' ELSE 'human' END
             FROM roster
         )
         INSERT INTO football_grid_board_exposures (user_id, board_id, match_id)
         SELECT user_id, $9, $1 FROM roster WHERE NOT is_bot`,
        [
          matchId,
          firstPlayer.userId,
          firstPlayer.seat,
          firstPlayer.isBot ?? false,
          secondPlayer.userId,
          secondPlayer.seat,
          secondPlayer.isBot ?? false,
          FOOTBALL_GRID_INITIAL_PAUSE_BUDGET_MS,
          board.id,
        ],
      );
      if (input.seriesId) {
        const openerSeat = input.players.find((player) => player.userId === input.openerUserId)?.seat ?? 1;
        const seriesUpdate = await tx.unsafe<Array<{ id: string }>>(
          `UPDATE football_grid_series
              SET current_match_id = $2, rematch_index = $3, status = 'active',
                  next_opener_seat = $4, next_pairing_token = null,
                  rematch_expires_at = null, updated_at = now(), state_version = state_version + 1
            WHERE id = $1 AND status <> 'closed'
            RETURNING id`,
          [input.seriesId, matchId, input.rematchIndex ?? 0, openerSeat === 1 ? 2 : 1],
        );
        // A concurrent decline or expiry closed the series between the second
        // acceptance and this creation. Abort instead of resurrecting it.
        if (!seriesUpdate[0]) throw new Error('SERIES_CLOSED');
      }
      await tx.unsafe(
        `UPDATE football_grid_matches SET last_event_sequence = 1 WHERE match_id = $1`,
        [matchId],
      );
      await insertEvent(tx, {
        matchId,
        eventSequence: 1,
        stateVersion: 0,
        eventType: 'match_created',
        payload: { origin: input.origin, boardId: board.id },
      });
      const state = await loadStateWithExecutor(tx, matchId, true);
      if (!state) throw new Error('Created Football Grid match could not be loaded');
      return { state, created: true };
    });
  },

  async getBotRuntime(matchId: string): Promise<{
    botUserId: string;
    botRp: number;
    botTier: string;
    modelVersion: number;
    configVersion: number;
    rngSeed: number;
    reservationFence: number;
    strengthAdjustment: number;
  } | null> {
    const rows = await sql<Array<{
      bot_user_id: string;
      bot_rp: number | null;
      bot_tier: string | null;
      bot_model_version: number | null;
      bot_config_version: number | null;
      bot_rng_seed: string | number | null;
      bot_reservation_fence: string | number | null;
      bot_strength_adjustment: string | number | null;
    }>>`
      SELECT bot_user_id, bot_rp, bot_tier, bot_model_version,
             bot_config_version, bot_rng_seed, bot_reservation_fence,
             bot_strength_adjustment
        FROM football_grid_matches
       WHERE match_id = ${matchId} AND bot_user_id IS NOT NULL
         AND bot_reservation_fence IS NOT NULL
    `;
    const row = rows[0];
    if (!row) return null;
    const modelVersion = row.bot_model_version ?? 1;
    const configVersion = row.bot_config_version ?? 1;
    const strengthAdjustment = parseFootballGridBotStrengthAdjustment(
      row.bot_strength_adjustment,
      { required: modelVersion === 2 && configVersion === 1 },
    );
    return {
      botUserId: row.bot_user_id,
      botRp: row.bot_rp ?? 500,
      botTier: row.bot_tier ?? 'Reserve',
      modelVersion,
      configVersion,
      rngSeed: Number(row.bot_rng_seed ?? 1),
      reservationFence: Number(row.bot_reservation_fence),
      strengthAdjustment,
    };
  },

  async ensureBotActionDeadline(input: {
    matchId: string;
    botUserId: string;
    expectedStateVersion: number;
    proposedDeadlineAt: string;
  }): Promise<string | null> {
    const rows = await sql<Array<{ bot_action_deadline_at: string }>>`
      UPDATE football_grid_matches
         SET bot_action_deadline_at = COALESCE(bot_action_deadline_at, ${input.proposedDeadlineAt}),
             updated_at = updated_at
       WHERE match_id = ${input.matchId}
         AND phase = 'turn'
         AND current_player_user_id = ${input.botUserId}
         AND state_version = ${input.expectedStateVersion}
       RETURNING bot_action_deadline_at
    `;
    return rows[0]?.bot_action_deadline_at ?? null;
  },

  async getUnusedAnswersForCellsInTx(
    tx: TransactionSql,
    matchId: string,
    cellIndexes: number[],
  ): Promise<Map<number, string[]>> {
    const rows = await tx.unsafe<Array<{ cell_index: number; football_player_id: string }>>(
      `SELECT a.cell_index, a.football_player_id
         FROM football_grid_matches gm
         JOIN football_grid_board_answers a ON a.board_id = gm.board_id
         JOIN football_players fp ON fp.id = a.football_player_id
        WHERE gm.match_id = $1
          AND a.cell_index = ANY($2::smallint[])
          AND NOT EXISTS (
            SELECT 1 FROM football_grid_claims c
             WHERE c.match_id = gm.match_id AND c.football_player_id = a.football_player_id
          )
        ORDER BY a.cell_index, a.is_sample DESC,
                 a.recognizable_rank ASC NULLS LAST,
                 fp.fame_score DESC NULLS LAST,
                 a.football_player_id`,
      [matchId, cellIndexes],
    );
    const result = new Map<number, string[]>();
    for (const row of rows) {
      const values = result.get(row.cell_index) ?? [];
      values.push(row.football_player_id);
      result.set(row.cell_index, values);
    }
    return result;
  },

  async persistStateInTx(
    tx: TransactionSql,
    previous: FootballGridState,
    next: FootballGridState,
    input: {
      eventType: string;
      eventPayload?: Record<string, unknown>;
      readyCommand?: { userId: string; commandId: string };
      acceptedClaim?: {
        cellIndex: number;
        footballPlayerId: string;
        claimantUserId: string;
        turnNumber: number;
        aliasId: string | null;
        locale: 'en' | 'ka';
      };
      pendingCommandId?: string;
    },
  ): Promise<void> {
    const updated = await tx.unsafe<Array<{ match_id: string; last_event_sequence: string | number }>>(
      `UPDATE football_grid_matches
          SET status = $2, phase = $3, opener_user_id = $4,
              current_player_user_id = $5, winner_user_id = $6,
              turn_number = $7, state_version = $8,
              last_event_sequence = last_event_sequence + $9,
              phase_deadline_at = $10, turn_deadline_at = $11,
              turn_remaining_ms = $12, paused_at = $13,
              reconnect_deadline_at = $14, completion_reason = $15,
              paused_from_phase = $17,
              pending_command_id = CASE WHEN $18::uuid IS NULL THEN pending_command_id ELSE NULL END,
              bot_action_deadline_at = null,
              updated_at = now(), ended_at = CASE WHEN $3 = 'terminal' THEN now() ELSE ended_at END
        WHERE match_id = $1 AND state_version = $16
          AND ($18::uuid IS NULL OR pending_command_id = $18)
        RETURNING match_id, last_event_sequence`,
      [
        previous.matchId,
        next.status,
        next.phase,
        next.openerUserId,
        next.currentPlayerUserId,
        next.winnerUserId,
        next.turnNumber,
        next.stateVersion,
        1,
        next.phaseDeadlineAt,
        next.turnDeadlineAt,
        next.turnRemainingMs,
        next.pausedAt,
        next.reconnectDeadlineAt,
        next.completionReason,
        previous.stateVersion,
        next.pausedFromPhase ?? null,
        input.pendingCommandId ?? null,
      ],
    );
    if (updated.length !== 1) {
      throw new Error('Football Grid state version changed during persistence');
    }
    const sequence = parseEventSequence(updated[0].last_event_sequence);
    for (const player of next.players) {
      const prior = previous.players.find((candidate) => candidate.userId === player.userId);
      if (
        prior
        && prior.handoffAcknowledged === player.handoffAcknowledged
        && prior.ready === player.ready
        && prior.noActionTimeouts === player.noActionTimeouts
        && prior.pauseBudgetRemainingMs === player.pauseBudgetRemainingMs
      ) {
        continue;
      }
      await tx.unsafe(
        `UPDATE football_grid_participants
            SET handoff_ack_at = CASE WHEN $3 THEN COALESCE(handoff_ack_at, now()) ELSE null END,
                ready_at = CASE WHEN $4 THEN COALESCE(ready_at, now()) ELSE null END,
                no_action_timeout_count = $5,
                pause_budget_remaining_ms = $6,
                ready_command_id = CASE
                  WHEN $4 THEN COALESCE(ready_command_id, $7::uuid)
                  ELSE null
                END,
                updated_at = now()
          WHERE match_id = $1 AND user_id = $2`,
        [
          next.matchId,
          player.userId,
          player.handoffAcknowledged,
          player.ready,
          player.noActionTimeouts,
          player.pauseBudgetRemainingMs,
          input.readyCommand?.userId === player.userId ? input.readyCommand.commandId : null,
        ],
      );
    }
    if (input.acceptedClaim) {
      await tx.unsafe(
        `INSERT INTO football_grid_claims (
           match_id, cell_index, football_player_id, claimant_user_id,
           turn_number, accepted_alias_id, accepted_alias_release_id, submitted_locale
         ) SELECT $1, $2, $3, $4, $5, $6,
                  CASE WHEN $6::uuid IS NULL THEN NULL ELSE gm.alias_release_id END, $7
             FROM football_grid_matches gm WHERE gm.match_id = $1`,
        [
          next.matchId,
          input.acceptedClaim.cellIndex,
          input.acceptedClaim.footballPlayerId,
          input.acceptedClaim.claimantUserId,
          input.acceptedClaim.turnNumber,
          input.acceptedClaim.aliasId,
          input.acceptedClaim.locale,
        ],
      );
    }
    const terminal = next.phase === 'terminal';
    if (
      !terminal
      && (
        (previous.phase === 'loading' && next.phase === 'countdown')
        || next.turnNumber % 5 === 0
      )
    ) {
      // Generic session cleanup uses the base match activity clock. Keep it in
      // lockstep with the Grid-owned row so a legitimately long game is never
      // mistaken for a 15-minute orphan. The loading -> countdown boundary is
      // also the durable start of gameplay for analytics; creation time still
      // covers queue handoff and asset loading before this point.
      await tx.unsafe(
        `UPDATE matches
            SET updated_at = now(),
                started_at = CASE WHEN $2 THEN now() ELSE started_at END
          WHERE id = $1`,
        [next.matchId, previous.phase === 'loading' && next.phase === 'countdown'],
      );
    }
    if (terminal) {
      const baseStatus = next.status === 'cancelled' ? 'abandoned' : 'completed';
      await tx.unsafe(
        `UPDATE matches
            SET status = $2, winner_user_id = $3, ended_at = now(), updated_at = now(),
                state_payload = COALESCE(state_payload, '{}'::jsonb) || $4::jsonb
          WHERE id = $1`,
        [
          next.matchId,
          baseStatus,
          next.winnerUserId,
          sql.json({
            variant: 'football_grid',
            completionReason: next.completionReason,
            ...(next.status === 'forfeited' ? { winnerDecisionMethod: 'forfeit' } : {}),
          }),
        ],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_settlement_outbox (
           match_id, terminal_state_version, reward_schedule_version, payload
         )
         SELECT $1, $2, reward_schedule_version, $3::jsonb
           FROM football_grid_matches WHERE match_id = $1
         ON CONFLICT (match_id, terminal_state_version) DO NOTHING`,
        [
          next.matchId,
          next.stateVersion,
          sql.json({ winnerUserId: next.winnerUserId, reason: next.completionReason }),
        ],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_result_deliveries (
           match_id, user_id, terminal_state_version
         )
         SELECT p.match_id, p.user_id, $2
           FROM football_grid_participants p
          WHERE p.match_id = $1 AND NOT p.is_bot
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [next.matchId, next.stateVersion],
      );
    }
    await insertEvent(tx, {
      matchId: next.matchId,
      eventSequence: sequence,
      stateVersion: next.stateVersion,
      eventType: input.eventType,
      payload: input.eventPayload,
    });
  },

  async admitCommand(input: {
    matchId: string;
    actorUserId: string;
    commandId: string;
    expectedStateVersion: number;
    commandType: 'answer' | 'pass' | 'forfeit';
    cellIndex?: number | null;
    locale?: 'en' | 'ka' | null;
    submittedText?: string | null;
    payloadHash: string;
    processingFence?: string;
  }): Promise<FootballGridCommandInboxRow> {
    // Admission is a single statement so the match-row lock, idempotency
    // lookup, deadline check, inbox insert and pending-command fence share one
    // atomic snapshot. The previous implementation opened a transaction only
    // for these two statements, adding BEGIN/SET LOCAL/COMMIT pool occupancy to
    // every gameplay command before the real state-transition transaction.
    const rows = await sql.unsafe<GridCommandAdmissionResultRow[]>(
      `WITH locked_match AS MATERIALIZED (
         SELECT gm.*, clock_timestamp() AS database_now
           FROM football_grid_matches gm
          WHERE gm.match_id = $1
          FOR UPDATE OF gm
       ), existing AS MATERIALIZED (
         SELECT i.*
           FROM football_grid_command_inbox i
           JOIN locked_match gm ON gm.match_id = i.match_id
          WHERE i.actor_user_id = $2
            AND i.command_id = $3
       ), decision AS MATERIALIZED (
         SELECT CASE
           WHEN NOT EXISTS (SELECT 1 FROM locked_match) THEN 'MATCH_NOT_FOUND'
           WHEN EXISTS (SELECT 1 FROM existing WHERE payload_hash <> $9) THEN 'COMMAND_ID_REUSED'
           WHEN EXISTS (SELECT 1 FROM existing) THEN null
           WHEN (SELECT state_version FROM locked_match) <> $4 THEN 'STALE_STATE'
           WHEN (SELECT pending_command_id FROM locked_match) IS NOT NULL THEN 'COMMAND_IN_PROGRESS'
           WHEN (SELECT phase FROM locked_match) = 'terminal' THEN 'INVALID_STATE'
           WHEN $5 <> 'forfeit' AND (
             (SELECT status FROM locked_match) <> 'active'
             OR (SELECT phase FROM locked_match) <> 'turn'
           ) THEN 'INVALID_STATE'
           WHEN $5 <> 'forfeit' AND (SELECT current_player_user_id FROM locked_match) <> $2 THEN 'NOT_YOUR_TURN'
           WHEN $5 <> 'forfeit' AND (
             (SELECT turn_deadline_at FROM locked_match) IS NULL
             OR (SELECT database_now FROM locked_match) > (SELECT turn_deadline_at FROM locked_match)
           ) THEN 'LATE_COMMAND'
           ELSE null
         END AS error_code
       ), admitted AS (
         INSERT INTO football_grid_command_inbox (
           match_id, actor_user_id, command_id, expected_state_version,
           turn_number, command_type, cell_index, locale, submitted_text, payload_hash,
           status, processing_fence, processing_lease_until, retry_count
         )
         SELECT $1,$2,$3,$4,gm.turn_number,$5,$6,$7,$8,$9,
                CASE WHEN $10::uuid IS NULL THEN 'pending' ELSE 'processing' END,
                $10,
                CASE WHEN $10::uuid IS NULL THEN null ELSE now() + interval '30 seconds' END,
                CASE WHEN $10::uuid IS NULL THEN 0 ELSE 1 END
           FROM locked_match gm
           JOIN decision d ON d.error_code IS NULL
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING *
       ), bound AS (
         UPDATE football_grid_matches gm
            SET pending_command_id = admitted.id
           FROM admitted
          WHERE gm.match_id = $1 AND gm.pending_command_id IS NULL
         RETURNING admitted.id
       ), selected AS (
         SELECT to_jsonb(existing) AS inbox FROM existing
         UNION ALL
         SELECT to_jsonb(admitted) AS inbox
           FROM admitted JOIN bound ON bound.id = admitted.id
       )
       SELECT (SELECT inbox FROM selected LIMIT 1) AS inbox,
              CASE
                WHEN decision.error_code IS NOT NULL THEN decision.error_code
                WHEN NOT EXISTS (SELECT 1 FROM selected) THEN 'COMMAND_IN_PROGRESS'
                ELSE null
              END AS error_code
         FROM decision`,
      [
        input.matchId,
        input.actorUserId,
        input.commandId,
        input.expectedStateVersion,
        input.commandType,
        input.cellIndex ?? null,
        input.locale ?? null,
        input.submittedText ?? null,
        input.payloadHash,
        input.processingFence ?? null,
      ],
    );
    const result = rows[0];
    if (!result || result.error_code === 'MATCH_NOT_FOUND') throw new Error('Football Grid match not found');
    if (result.error_code) throw new Error(result.error_code);
    if (!result.inbox) throw new Error('COMMAND_IN_PROGRESS');
    return result.inbox;
  },

  async leaseCommand(commandInboxId: string, processingFence: string): Promise<FootballGridCommandInboxRow | null> {
    const rows = await sql<FootballGridCommandInboxRow[]>`
      UPDATE football_grid_command_inbox
         SET status = 'processing', processing_fence = ${processingFence},
             processing_lease_until = now() + interval '30 seconds',
             retry_count = retry_count + 1
       WHERE id = ${commandInboxId}
         AND retry_count < 3
         AND (
           (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now()))
           OR (status = 'processing' AND processing_lease_until < now())
         )
       RETURNING *
    `;
    return rows[0] ?? null;
  },

  async listRecoverableCommands(limit = 50): Promise<FootballGridCommandInboxRow[]> {
    return sql<FootballGridCommandInboxRow[]>`
      SELECT * FROM football_grid_command_inbox
       WHERE retry_count < 3
         AND (
           (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now()))
           OR (status = 'processing' AND processing_lease_until < now())
         )
       ORDER BY admitted_at
       LIMIT ${limit}
    `;
  },

  async finalizeExpiredExhaustedCommands(limit = 50): Promise<string[]> {
    const candidates = await sql<Array<{ id: string }>>`
      SELECT id FROM football_grid_command_inbox
       WHERE status = 'processing'
         AND retry_count >= 3
         AND processing_lease_until < now()
       ORDER BY admitted_at
       LIMIT ${limit}
    `;
    const finalizedMatchIds: string[] = [];
    for (const candidate of candidates) {
      const matchId = await this.runInTransaction(async (tx) => {
        const rows = await tx.unsafe<Array<{ match_id: string }>>(
          `UPDATE football_grid_command_inbox
              SET status = 'failed', processing_fence = null,
                  processing_lease_until = null, next_retry_at = null,
                  last_error = 'processing lease expired after retry budget',
                  result_code = 'GRID_SERVICE_INTERRUPTION',
                  result_payload = '{"retryable":false}'::jsonb,
                  completed_at = now()
            WHERE id = $1 AND status = 'processing' AND retry_count >= 3
              AND processing_lease_until < now()
            RETURNING match_id`,
          [candidate.id],
        );
        if (!rows[0]) return null;
        await pauseMatchForFailedCommandInTx(tx, rows[0].match_id, candidate.id);
        return rows[0].match_id;
      });
      if (matchId) finalizedMatchIds.push(matchId);
    }
    return finalizedMatchIds;
  },

  async repairInterruptionDeadlines(): Promise<number> {
    // Matches paused into service_interruption before the deadline existed
    // carry a NULL phase_deadline_at forever. Give them one on every recovery
    // pass so they terminate administratively instead of waiting for the
    // stale-match sweeper.
    // unsafe + explicit params: a raw `$1` inside the tagged template never
    // binds (postgres.js only interpolates ${…}) and Postgres rejects the
    // bind message with 08P01 — this call spammed that error every pass.
    const rows = await sql.unsafe<Array<{ match_id: string }>>(
      `UPDATE football_grid_matches
          SET phase_deadline_at = now() + make_interval(secs => $1 / 1000.0),
              updated_at = now(), state_version = state_version + 1,
              last_event_sequence = last_event_sequence + 1
        WHERE phase = 'service_interruption' AND phase_deadline_at IS NULL
          AND pending_command_id IS NULL
        RETURNING match_id`,
      [FOOTBALL_GRID_SERVICE_INTERRUPTION_MS],
    );
    return rows.length;
  },

  async getAttemptForInbox(inboxId: string): Promise<{
    attemptId: string;
    outcome: 'correct' | 'wrong' | 'ambiguous' | 'already_used' | 'pass';
    resolvedPlayerId: string | null;
    normalizedText: string | null;
  } | null> {
    const rows = await sql<Array<{
      id: string;
      outcome: 'correct' | 'wrong' | 'ambiguous' | 'already_used' | 'pass';
      resolved_player_id: string | null;
      normalized_text: string | null;
    }>>`
      SELECT id, outcome, resolved_player_id, normalized_text
        FROM football_grid_attempts
       WHERE inbox_id = ${inboxId}
         AND outcome IN ('correct', 'wrong', 'ambiguous', 'already_used', 'pass')
    `;
    const row = rows[0];
    return row
      ? { attemptId: row.id, outcome: row.outcome, resolvedPlayerId: row.resolved_player_id, normalizedText: row.normalized_text }
      : null;
  },

  async getCommandInbox(commandInboxId: string): Promise<FootballGridCommandInboxRow | null> {
    const rows = await sql<FootballGridCommandInboxRow[]>`
      SELECT * FROM football_grid_command_inbox WHERE id = ${commandInboxId}
    `;
    return rows[0] ?? null;
  },

  async markCommandFailed(input: {
    commandInboxId: string;
    processingFence: string;
    errorMessage: string;
  }): Promise<void> {
    await this.runInTransaction(async (tx) => {
      const rows = await tx.unsafe<Array<{ match_id: string; retry_count: number }>>(
        `UPDATE football_grid_command_inbox
            SET status = CASE WHEN retry_count >= 3 THEN 'failed' ELSE 'pending' END,
                processing_fence = null,
                processing_lease_until = null,
                next_retry_at = CASE WHEN retry_count >= 3 THEN null ELSE now() + interval '1 second' END,
                last_error = $3,
                result_code = CASE WHEN retry_count >= 3 THEN 'GRID_SERVICE_INTERRUPTION' ELSE null END,
                result_payload = CASE WHEN retry_count >= 3 THEN '{"retryable":false}'::jsonb ELSE null END,
                completed_at = CASE WHEN retry_count >= 3 THEN now() ELSE null END
          WHERE id = $1 AND status = 'processing' AND processing_fence = $2
          RETURNING match_id, retry_count`,
        [input.commandInboxId, input.processingFence, input.errorMessage.slice(0, 500)],
      );
      const row = rows[0];
      if (!row || row.retry_count < 3) return;
      await pauseMatchForFailedCommandInTx(tx, row.match_id, input.commandInboxId);
    });
  },

  async cancelCommand(input: {
    commandInboxId: string;
    processingFence: string;
    reason: string;
    resultCode: string;
    resultPayload?: Record<string, unknown>;
  }): Promise<void> {
    await this.runInTransaction(async (tx) => {
      const rows = await tx.unsafe<Array<{ match_id: string }>>(
        `UPDATE football_grid_command_inbox
            SET status = 'cancelled', processing_fence = null,
                processing_lease_until = null, next_retry_at = null,
                last_error = $3, result_code = $4,
                result_payload = $5::jsonb, completed_at = now()
          WHERE id = $1 AND status = 'processing' AND processing_fence = $2
          RETURNING match_id`,
        [
          input.commandInboxId,
          input.processingFence,
          input.reason.slice(0, 500),
          input.resultCode,
          sql.json((input.resultPayload ?? {}) as Json),
        ],
      );
      const row = rows[0];
      if (!row) return;
      await tx.unsafe(
        `UPDATE football_grid_matches
            SET pending_command_id = null, updated_at = now()
          WHERE match_id = $1 AND pending_command_id = $2`,
        [row.match_id, input.commandInboxId],
      );
    });
  },

  async getBoardAnswerContext(matchId: string): Promise<{
    aliasReleaseId: string;
    answers: Array<{ cellIndex: number; footballPlayerId: string }>;
  }> {
    const answerRows = await sql<Array<{
      alias_release_id: string;
      cell_index: number;
      football_player_id: string;
    }>>`
      SELECT gm.alias_release_id, a.cell_index, a.football_player_id
        FROM football_grid_matches gm
        JOIN football_grid_board_answers a ON a.board_id = gm.board_id
       WHERE gm.match_id = ${matchId}
    `;
    if (!answerRows[0]) throw new Error('Football Grid board answers not found');
    return {
      aliasReleaseId: answerRows[0].alias_release_id,
      answers: answerRows.map((row) => ({
        cellIndex: row.cell_index,
        footballPlayerId: row.football_player_id,
      })),
    };
  },

  async getAliasesForRelease(releaseId: string): Promise<FootballGridAliasRecord[]> {
    const aliases = await sql<Array<{
      id: string;
      football_player_id: string;
      alias: string;
      normalized_alias: string;
      locale: 'en' | 'ka' | 'translit';
      acceptance_policy: 'exact' | 'unique_only' | 'safe_typo';
    }>>`
      SELECT id, football_player_id, alias, normalized_alias,
             locale, acceptance_policy
        FROM football_grid_player_aliases
       WHERE release_id = ${releaseId}
    `;
    return aliases.map((row) => ({
      id: row.id,
      playerId: row.football_player_id,
      alias: row.alias,
      normalizedAlias: row.normalized_alias,
      locale: row.locale,
      acceptancePolicy: row.acceptance_policy,
    }));
  },

  async finishCommandInTx(input: {
    tx: TransactionSql;
    inbox: FootballGridCommandInboxRow;
    processingFence: string;
    previous: FootballGridState;
    next: FootballGridState;
    outcome: 'correct' | 'wrong' | 'ambiguous' | 'already_used' | 'pass';
    normalizedText?: string | null;
    resolvedPlayerId?: string | null;
    aliasId?: string | null;
    eventType: string;
  }): Promise<string> {
    const attempts = await input.tx.unsafe<Array<{ id: string }>>(
      `WITH completed AS (
         UPDATE football_grid_command_inbox
            SET status = 'completed', completed_at = now(), processing_lease_until = null,
                result_code = $3, result_payload = $4::jsonb
          WHERE id = $1 AND status = 'processing' AND processing_fence = $2
          RETURNING id
       )
       INSERT INTO football_grid_attempts (
         inbox_id, match_id, actor_user_id, turn_number, cell_index, locale,
         submitted_text, normalized_text, outcome, resolved_player_id, admitted_at
       ) SELECT $1,$5,$6,$7,$8,$9,$10,$11,$3,$12,$13
           FROM completed
       RETURNING id`,
      [
        input.inbox.id,
        input.processingFence,
        input.outcome,
        sql.json({
          outcome: input.outcome,
          resolvedPlayerId: input.resolvedPlayerId ?? null,
        }),
        input.inbox.match_id,
        input.inbox.actor_user_id,
        input.inbox.turn_number,
        input.inbox.cell_index,
        input.inbox.locale,
        input.inbox.submitted_text,
        input.normalizedText ?? null,
        input.resolvedPlayerId ?? null,
        input.inbox.admitted_at,
      ],
    );
    if (!attempts[0]) throw new Error('COMMAND_LEASE_LOST');
    await this.persistStateInTx(input.tx, input.previous, input.next, {
      eventType: input.eventType,
      pendingCommandId: input.inbox.id,
      eventPayload: {
        actorUserId: input.inbox.actor_user_id,
        cellIndex: input.inbox.cell_index,
        outcome: input.outcome,
      },
      ...(input.outcome === 'correct' && input.resolvedPlayerId && input.inbox.cell_index !== null && input.inbox.locale
        ? {
            acceptedClaim: {
              cellIndex: input.inbox.cell_index,
              footballPlayerId: input.resolvedPlayerId,
              claimantUserId: input.inbox.actor_user_id,
              turnNumber: input.inbox.turn_number,
              aliasId: input.aliasId ?? null,
              locale: input.inbox.locale,
            },
          }
        : {}),
    });
    return attempts[0].id;
  },

  async reportMissingAnswer(attemptId: string, reportingUserId: string): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO football_grid_missing_answer_reports (attempt_id, reporting_user_id)
      SELECT id, ${reportingUserId}
       FROM football_grid_attempts
       WHERE id = ${attemptId} AND actor_user_id = ${reportingUserId}
         AND outcome IN ('wrong', 'ambiguous')
         AND (
           SELECT count(*) FROM football_grid_missing_answer_reports
            WHERE reporting_user_id = ${reportingUserId}
              AND created_at >= now() - interval '24 hours'
         ) < 5
      ON CONFLICT (attempt_id, reporting_user_id) DO UPDATE
        SET attempt_id = EXCLUDED.attempt_id
      RETURNING id
    `;
    if (!rows[0]) throw new Error('ATTEMPT_NOT_REPORTABLE');
    return rows[0].id;
  },

  async getMissingAnswerAnalyticsFacts(
    attemptId: string,
    reportingUserId: string,
  ): Promise<{
    matchId: string;
    boardId: string;
    cellIndex: number | null;
    outcome: string;
    reportedAt: string;
  } | null> {
    const rows = await sql<Array<{
      match_id: string;
      board_id: string;
      cell_index: number | null;
      outcome: string;
      reported_at: string;
    }>>`
      SELECT a.match_id, gm.board_id, a.cell_index, a.outcome,
             report.created_at AS reported_at
        FROM football_grid_attempts a
        JOIN football_grid_matches gm ON gm.match_id = a.match_id
        JOIN football_grid_missing_answer_reports report
          ON report.attempt_id = a.id AND report.reporting_user_id = ${reportingUserId}
       WHERE a.id = ${attemptId} AND a.actor_user_id = ${reportingUserId}
       LIMIT 1
    `;
    const row = rows[0];
    return row ? {
      matchId: row.match_id,
      boardId: row.board_id,
      cellIndex: row.cell_index,
      outcome: row.outcome,
      reportedAt: row.reported_at,
    } : null;
  },

  async getCompletionAnalyticsFacts(
    matchId: string,
  ): Promise<FootballGridCompletionAnalyticsFacts | null> {
    const rows = await sql<Array<{
      match_id: string;
      origin: FootballGridOrigin;
      winner_user_id: string | null;
      completion_reason: string | null;
      started_at: string;
      ended_at: string | null;
      board_id: string;
      board_version: number;
      board_difficulty: 'easy' | 'normal' | 'hard';
      turns: number;
      user_id: string;
      is_bot: boolean;
      no_action_timeout_count: number;
      claim_count: number;
      correct_answers: number;
      wrong_answers: number;
      ambiguous_answers: number;
      already_used_answers: number;
      passes: number;
      average_response_ms: number | null;
    }>>`
      SELECT gm.match_id, gm.origin, gm.winner_user_id, gm.completion_reason,
             base_match.started_at, gm.ended_at,
             gm.board_id, board.version AS board_version,
             board.difficulty AS board_difficulty, gm.turn_number AS turns,
             participant.user_id, participant.is_bot,
             participant.no_action_timeout_count,
             COALESCE(claims.claim_count, 0)::int AS claim_count,
             COALESCE(attempts.correct_answers, 0)::int AS correct_answers,
             COALESCE(attempts.wrong_answers, 0)::int AS wrong_answers,
             COALESCE(attempts.ambiguous_answers, 0)::int AS ambiguous_answers,
             COALESCE(attempts.already_used_answers, 0)::int AS already_used_answers,
             COALESCE(attempts.passes, 0)::int AS passes,
             attempts.average_response_ms
        FROM football_grid_matches gm
        JOIN matches base_match ON base_match.id = gm.match_id
        JOIN football_grid_boards board ON board.id = gm.board_id
        JOIN football_grid_participants participant ON participant.match_id = gm.match_id
        LEFT JOIN LATERAL (
          SELECT count(*)::int AS claim_count
            FROM football_grid_claims claim
           WHERE claim.match_id = gm.match_id
             AND claim.claimant_user_id = participant.user_id
        ) claims ON true
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE attempt.outcome = 'correct')::int AS correct_answers,
                 count(*) FILTER (WHERE attempt.outcome = 'wrong')::int AS wrong_answers,
                 count(*) FILTER (WHERE attempt.outcome = 'ambiguous')::int AS ambiguous_answers,
                 count(*) FILTER (WHERE attempt.outcome = 'already_used')::int AS already_used_answers,
                 count(*) FILTER (WHERE attempt.outcome = 'pass')::int AS passes,
                 round(avg(
                   extract(epoch FROM (attempt.resolved_at - attempt.admitted_at)) * 1000
                 ) FILTER (WHERE attempt.cell_index IS NOT NULL))::int AS average_response_ms
            FROM football_grid_attempts attempt
           WHERE attempt.match_id = gm.match_id
             AND attempt.actor_user_id = participant.user_id
        ) attempts ON true
       WHERE gm.match_id = ${matchId}
         AND gm.phase = 'terminal'
       ORDER BY participant.seat
    `;
    const first = rows[0];
    if (!first?.ended_at || !first.completion_reason) return null;
    return {
      matchId: first.match_id,
      origin: first.origin,
      winnerUserId: first.winner_user_id,
      completionReason: first.completion_reason,
      startedAt: first.started_at,
      endedAt: first.ended_at,
      boardId: first.board_id,
      boardVersion: first.board_version,
      boardDifficulty: first.board_difficulty,
      turns: first.turns,
      participants: rows.map((row) => ({
        userId: row.user_id,
        isBot: row.is_bot,
        claimCount: row.claim_count,
        correctAnswers: row.correct_answers,
        wrongAnswers: row.wrong_answers,
        ambiguousAnswers: row.ambiguous_answers,
        alreadyUsedAnswers: row.already_used_answers,
        passes: row.passes,
        noActionTimeouts: row.no_action_timeout_count,
        averageResponseMs: row.average_response_ms,
      })),
    };
  },

  async getCuratedResultSamples(matchId: string): Promise<Array<{
    cellIndex: number;
    players: Array<{ playerId: string; name: string; imageUrl: null; imageAssetKey: string | null }>;
  }>> {
    const rows = await sql<Array<{
      cell_index: number;
      football_player_id: string;
      name: string;
      image_asset_key: string | null;
    }>>`
      SELECT a.cell_index, a.football_player_id,
             COALESCE(a.player_name_en, fp.name) AS name,
             a.image_asset_key
        FROM football_grid_matches gm
        JOIN football_grid_board_answers a ON a.board_id = gm.board_id
        JOIN football_players fp ON fp.id = a.football_player_id
       WHERE gm.match_id = ${matchId}
       ORDER BY a.cell_index,
                a.is_sample DESC,
                a.recognizable_rank ASC NULLS LAST,
                fp.fame_score DESC NULLS LAST,
                a.football_player_id
    `;
    return selectDiverseFootballGridSamples(rows.map((row) => ({
      cellIndex: row.cell_index,
      playerId: row.football_player_id,
      name: row.name,
      imageAssetKey: row.image_asset_key,
    })));
  },
};

export type FootballGridRepo = typeof footballGridRepo;
