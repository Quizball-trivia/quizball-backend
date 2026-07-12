import type { Violation, InvariantResult } from './invariants.mjs';
import { sql } from '../../src/db/index.js';

export interface EconomyBaseline {
  userId: string;
  ticketsBeforeQueueJoin: number;
}

interface MatchRow {
  status: string;
  mode: string;
  winner_user_id: string | null;
  state_payload: unknown;
}

interface PlayerRow {
  user_id: string;
  is_ai: boolean;
  tickets: number;
  early_forfeit_count: number;
}

interface RpRow {
  user_id: string;
  old_rp: number;
  delta_rp: number;
  new_rp: number;
  result: string;
  is_placement: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function checkEconomyInvariants(
  matchId: string,
  baselines: EconomyBaseline[] = [],
): Promise<InvariantResult> {
  const violations: Violation[] = [];
  const [match] = await sql<MatchRow[]>`
    SELECT status, mode, winner_user_id, state_payload FROM matches WHERE id = ${matchId}
  `;
  if (!match || match.mode !== 'ranked') return { ok: true, violations };

  const players = await sql<PlayerRow[]>`
    SELECT mp.user_id, u.is_ai, u.tickets, u.early_forfeit_count
    FROM match_players mp
    JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id = ${matchId}
  `;
  const rpRows = await sql<RpRow[]>`
    SELECT user_id, old_rp, delta_rp, new_rp, result, is_placement
    FROM ranked_rp_changes
    WHERE match_id = ${matchId}
  `;
  const humanPlayers = players.filter((player) => !player.is_ai);
  const baselineByUser = new Map(baselines.map((baseline) => [baseline.userId, baseline]));
  const rpByUser = new Map<string, RpRow[]>();
  for (const row of rpRows) {
    const bucket = rpByUser.get(row.user_id) ?? [];
    bucket.push(row);
    rpByUser.set(row.user_id, bucket);
    if (row.new_rp !== row.old_rp + row.delta_rp) {
      violations.push({
        invariant: 'rpLedgerSane',
        message: `RP arithmetic off for ${row.user_id}: ${row.new_rp} != ${row.old_rp} + ${row.delta_rp}.`,
        detail: { matchId, row },
      });
    }
  }

  const cancelledNoContest = asRecord(match.state_payload).cancelledNoContest === true;
  for (const player of humanPlayers) {
    const baseline = baselineByUser.get(player.user_id);
    const userRpRows = rpByUser.get(player.user_id) ?? [];
    const penaltyRows = userRpRows.filter((row) => row.delta_rp === -100 && row.result === 'loss');
    const penalizedEarlyForfeit = match.status === 'abandoned' && cancelledNoContest && penaltyRows.length === 1;

    if (baseline) {
      const expectedTickets =
        match.status === 'completed'
          ? baseline.ticketsBeforeQueueJoin - 1
          : match.status === 'abandoned'
            ? baseline.ticketsBeforeQueueJoin - (penalizedEarlyForfeit ? 1 : 0)
            : baseline.ticketsBeforeQueueJoin - 1;
      if (player.tickets !== expectedTickets) {
        violations.push({
          invariant: 'ticketConservation',
          message: `Tickets for ${player.user_id} ended at ${player.tickets}, expected ${expectedTickets}.`,
          detail: {
            matchId,
            status: match.status,
            cancelledNoContest,
            userId: player.user_id,
            ticketsBeforeQueueJoin: baseline.ticketsBeforeQueueJoin,
            ticketsAfter: player.tickets,
            penalizedEarlyForfeit,
          },
        });
      }
    }

    if (match.status === 'completed') {
      if (userRpRows.length !== 1) {
        violations.push({
          invariant: 'rpLedgerSane',
          message: `Completed ranked match wrote ${userRpRows.length} RP row(s) for ${player.user_id}; expected exactly one.`,
          detail: { matchId, userId: player.user_id, rows: userRpRows },
        });
      }
      const row = userRpRows[0];
      if (row && match.winner_user_id) {
        const expectedResult = match.winner_user_id === player.user_id ? 'win' : 'loss';
        if (row.result !== expectedResult) {
          violations.push({
            invariant: 'rpLedgerSane',
            message: `RP result for ${player.user_id} is ${row.result}, expected ${expectedResult}.`,
            detail: { matchId, userId: player.user_id, winnerUserId: match.winner_user_id, row },
          });
        }
      }
    } else if (match.status === 'abandoned') {
      const allowedPenaltyOnly = userRpRows.length === 0 || penalizedEarlyForfeit;
      if (!allowedPenaltyOnly) {
        violations.push({
          invariant: 'rpLedgerSane',
          message: `Abandoned ranked match wrote unexpected RP rows for ${player.user_id}.`,
          detail: { matchId, userId: player.user_id, rows: userRpRows, cancelledNoContest },
        });
      }
      if (penalizedEarlyForfeit && player.early_forfeit_count < 4) {
        violations.push({
          invariant: 'rpLedgerSane',
          message: `Early-forfeit penalty row exists for ${player.user_id}, but early_forfeit_count is ${player.early_forfeit_count}.`,
          detail: { matchId, userId: player.user_id, earlyForfeitCount: player.early_forfeit_count },
        });
      }
      if (penaltyRows.length > 1) {
        violations.push({
          invariant: 'rpLedgerSane',
          message: `Early-forfeit penalty wrote ${penaltyRows.length} rows for ${player.user_id}; expected at most one.`,
          detail: { matchId, userId: player.user_id, rows: penaltyRows },
        });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
