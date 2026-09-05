import { sql } from '../../db/index.js';

// Upper bound on how long an exclusion is honoured before PostHog is asked
// about the player again. The reactivation journey requires three days of
// inactivity, and the email campaigns clamp this to their own minimum, so an
// exclusion never carries over into a player's next dormancy episode, while
// flag edits (rollout raised, a condition changed) still reach everyone within
// days instead of costing a billed re-evaluation every tick.
export const RETENTION_FLAG_EXCLUSION_TTL_DAYS = 3;

export const retentionFlagExclusionRepo = {
  async record(input: { featureFlagKey: string; userId: string }): Promise<void> {
    await sql`
      INSERT INTO retention_flag_exclusions (feature_flag_key, user_id, excluded_at)
      VALUES (${input.featureFlagKey}, ${input.userId}, NOW())
      ON CONFLICT (feature_flag_key, user_id)
      DO UPDATE SET excluded_at = EXCLUDED.excluded_at
    `;
  },
};
