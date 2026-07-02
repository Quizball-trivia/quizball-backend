import type { MatchAnswerRow } from '../../modules/matches/matches.types.js';
import { matchAnswersRepo } from '../../modules/matches/match-answers.repo.js';

/**
 * Whether a single persisted answer row reflects a genuine human submission
 * rather than a timeout backfill.
 *
 * A timeout backfill (possession-round-resolver) writes a fixed shape:
 * selected_index=null, is_correct=false, points_earned=0, and an answer_payload
 * whose found/order/clue fields are all null/empty. A real submission always
 * diverges on at least one of these:
 *   - multipleChoice records the picked option in selected_index (non-null even
 *     when wrong), so selected_index != null proves a click;
 *   - countdown/putInOrder record foundCount>0 / non-empty id arrays;
 *   - clues records a non-null clueIndex;
 *   - any correct or scoring answer sets is_correct / points_earned.
 * A backfill can never satisfy any of these, so this is a reliable, one-sided
 * signal (it never flags a backfill as interaction).
 */
export function isGenuineAnswerSubmission(row: MatchAnswerRow): boolean {
  if (row.selected_index !== null) return true;
  if (row.is_correct) return true;
  if (row.points_earned > 0) return true;

  const payload: Record<string, unknown> =
    row.answer_payload && typeof row.answer_payload === 'object' && !Array.isArray(row.answer_payload)
      ? (row.answer_payload as Record<string, unknown>)
      : {};
  if (typeof payload.foundCount === 'number' && payload.foundCount > 0) return true;
  if (Array.isArray(payload.foundAnswerIds) && payload.foundAnswerIds.length > 0) return true;
  if (Array.isArray(payload.submittedOrderIds) && payload.submittedOrderIds.length > 0) return true;
  if (typeof payload.clueIndex === 'number') return true;
  return false;
}

/**
 * True when NO human in the match ever genuinely submitted an answer — every
 * row for every human user is a timeout backfill. AI rows are ignored: an AI is
 * synthetically driven, so its (non-)participation says nothing about whether a
 * real player interacted. A match with at least one human submission returns
 * false, protecting a legitimate win over an absent opponent.
 */
export function hasNoHumanInteraction(
  answers: MatchAnswerRow[],
  humanUserIds: ReadonlySet<string>
): boolean {
  return !answers.some(
    (row) => humanUserIds.has(row.user_id) && isGenuineAnswerSubmission(row)
  );
}

export async function matchHasNoHumanInteraction(
  matchId: string,
  humanUserIds: ReadonlySet<string>
): Promise<boolean> {
  if (humanUserIds.size === 0) return false;
  const answers = await matchAnswersRepo.listAnswersForMatch(matchId);
  return hasNoHumanInteraction(answers, humanUserIds);
}
