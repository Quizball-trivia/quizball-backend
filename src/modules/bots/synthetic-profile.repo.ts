/**
 * Minimal read of synthetic_player_profiles for the gameplay model's skill
 * inputs (PR8). PR5/PR7 own the full synthetic-bots repo (identity, reservation,
 * governor writes); this is a NARROW read of only the fields the calibrated
 * model needs at match creation.
 *
 * PR7 reconciliation: at merge, prefer PR7's synthetic-bots.repo.ts as the
 * canonical home and re-point the import here to it. Kept separate for now so
 * PR8 builds standalone on origin/staging.
 */

import { sql } from '../../db/index.js';

export interface SyntheticSkillInputs {
  baseSkill: number;
  governorAdjustment: number;
  categoryAffinities: Record<string, number>;
}

function toAffinities(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export const syntheticProfileRepo = {
  /** Skill inputs for the gameplay model, or null if the bot has no profile. */
  async getSkillInputs(botUserId: string): Promise<SyntheticSkillInputs | null> {
    const [row] = await sql<Array<{
      base_skill: number;
      governor_adjustment: number;
      category_affinities: unknown;
    }>>`
      SELECT base_skill, governor_adjustment, category_affinities
      FROM synthetic_player_profiles
      WHERE user_id = ${botUserId}
      LIMIT 1
    `;
    if (!row) return null;
    return {
      baseSkill: row.base_skill,
      governorAdjustment: row.governor_adjustment,
      categoryAffinities: toAffinities(row.category_affinities),
    };
  },
};
