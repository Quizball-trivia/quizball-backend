-- Enforce case-insensitive nickname uniqueness for active real users.
-- AI users and deleted/pending-deletion users don't constrain uniqueness so
-- the human namespace stays clean.

-- ── Dedupe step ──
-- For each group of active real users sharing a lowercased nickname, keep the
-- earliest-created row untouched and rename the rest by appending the first 8
-- characters of their UUID. UUID prefixes are practically guaranteed unique
-- per-group, and the resulting suffix can't already exist as another user's
-- chosen nickname (since users can't pick names containing their own UUID).
WITH duplicates AS (
  SELECT
    id,
    nickname,
    ROW_NUMBER() OVER (
      PARTITION BY lower(nickname)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.users
  WHERE is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL
    AND length(nickname) > 0
)
UPDATE public.users u
SET nickname = duplicates.nickname || '_' || substr(u.id::text, 1, 8)
FROM duplicates
WHERE u.id = duplicates.id
  AND duplicates.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_nickname_real
  ON public.users (lower(nickname))
  WHERE is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL
    AND length(nickname) > 0;
