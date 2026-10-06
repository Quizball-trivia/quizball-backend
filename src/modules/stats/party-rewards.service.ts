import { NotFoundError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import type { PartyRewardsResponse } from './stats.schemas.js';
import { PARTY_REWARD_BACKFILL_HOURS } from '../../realtime/party-reward-reconciler.js';

/** Read only: viewing a result never starts or retries a payment. */
export async function getPartyRewards(matchId: string, userId: string): Promise<PartyRewardsResponse> {
  // All joins are single-row primary/unique-key lookups. The participant predicate
  // also authorizes the read; callers cannot inspect another player's rewards.
  const [row] = await sql<{
    is_dev: boolean; is_guest: boolean; is_ai: boolean; ai_kind: string | null;
    job_status: string | null; xp_delta: number | null; recoverable: boolean;
  }[]>`
    SELECT m.is_dev, u.is_guest, u.is_ai, u.ai_kind, j.status AS job_status, x.xp_delta,
      COALESCE(m.ended_at > now() - make_interval(hours => ${PARTY_REWARD_BACKFILL_HOURS}), false) AS recoverable
    FROM match_players mp
    JOIN matches m ON m.id = mp.match_id
    JOIN users u ON u.id = mp.user_id
    LEFT JOIN party_reward_jobs j ON j.match_id = m.id
    LEFT JOIN user_xp_events x ON x.user_id = mp.user_id
      AND x.source_type = 'match_result' AND x.source_key = m.id::text
    WHERE mp.match_id = ${matchId} AND mp.user_id = ${userId}
      AND m.status = 'completed' AND m.game_variant = 'friendly_party_quiz'
  `;
  if (!row) throw new NotFoundError('Completed Party Quiz match not found');
  if (row.is_dev || row.is_guest || (row.is_ai && row.ai_kind !== 'persistent')) {
    return { matchId, status: 'ineligible', xpEarned: null };
  }
  const xpEarned = row.xp_delta;
  // The job is the record of completion (XP alone is not: a replay can save XP before achievements/objectives).
  // No job yet on a recent match: one is coming (the completion's insert, or the reconciler's backfill), so pending.
  // No job on an older match: nothing will create one; show what was saved rather than "saving" forever.
  const status = row.job_status === 'failed' ? 'failed'
    : row.job_status === 'done' ? 'complete'
      : row.job_status === null && !row.recoverable ? 'complete'
        : 'pending';
  return { matchId, status, xpEarned };
}
