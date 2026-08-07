/**
 * WL bot participants — roster bots fill thin fields so live events feel
 * alive, may qualify on merit, but can NEVER win prizes (writeAwards is
 * humans-only and cascades bands past bots; this module only creates play).
 *
 * Bots are server-driven: no sockets, no QP. They are entered (pre-checked-in)
 * when the check-in window opens and a field target is configured, and each
 * reconciler tick answers the in-flight question for a slice of the still-
 * unanswered bots — the once-only Redis accept makes retries harmless, and
 * per-bot accuracy is hash-derived so a bot's skill is stable across games.
 */

import { createHash } from 'node:crypto';
import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { wlAcceptAnswer } from './wl-live-engine.js';
import type { WlRoundKind } from './wl-rules.js';

/** Stable per-bot skill in [0.35, 0.92] — human-passing spread. */
export function wlBotAccuracy(userId: string): number {
  const h = createHash('sha256').update(`wl-bot-skill:${userId}`).digest();
  return 0.35 + (h.readUInt16BE(0) / 0xffff) * 0.57;
}

/** Per-(bot, attempt) correctness draw — deterministic, so retries agree. */
function botAnswersCorrectly(userId: string, attemptId: string): boolean {
  const h = createHash('sha256').update(`wl-bot-roll:${userId}:${attemptId}`).digest();
  return h.readUInt16BE(0) / 0xffff < wlBotAccuracy(userId);
}

function botAnswerFor(
  kind: WlRoundKind,
  evaluation: Record<string, unknown>,
  correct: boolean
): unknown {
  switch (kind) {
    case 'mcq':
    case 'true_false': {
      const right = evaluation['correct_id'];
      if (correct) return right;
      return kind === 'true_false' ? (right === 'true' ? 'false' : 'true') : '__wl_bot_wrong__';
    }
    case 'higher_lower': {
      const left = Number(evaluation['left_value']);
      const right = Number(evaluation['right_value']);
      const winner = left > right ? 'left' : 'right';
      return correct ? winner : winner === 'left' ? 'right' : 'left';
    }
    case 'career_path': {
      const accepted = evaluation['accepted_answers'];
      const answer = Array.isArray(accepted) && typeof accepted[0] === 'string'
        ? accepted[0] : 'unknown';
      return correct ? answer : 'nobody in particular';
    }
    case 'who_am_i': {
      const accepted = evaluation['accepted_answers'];
      const answer = Array.isArray(accepted) && typeof accepted[0] === 'string'
        ? accepted[0] : 'unknown';
      return { guess: correct ? answer : 'nobody in particular' };
    }
    case 'put_in_order': {
      const order = Array.isArray(evaluation['order'])
        ? (evaluation['order'] as unknown[]).map(String) : [];
      // Wrong = one rotation: plausibly close, never accidentally right.
      return correct ? order : [...order.slice(1), order[0]].filter(Boolean);
    }
    case 'money_drop': {
      // Human-passing 70/30 hedge: main stake on the bot's pick, the rest
      // spread elsewhere. The engine scales the sheet to the bot's real
      // budget, so only the RATIO matters — a right pick carries 70% of the
      // budget, a wrong one salvages the 30% hedge, and pure all-in bots
      // (who would flatline over five chained questions) never appear.
      // Deliberately budget-dwarfing stakes: the sanitizer only scales DOWN,
      // so oversized amounts become exact 70/30 of whatever the bot holds.
      const correctId = String(evaluation['correct_id'] ?? '');
      return correct
        ? { bets: { [correctId]: 700_000, '__wl_bot_hedge__': 300_000 } }
        : { bets: { '__wl_bot_wrong__': 700_000, [correctId]: 300_000 } };
    }
  }
}

/** Statuses where topping the field up is meaningful and safe. */
export const WL_BOT_FILL_STATUSES = new Set(['entry_open', 'entry_closed', 'checkin']);

/**
 * Top the field up to `minField` with roster bots. Called by the orchestrator
 * AT THE CHECK-IN CUTOFF (kickoff), when every human who is coming has
 * checked in — filling earlier would let late humans push the field past the
 * target, since bots are never removed. The count and the insert run in ONE
 * transaction under a per-tournament advisory lock, so a concurrent manual
 * fill can never overshoot. Bots enter pre-checked-in (a bot never no-shows)
 * and never touch the QP wallet.
 */
export async function wlFillBotsToTarget(
  tournamentId: string,
  minField: number,
  opts: { requireStatus?: boolean } = {}
): Promise<number> {
  if (minField <= 0) return 0;
  let filled = 0;
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    await txSql`SELECT pg_advisory_xact_lock(hashtext(${`wl-bot-fill:${tournamentId}`}))`;
    if (opts.requireStatus !== false) {
      const [t] = await txSql<Array<{ status: string }>>`
        SELECT status FROM wl_tournaments WHERE id = ${tournamentId}
      `;
      if (!t || !WL_BOT_FILL_STATUSES.has(t.status)) {
        logger.warn({ tournamentId, status: t?.status }, 'WL bot fill refused: phase not fillable');
        return;
      }
    }
    const inserted = await txSql<{ user_id: string }[]>`
      INSERT INTO wl_entries (tournament_id, user_id, state, entered_at, checked_in_at)
      SELECT ${tournamentId}, u.id, 'entered', NOW(), NOW()
      FROM users u
      WHERE u.is_ai = true
        -- Persistent roster bots ONLY: ephemeral/auction bots are
        -- periodically deleted by the AI cleanup cron, which must never
        -- collide with a WL entry, and only the persistent roster is built
        -- to pass as human.
        AND u.ai_kind = 'persistent'
        AND COALESCE(u.is_deleted, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM wl_entries e
          WHERE e.tournament_id = ${tournamentId} AND e.user_id = u.id
        )
      ORDER BY md5(u.id::text || ${tournamentId})
      LIMIT GREATEST(0, ${minField} - (
        SELECT COUNT(*) FROM wl_entries
        WHERE tournament_id = ${tournamentId}
          AND state IN ('entered', 'playing')
          AND checked_in_at IS NOT NULL
      ))
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;
    filled = inserted.length;
  });
  if (filled > 0) {
    logger.info({ tournamentId, filled, minField }, 'WL bots filled field');
  }
  return filled;
}

/** Bots never miss the Sunday final check-in. */
export async function wlBotFinalCheckin(tournamentId: string): Promise<void> {
  await sql`
    UPDATE wl_entries e SET final_checked_in_at = NOW()
    FROM users u
    WHERE e.tournament_id = ${tournamentId} AND e.user_id = u.id
      AND e.state = 'finalist' AND e.final_checked_in_at IS NULL
      AND u.is_ai = true
  `;
}

/**
 * Answer the in-flight question for bot participants that have not answered
 * yet. Called once per reconciler tick while a game is live; each tick a
 * random ~70% slice of the remaining bots answers, spreading answer times
 * across the window without per-bot timers. The Redis accept is once-only,
 * so overlap across ticks or replicas cannot double-score.
 */
export async function wlBotAnswerTick(tournamentId: string): Promise<number> {
  const [run] = await sql<Array<{
    attempt_id: string; game_index: number; question_id: string;
    playable_at_ms: string | null; deadline_at_ms: string | null;
  }>>`
    SELECT attempt_id, game_index, question_id, playable_at_ms::text, deadline_at_ms::text
    FROM wl_question_runs
    WHERE tournament_id = ${tournamentId} AND status = 'dispatched'
    ORDER BY game_index DESC, round_index DESC, question_index DESC
    LIMIT 1
  `;
  if (!run) return 0;

  const [content] = await sql<Array<{ kind: WlRoundKind; evaluation: Record<string, unknown> }>>`
    SELECT kind, evaluation FROM wl_questions WHERE question_id = ${run.question_id}
  `;
  if (!content) return 0;

  const bots = await sql<Array<{ user_id: string }>>`
    SELECT p.user_id FROM wl_game_participants p
    JOIN users u ON u.id = p.user_id
    WHERE p.tournament_id = ${tournamentId} AND p.game_index = ${run.game_index}
      AND u.is_ai = true
      AND NOT EXISTS (
        SELECT 1 FROM wl_answers a
        WHERE a.attempt_id = ${run.attempt_id} AND a.user_id = p.user_id
      )
  `;
  if (bots.length === 0) return 0;

  let answered = 0;
  for (const bot of bots) {
    if (Math.random() > 0.7) continue; // spread across ticks
    const correct = botAnswersCorrectly(bot.user_id, run.attempt_id);
    const answer = botAnswerFor(content.kind, content.evaluation, correct);
    const result = await wlAcceptAnswer({
      tournamentId,
      attemptId: run.attempt_id,
      userId: bot.user_id,
      answer,
    }).catch(() => null);
    if (result?.accepted) answered += 1;
  }
  return answered;
}
