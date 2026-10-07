/** The partner content pool (partner_content_pool): which bank questions a partner's dailies may draw from.
 *
 *  Today the pool is seeded by copying eligible published questions from the bank (`source = 'bank_copy'`), minus the
 *  public guest sets of today/yesterday. Dedicated partner content goes in with `source = 'dedicated'`; deactivating
 *  the copies (`UPDATE partner_content_pool SET active = false WHERE source = 'bank_copy'`) then switches every play
 *  to it without code changes. Each play draws its own set at start, never a day-wide shared one. */

import { logger } from '../../../../core/logger.js';
import type { Db } from '../../partner-db.js';
import { dailyChallengesService } from '../../../daily-challenges/daily-challenges.service.js';
import type { DailyChallengeType } from '../../../daily-challenges/daily-challenges.types.js';
import { PARTNER_DAILY_RULES, type AnyDailyRules, type BankRow, type PartnerDailyGameId } from './daily-rules.js';

const PUBLIC_DAILY_TYPE: Record<PartnerDailyGameId, DailyChallengeType> = {
  countdown: 'countdown',
  'true-false': 'trueFalse',
  'pick-em': 'imposter',
  'career-path': 'careerPath',
  'higher-lower': 'highLow',
};

/** Ids in today's (and yesterday's) public guest sets for the game's public twin; empty if the cache is unreachable. */
export async function publicDailyQuestionIds(gameId: PartnerDailyGameId): Promise<string[]> {
  try {
    return await dailyChallengesService.listPublicGuestSetQuestionIds(PUBLIC_DAILY_TYPE[gameId]);
  } catch (error) {
    logger.warn({ err: error, gameId }, 'Partner dailies: could not read the public guest sets');
    return [];
  }
}

const CANDIDATES = 200;

/**
 * Draws one play's items: random active pool questions that are still published, minus `excluded`, preferring
 * questions this player has not had recently and never two items with the same answer.
 */
export async function drawPlayItems(
  tx: Db,
  rules: AnyDailyRules,
  partnerSlug: string,
  opts: { excluded: string[]; recent: string[] },
): Promise<Array<{ qid: string }> | null> {
  const rows = await tx<BankRow[]>`
    SELECT q.id, q.prompt, qp.payload, c.name AS category_name
    FROM partner_content_pool p
    JOIN questions q ON q.id = p.question_id
    JOIN question_payloads qp ON qp.question_id = q.id
    JOIN categories c ON c.id = q.category_id
    WHERE p.partner_slug = ${partnerSlug} AND p.game_id = ${rules.gameId} AND p.active
      AND q.status = 'published' AND q.type = ${rules.questionType}
      AND NOT (q.id = ANY(${opts.excluded}::uuid[]))
    ORDER BY random()
    LIMIT ${CANDIDATES}`;
  const recent = new Set(opts.recent);
  const ordered = [...rows.filter((r) => !recent.has(r.id)), ...rows.filter((r) => recent.has(r.id))];
  const picked: Array<{ qid: string }> = [];
  const usedKeys = new Set<string>();
  for (const row of ordered) {
    if (picked.length >= rules.itemCount) break;
    const item = rules.snapshot(row);
    if (!item) continue;
    const keys = rules.answerKeys(item);
    if (keys.some((k) => usedKeys.has(k))) continue;
    keys.forEach((k) => usedKeys.add(k));
    picked.push(item);
  }
  return picked.length === rules.itemCount ? picked : null;
}

export interface SeedResult {
  gameId: PartnerDailyGameId;
  eligible: number;
  excludedPublic: number;
  added: number;
  poolActive: number;
}

/**
 * Copies eligible bank questions into the pool, per game. Eligible = the same filters as the public dailies
 * (published, public, ranked-eligible, active non-featured category, valid payload for the game), minus today's and
 * yesterday's public guest sets. Re-running adds only what is new; it never removes or reactivates a row.
 */
export async function seedPartnerContentPool(
  db: Db,
  opts: { partnerSlug: string; games?: PartnerDailyGameId[]; perGameLimit?: number; dryRun?: boolean },
): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  for (const gameId of opts.games ?? (Object.keys(PARTNER_DAILY_RULES) as PartnerDailyGameId[])) {
    const rules = PARTNER_DAILY_RULES[gameId];
    const rows = await db<BankRow[]>`
      SELECT q.id, q.prompt, qp.payload, c.name AS category_name
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      JOIN categories c ON c.id = q.category_id
      WHERE q.status = 'published' AND q.visibility = 'public' AND q.ranked_eligible = true
        AND q.type = ${rules.questionType} AND c.is_active = true
        AND NOT EXISTS (SELECT 1 FROM featured_categories fc WHERE fc.category_id = c.id)
      ORDER BY q.id`;
    const publicIds = new Set(await publicDailyQuestionIds(gameId));
    const eligible = rows.filter((row) => rules.snapshot(row) !== null);
    const notPublic = eligible.filter((row) => !publicIds.has(row.id));
    const chosen = notPublic.slice(0, opts.perGameLimit ?? notPublic.length);
    let added = 0;
    if (!opts.dryRun && chosen.length > 0) {
      const inserted = await db<{ question_id: string }[]>`
        INSERT INTO partner_content_pool (partner_slug, game_id, question_id, source)
        SELECT ${opts.partnerSlug}, ${gameId}, id, 'bank_copy' FROM unnest(${chosen.map((r) => r.id)}::uuid[]) AS id
        ON CONFLICT DO NOTHING
        RETURNING question_id`;
      added = inserted.length;
    }
    const [{ n }] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM partner_content_pool
      WHERE partner_slug = ${opts.partnerSlug} AND game_id = ${gameId} AND active`;
    results.push({ gameId, eligible: eligible.length, excludedPublic: eligible.length - notPublic.length, added, poolActive: n });
  }
  return results;
}
