/**
 * Deletion predicates for the legacy fake-account cleanup (PR11).
 *
 * These SQL fragments are the ONLY definition of "safe to hard-delete". They
 * are exported as strings (rather than inlined at the call sites) so the same
 * text drives the dry-run count, the executed delete, and the tests — a
 * predicate that is measured but not enforced is how a cleanup deletes the
 * wrong rows.
 *
 * WHY EACH CLAUSE EXISTS — `is_seed` alone is NOT a safe predicate. The flag was
 * backfilled by 20260524110000_clean_leaderboard_fake_users.sql with
 * "is_ai = false AND no user_identities row", which is a statement about auth
 * linkage, not about being fake. On both prod and staging that predicate also
 * caught the `admin@quizball.com` operator account, which has no identity row.
 * Every clause below narrows `is_seed` back toward "provably synthetic and
 * provably invisible".
 */

/** A user is only reachable if it still carries the seed flag and is not AI. */
const IS_SEED = `u.is_seed = true AND u.is_ai = false`;

/**
 * Excludes the mis-flagged operator account. `role <> 'user'` is checked in
 * ADDITION to the identity check below because either one alone would have
 * saved it; requiring both means a future privileged account is protected even
 * if it is created with role='user'.
 */
const NOT_PRIVILEGED = `u.role = 'user'`;

/**
 * Never delete anything that can authenticate. This is the inverse of the
 * original backfill predicate, so a seed row that has SINCE been claimed by a
 * real signup (identity linked after May 24) is protected without needing the
 * stale flag to be corrected first.
 */
const NO_AUTH_IDENTITY = `NOT EXISTS (
      SELECT 1 FROM public.user_identities ui WHERE ui.user_id = u.id
    )`;

/**
 * Both known synthetic populations were machine-generated WITH an email
 * (gmail.com fillers, '<...>@example.invalid' load rows). A NULL/empty email is
 * an unrecognised shape, so refuse it rather than guess.
 */
const HAS_EMAIL = `u.email IS NOT NULL AND u.email <> ''`;

/**
 * Social-graph protection, mirroring 20260727100000_ai_cleanup_protect_friends.
 * A hard delete CASCADEs friendships/friend_requests away, silently removing a
 * real human's friend.
 */
const NOT_SOCIAL = `NOT EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.user_low_id = u.id OR f.user_high_id = u.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.friend_requests fr
      WHERE fr.status = 'pending'
        AND fr.created_at > NOW() - INTERVAL '14 days'
        AND (fr.sender_user_id = u.id OR fr.receiver_user_id = u.id)
    )`;

/**
 * Visibility guard, identical in intent to cleanup_ai_users()'s `recent_window`.
 * Deletion is a HARD delete with no tombstone: match_players CASCADEs, so
 * stats.repo.ts's opponent LEFT JOIN yields NULL and the row renders BLANK —
 * it does NOT render 'Deleted Player', because that label keys off
 * is_deleted/deleted_at on a row that no longer exists. So a seed may only be
 * removed once it has aged out of every human's most-recent-N window.
 *
 * This is not hypothetical: one completed match on staging (and one on prod)
 * pairs a real user with a legacy filler. Both are far outside the window
 * today, but the guard is enforced rather than assumed so the script stays
 * correct whenever it is next run.
 */
const NOT_RECENTLY_VISIBLE = `NOT EXISTS (
      SELECT 1
      FROM public.match_players mp
      JOIN _seed_protected_match_ids p ON p.match_id = mp.match_id
      WHERE mp.user_id = u.id
    )`;

/**
 * Mid-match guard. The visibility window only covers completed/abandoned
 * matches, so a seed currently in a live match would otherwise be deleted out
 * from under its opponent.
 */
const NOT_IN_LIVE_MATCH = `NOT EXISTS (
      SELECT 1
      FROM public.match_players amp
      JOIN public.matches am ON am.id = amp.match_id
      WHERE amp.user_id = u.id
        AND am.status NOT IN ('completed', 'abandoned')
    )`;

/**
 * The two recognised synthetic populations. Neither is a default: the caller
 * must name a scope, so a single flag can never reach both.
 *
 *  - `legacy`   the ~1,807 gmail.com leaderboard fillers bulk-created
 *               2026-02-17..2026-03-07. Present on BOTH prod and staging.
 *  - `loadtest` the 21,478 rows written by scripts/load/seed-production-shape.ts
 *               ('load-seed-N@example.invalid'). STAGING-ONLY — prod has zero.
 *               These own effectively all seed footprint (~108k match_players,
 *               ~66k winner rows, ~65k lobbies).
 */
export const SCOPES = ['legacy', 'loadtest'] as const;
export type Scope = (typeof SCOPES)[number];

const LOADTEST_EMAIL = `u.email LIKE '%@example.invalid'`;

/**
 * The legacy filler batch, identified POSITIVELY rather than as "everything
 * that is not load-test".
 *
 * A catch-all `NOT (loadtest)` would make the scope open-ended: any future row
 * that gets wrongly flagged is_seed — a real account whose identity row is
 * missing, say — would fall into it and become deletable. Only the role guard
 * would stand in the way, and that is one clause too few for a hard delete.
 *
 * The real batch is tightly bounded and was measured read-only on BOTH envs:
 * 1,806 rows, every one @gmail.com, created 2026-02-17..2026-03-07 at ~100/day.
 * Pinning the domain and the creation window means the scope can only ever
 * shrink as rows are deleted; it can never grow to cover an account created
 * later.
 */
const LEGACY_FILLER = `u.email LIKE '%@gmail.com'
    AND u.created_at >= TIMESTAMPTZ '2026-02-17'
    AND u.created_at < TIMESTAMPTZ '2026-03-08'`;

export function scopeClause(scope: Scope): string {
  return scope === 'loadtest' ? LOADTEST_EMAIL : LEGACY_FILLER;
}

/**
 * Numeric values are interpolated into SQL (they cannot be bound parameters in
 * LIMIT/window position on every path), so they are proven to be plain integers
 * HERE rather than trusting each caller. The CLI already validates its flags;
 * this makes the module safe to call from anywhere, including tests.
 */
function assertInteger(value: number, name: string, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${String(value)}.`);
  }
  return value;
}

/**
 * The per-human most-recent-N match set, materialised once per run. Mirrors
 * cleanup_ai_users(); `is_seed = false` is added to the "human" side so the
 * 21k load-test seeds cannot protect each other's matches and stall the drain.
 */
export function protectedMatchesSql(recentWindow: number): string {
  assertInteger(recentWindow, 'recentWindow', 1);
  return `
    CREATE TEMP TABLE _seed_protected_match_ids ON COMMIT DROP AS
      SELECT match_id FROM (
        SELECT mp.match_id,
               row_number() OVER (
                 PARTITION BY mp.user_id
                 ORDER BY COALESCE(m.ended_at, m.started_at) DESC
               ) AS rn
        FROM public.match_players mp
        JOIN public.matches m ON m.id = mp.match_id
        JOIN public.users u  ON u.id = mp.user_id
        WHERE u.is_ai = false
          AND u.is_seed = false
          AND m.is_dev = false
          AND m.status IN ('completed', 'abandoned')
      ) ranked
      WHERE rn <= ${recentWindow}`;
}

/** The full conjunction. Requires _seed_protected_match_ids to exist. */
export function deletablePredicate(scope: Scope): string {
  return [
    IS_SEED,
    NOT_PRIVILEGED,
    NO_AUTH_IDENTITY,
    HAS_EMAIL,
    scopeClause(scope),
    NOT_SOCIAL,
    NOT_RECENTLY_VISIBLE,
    NOT_IN_LIVE_MATCH,
  ].join('\n    AND ');
}

/**
 * Ordered id selection for one batch. FOR UPDATE SKIP LOCKED per cleanup_ai_users().
 *
 * `restrictToIds` narrows the batch to an explicit id list ($1::uuid[]). It is
 * an additional NARROWING clause only — it can never widen the predicate — and
 * exists so a run can be confined to a pre-approved id set (and so tests can
 * assert against their own fixtures on a shared database).
 */
export function selectBatchSql(scope: Scope, limit: number, restrictToIds = false): string {
  assertInteger(limit, 'limit', 1);
  return `
    SELECT u.id
    FROM public.users u
    WHERE ${restrictToIds ? 'u.id = ANY($1::uuid[])\n    AND ' : ''}${deletablePredicate(scope)}
    ORDER BY u.created_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`;
}
