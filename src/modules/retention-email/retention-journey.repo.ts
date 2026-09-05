import { sql } from '../../db/index.js';
import { RETENTION_FLAG_EXCLUSION_TTL_DAYS } from './retention-flag-exclusions.repo.js';
import type {
  RetentionEmailAssignment,
  RetentionEmailDestination,
  RetentionEmailVariant,
} from './retention-email.repo.js';

export const REACTIVATION_JOURNEY_KEY = 'dormant_reactivation';
export const REACTIVATION_JOURNEY_VERSION = 1;
export const REACTIVATION_JOURNEY_FEATURE_FLAG_KEY = 'dormant-reactivation-journey-v1';
// Entry requires this much inactivity; the exclusion TTL is clamped to it so an
// exclusion recorded in one dormancy episode cannot reach the next one.
export const REACTIVATION_JOURNEY_MIN_INACTIVE_DAYS = 3;
const JOURNEY_EXCLUSION_TTL_DAYS = Math.min(
  RETENTION_FLAG_EXCLUSION_TTL_DAYS,
  REACTIVATION_JOURNEY_MIN_INACTIVE_DAYS,
);

export type JourneyMilestone = 3 | 7 | 14 | 30 | 60;
export type JourneyStatus = 'draft' | 'canary' | 'live' | 'paused' | 'completed';

export type JourneyConfig = {
  journey_key: string;
  version: number;
  feature_flag_key: string;
  status: JourneyStatus;
  assignment_cap: number;
  daily_assignment_cap: number;
  daily_send_cap: number;
  min_lifetime_matches: number;
  quiet_hours_start: number;
  quiet_hours_end: number;
  email_frequency_days: number;
  sms_status: 'locked' | 'paused' | 'live';
  updated_at: string;
};

export type JourneyCandidate = {
  user_id: string;
  email: string;
  nickname: string | null;
  preferred_language: string;
  country: string | null;
  last_match_started_at: string;
  lifetime_matches: number;
  entry_milestone_days: JourneyMilestone;
};

export type JourneyEnrollment = JourneyCandidate & {
  id: string;
  journey_key: string;
  journey_version: number;
  feature_flag_key: string;
  variant: RetentionEmailVariant;
  entered_at: string;
  status: 'active' | 'exited' | 'completed';
};

export type JourneyDueStep = JourneyEnrollment & {
  milestone_days: JourneyMilestone;
};

export type JourneySegment = {
  segment: '0-3 days' | '3-7 days' | '7-14 days' | '14-30 days' | '30-60 days' | '60+ days';
  players: number;
  email_reachable: number;
  verified_phone: number;
  sms_marketing_eligible: number;
};

export type JourneyFunnel = {
  variant: RetentionEmailVariant;
  enrolled: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  returned_72h: number;
  started_three_matches_7d: number;
};

export type JourneyStepSummary = {
  milestone_days: JourneyMilestone;
  assigned: number;
  sent: number;
  delivered: number;
  clicked: number;
  failed: number;
  unsubscribed: number;
};

function destinationForMilestone(milestone: JourneyMilestone): RetentionEmailDestination {
  if (milestone === 3) return '/daily/challenges';
  if (milestone === 7) return '/weekend-league';
  if (milestone === 14) return '/auction';
  return '/play';
}

export const retentionJourneyRepo = {
  async getConfig(): Promise<JourneyConfig | null> {
    const [row] = await sql<JourneyConfig[]>`
      SELECT journey_key, version, feature_flag_key, status, assignment_cap,
             daily_assignment_cap, daily_send_cap, min_lifetime_matches,
             quiet_hours_start, quiet_hours_end, email_frequency_days,
             sms_status, updated_at::text
      FROM retention_journey_configs
      WHERE journey_key = ${REACTIVATION_JOURNEY_KEY}
      LIMIT 1
    `;
    return row ?? null;
  },

  /**
   * Cheap pre-check for `listEnrollmentCandidates`.
   *
   * The candidate scan aggregates users x match_players x matches and cost
   * 827.9 ms mean on prod (594,521 shared buffers — it visits the 408 MB
   * `matches` heap 148,629 times). The worker ticks every 60s, but the daily
   * assignment cap is reached every day, so most of those 1,440 daily scans
   * produced a result that the capped INSERT then discarded: measured
   * 2026-09-04, this statement family was 61% of ALL prod database time while
   * sending ~100 emails/day.
   *
   * Counting today's enrollments touches a small, indexed table instead
   * (0.55 ms local vs 64 ms for the scan on the same box). The capped INSERT in
   * `insertEnrollment` remains the authority — this only avoids the scan when
   * we already know it cannot produce an enrollment.
   */
  async hasJourneyCapacityToday(config: JourneyConfig): Promise<boolean> {
    const [row] = await sql<{ within_caps: boolean }[]>`
      SELECT (
        (
          SELECT COUNT(*) FROM retention_journey_enrollments e
          WHERE e.journey_key = ${config.journey_key}
            AND e.journey_version = ${config.version}
        ) < ${config.assignment_cap}
        AND (
          SELECT COUNT(*) FROM retention_journey_enrollments e
          WHERE e.journey_key = ${config.journey_key}
            AND e.entered_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'
        ) < ${config.daily_assignment_cap}
      ) AS within_caps
    `;
    return row?.within_caps ?? false;
  },

  async listEnrollmentCandidates(input: {
    config: JourneyConfig;
    userIdAllowlist: string[];
    limit: number;
  }): Promise<JourneyCandidate[]> {
    return sql<JourneyCandidate[]>`
      WITH activity AS (
        SELECT
          u.id AS user_id,
          u.email,
          u.nickname,
          u.preferred_language,
          u.country,
          MAX(m.started_at) AS last_match_started_at,
          COUNT(DISTINCT m.id)::int AS lifetime_matches
        FROM users u
        JOIN match_players mp ON mp.user_id = u.id
        JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
        WHERE u.email IS NOT NULL
          AND BTRIM(u.email) <> ''
          AND u.is_ai = false
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND u.is_banned = false
          AND (
            ${input.userIdAllowlist.length === 0}
            OR u.id = ANY(${sql.array(input.userIdAllowlist)}::uuid[])
          )
          AND NOT EXISTS (
            SELECT 1 FROM retention_flag_exclusions fx
            WHERE fx.feature_flag_key = ${input.config.feature_flag_key}
              AND fx.user_id = u.id
              AND fx.excluded_at >= NOW() - make_interval(days => ${JOURNEY_EXCLUSION_TTL_DAYS})
          )
        GROUP BY u.id, u.email, u.nickname, u.preferred_language, u.country
      )
      SELECT
        a.user_id,
        a.email,
        a.nickname,
        a.preferred_language,
        a.country,
        a.last_match_started_at::text,
        a.lifetime_matches,
        CASE
          WHEN a.last_match_started_at <= NOW() - INTERVAL '60 days' THEN 60
          WHEN a.last_match_started_at <= NOW() - INTERVAL '30 days' THEN 30
          WHEN a.last_match_started_at <= NOW() - INTERVAL '14 days' THEN 14
          WHEN a.last_match_started_at <= NOW() - INTERVAL '7 days' THEN 7
          ELSE 3
        END::int AS entry_milestone_days
      FROM activity a
      WHERE a.lifetime_matches >= ${input.config.min_lifetime_matches}
        AND a.last_match_started_at <= NOW() - make_interval(days => ${REACTIVATION_JOURNEY_MIN_INACTIVE_DAYS})
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = a.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments recent
          WHERE recent.user_id = a.user_id
            AND recent.assigned_at >= NOW() - make_interval(days => ${input.config.email_frequency_days})
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_email_log legacy
          WHERE legacy.user_id = a.user_id
            AND legacy.sent_at >= NOW() - make_interval(days => ${input.config.email_frequency_days})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM retention_journey_enrollments e
          WHERE e.journey_key = ${input.config.journey_key}
            AND e.journey_version = ${input.config.version}
            AND e.user_id = a.user_id
            AND (
              e.status = 'active'
              OR e.baseline_last_match_started_at = a.last_match_started_at
            )
        )
      ORDER BY hashtextextended(a.user_id::text || ${input.config.journey_key}, 0), a.user_id
      LIMIT ${input.limit}
    `;
  },

  async insertEnrollment(input: {
    config: JourneyConfig;
    candidate: JourneyCandidate;
    variant: RetentionEmailVariant;
  }): Promise<JourneyEnrollment | null> {
    const [row] = await sql<Array<{
      id: string;
      journey_key: string;
      journey_version: number;
      feature_flag_key: string;
      user_id: string;
      variant: RetentionEmailVariant;
      entered_at: string;
      status: 'active' | 'exited' | 'completed';
      last_match_started_at: string;
      entry_milestone_days: JourneyMilestone;
    }>>`
      WITH journey_gate AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${input.config.journey_key}, 0))
      ), within_caps AS (
        SELECT 1
        FROM journey_gate
        WHERE (
          SELECT COUNT(*) FROM retention_journey_enrollments e
          WHERE e.journey_key = ${input.config.journey_key}
            AND e.journey_version = ${input.config.version}
        ) < ${input.config.assignment_cap}
        AND (
          SELECT COUNT(*) FROM retention_journey_enrollments e
          WHERE e.journey_key = ${input.config.journey_key}
            AND e.entered_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'
        ) < ${input.config.daily_assignment_cap}
        AND EXISTS (
          SELECT 1 FROM retention_journey_configs current_config
          WHERE current_config.journey_key = ${input.config.journey_key}
            AND current_config.version = ${input.config.version}
            AND current_config.status IN ('canary', 'live')
            AND current_config.assignment_cap > 0
        )
      )
      INSERT INTO retention_journey_enrollments (
        journey_key,
        journey_version,
        feature_flag_key,
        user_id,
        variant,
        baseline_last_match_started_at,
        entry_milestone_days
      )
      SELECT
        ${input.config.journey_key},
        ${input.config.version},
        ${input.config.feature_flag_key},
        ${input.candidate.user_id},
        ${input.variant},
        ${input.candidate.last_match_started_at},
        ${input.candidate.entry_milestone_days}
      FROM within_caps
      ON CONFLICT DO NOTHING
      RETURNING id, journey_key, journey_version, feature_flag_key, user_id,
                variant, entered_at::text, status,
                baseline_last_match_started_at::text AS last_match_started_at,
                entry_milestone_days
    `;
    if (!row) return null;
    return {
      ...row,
      email: input.candidate.email,
      nickname: input.candidate.nickname,
      preferred_language: input.candidate.preferred_language,
      country: input.candidate.country,
      lifetime_matches: input.candidate.lifetime_matches,
    };
  },

  async exitIneligibleEnrollments(): Promise<number> {
    const rows = await sql<Array<{ id: string }>>`
      WITH latest_activity AS (
        SELECT e.id, MAX(m.started_at) AS latest_match
        FROM retention_journey_enrollments e
        LEFT JOIN match_players mp ON mp.user_id = e.user_id
        LEFT JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
        WHERE e.journey_key = ${REACTIVATION_JOURNEY_KEY}
          AND e.status = 'active'
        GROUP BY e.id
      )
      UPDATE retention_journey_enrollments e
      SET status = 'exited',
          exited_at = NOW(),
          exit_reason = CASE
            WHEN latest_activity.latest_match > e.baseline_last_match_started_at THEN 'returned'
            WHEN EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = e.user_id)
              THEN 'unsubscribed'
            ELSE 'user_ineligible'
          END
      FROM latest_activity
      WHERE e.id = latest_activity.id
        AND (
          latest_activity.latest_match > e.baseline_last_match_started_at
          OR EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = e.user_id)
          OR NOT EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = e.user_id
              AND u.email IS NOT NULL AND BTRIM(u.email) <> ''
              AND u.is_ai = false AND u.is_seed = false
              AND u.is_deleted = false AND u.deleted_at IS NULL
              AND u.pending_deletion_at IS NULL AND u.is_banned = false
          )
        )
      RETURNING e.id
    `;
    return rows.length;
  },

  async listDueSteps(input: { config: JourneyConfig; limit: number }): Promise<JourneyDueStep[]> {
    return sql<JourneyDueStep[]>`
      SELECT
        e.id,
        e.journey_key,
        e.journey_version,
        e.feature_flag_key,
        e.user_id,
        e.variant,
        e.entered_at::text,
        e.status,
        e.baseline_last_match_started_at::text AS last_match_started_at,
        e.entry_milestone_days,
        u.email,
        u.nickname,
        u.preferred_language,
        u.country,
        activity.lifetime_matches,
        due.milestone_days
      FROM retention_journey_enrollments e
      JOIN users u ON u.id = e.user_id
      JOIN LATERAL (
        SELECT COUNT(DISTINCT m.id)::int AS lifetime_matches
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
        WHERE mp.user_id = e.user_id
      ) activity ON true
      JOIN LATERAL (
        SELECT milestone_days
        FROM unnest(ARRAY[3, 7, 14, 30, 60]) AS milestones(milestone_days)
        WHERE milestone_days >= e.entry_milestone_days
          AND NOW() >= e.baseline_last_match_started_at + make_interval(days => milestone_days)
          AND NOT EXISTS (
            SELECT 1 FROM retention_email_assignments a
            WHERE a.journey_enrollment_id = e.id
              AND a.milestone_days = milestone_days
          )
        ORDER BY milestone_days
        LIMIT 1
      ) due ON true
      WHERE e.journey_key = ${input.config.journey_key}
        AND e.journey_version = ${input.config.version}
        AND e.status = 'active'
        AND e.variant = 'test'
        AND u.email IS NOT NULL AND BTRIM(u.email) <> ''
        -- A player who came back is exited by the periodic sweep; until it runs,
        -- never schedule a comeback email for someone who already played.
        AND NOT EXISTS (
          SELECT 1 FROM match_players mp
          JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
          WHERE mp.user_id = e.user_id
            AND m.started_at > e.baseline_last_match_started_at
        )
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = e.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments recent
          WHERE recent.user_id = e.user_id
            AND recent.variant = 'test'
            AND recent.send_status IN ('pending', 'sending', 'sent')
            AND recent.assigned_at >= NOW() - make_interval(days => ${input.config.email_frequency_days})
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_email_log legacy
          WHERE legacy.user_id = e.user_id
            AND legacy.sent_at >= NOW() - make_interval(days => ${input.config.email_frequency_days})
        )
        AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tbilisi') >= ${input.config.quiet_hours_end}
        AND EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Asia/Tbilisi') < ${input.config.quiet_hours_start}
      ORDER BY e.entered_at, e.id
      LIMIT ${input.limit}
    `;
  },

  async insertDueStep(input: {
    config: JourneyConfig;
    step: JourneyDueStep;
  }): Promise<RetentionEmailAssignment | null> {
    const destination = destinationForMilestone(input.step.milestone_days);
    const campaignKey = `${input.config.journey_key}_v${input.config.version}_d${input.step.milestone_days}_${input.step.id}`;
    const [row] = await sql<RetentionEmailAssignment[]>`
      WITH send_gate AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${input.config.journey_key} || ':send', 0))
      ), within_daily_cap AS (
        SELECT 1
        FROM send_gate
        WHERE (
          SELECT COUNT(*)
          FROM retention_email_assignments a
          JOIN retention_journey_enrollments e ON e.id = a.journey_enrollment_id
          WHERE e.journey_key = ${input.config.journey_key}
            AND a.variant = 'test'
            AND a.assigned_at >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'
        ) < ${input.config.daily_send_cap}
        AND EXISTS (
          SELECT 1 FROM retention_journey_configs current_config
          WHERE current_config.journey_key = ${input.config.journey_key}
            AND current_config.version = ${input.config.version}
            AND current_config.status IN ('canary', 'live')
        )
      )
      INSERT INTO retention_email_assignments (
        campaign_key,
        feature_flag_key,
        user_id,
        tournament_id,
        message_kind,
        variant,
        cta_state,
        destination_path,
        qp_remaining,
        lifetime_matches,
        last_match_started_at,
        send_status,
        journey_enrollment_id,
        milestone_days,
        scheduled_for
      )
      SELECT
        ${campaignKey},
        ${input.config.feature_flag_key},
        ${input.step.user_id},
        NULL,
        'dormant_journey',
        'test',
        'comeback',
        ${destination},
        0,
        ${input.step.lifetime_matches},
        ${input.step.last_match_started_at},
        'pending',
        ${input.step.id},
        ${input.step.milestone_days},
        NOW()
      FROM within_daily_cap
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!row) return null;
    return {
      ...row,
      email: input.step.email,
      nickname: input.step.nickname,
      preferred_language: input.step.preferred_language,
      country: input.step.country,
      entry_closes_at: null,
    };
  },

  async getSegments(): Promise<JourneySegment[]> {
    return sql<JourneySegment[]>`
      WITH activity AS (
        SELECT
          u.id AS user_id,
          u.email,
          u.phone_verified_at,
          MAX(m.started_at) AS last_match_started_at,
          COUNT(DISTINCT m.id)::int AS lifetime_matches
        FROM users u
        JOIN match_players mp ON mp.user_id = u.id
        JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
        WHERE u.is_ai = false AND u.is_seed = false
          AND u.is_deleted = false AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL AND u.is_banned = false
        GROUP BY u.id, u.email, u.phone_verified_at
      ), bucketed AS (
        SELECT
          a.*,
          CASE
            WHEN a.last_match_started_at > NOW() - INTERVAL '3 days' THEN '0-3 days'
            WHEN a.last_match_started_at > NOW() - INTERVAL '7 days' THEN '3-7 days'
            WHEN a.last_match_started_at > NOW() - INTERVAL '14 days' THEN '7-14 days'
            WHEN a.last_match_started_at > NOW() - INTERVAL '30 days' THEN '14-30 days'
            WHEN a.last_match_started_at > NOW() - INTERVAL '60 days' THEN '30-60 days'
            ELSE '60+ days'
          END AS segment,
          CASE
            WHEN a.last_match_started_at > NOW() - INTERVAL '3 days' THEN 1
            WHEN a.last_match_started_at > NOW() - INTERVAL '7 days' THEN 2
            WHEN a.last_match_started_at > NOW() - INTERVAL '14 days' THEN 3
            WHEN a.last_match_started_at > NOW() - INTERVAL '30 days' THEN 4
            WHEN a.last_match_started_at > NOW() - INTERVAL '60 days' THEN 5
            ELSE 6
          END AS sort_order
        FROM activity a
      )
      SELECT
        b.segment,
        COUNT(*)::int AS players,
        COUNT(*) FILTER (
          WHERE b.email IS NOT NULL AND BTRIM(b.email) <> ''
            AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = b.user_id)
        )::int AS email_reachable,
        COUNT(*) FILTER (WHERE b.phone_verified_at IS NOT NULL)::int AS verified_phone,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM marketing_channel_preferences p
            WHERE p.user_id = b.user_id AND p.sms_marketing_opted_in = true
          )
        )::int AS sms_marketing_eligible
      FROM bucketed b
      GROUP BY b.segment, b.sort_order
      ORDER BY b.sort_order
    `;
  },

  async getFunnel(): Promise<JourneyFunnel[]> {
    return sql<JourneyFunnel[]>`
      SELECT
        e.variant,
        COUNT(DISTINCT e.id)::int AS enrolled,
        COUNT(DISTINCT e.user_id) FILTER (WHERE a.sent_at IS NOT NULL)::int AS sent,
        COUNT(DISTINCT e.user_id) FILTER (WHERE a.delivered_at IS NOT NULL)::int AS delivered,
        COUNT(DISTINCT e.user_id) FILTER (WHERE a.opened_at IS NOT NULL)::int AS opened,
        COUNT(DISTINCT e.user_id) FILTER (WHERE a.clicked_at IS NOT NULL)::int AS clicked,
        COUNT(DISTINCT e.user_id) FILTER (WHERE outcomes.matches_72h >= 1)::int AS returned_72h,
        COUNT(DISTINCT e.user_id) FILTER (WHERE outcomes.matches_7d >= 3)::int AS started_three_matches_7d
      FROM retention_journey_enrollments e
      LEFT JOIN retention_email_assignments a ON a.journey_enrollment_id = e.id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(DISTINCT m.id) FILTER (
            WHERE m.started_at > e.entered_at AND m.started_at <= e.entered_at + INTERVAL '72 hours'
          )::int AS matches_72h,
          COUNT(DISTINCT m.id) FILTER (
            WHERE m.started_at > e.entered_at AND m.started_at <= e.entered_at + INTERVAL '7 days'
          )::int AS matches_7d
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id AND m.is_dev = false
        WHERE mp.user_id = e.user_id
      ) outcomes ON true
      WHERE e.journey_key = ${REACTIVATION_JOURNEY_KEY}
        AND e.journey_version = ${REACTIVATION_JOURNEY_VERSION}
      GROUP BY e.variant
      ORDER BY e.variant
    `;
  },

  async getStepSummary(): Promise<JourneyStepSummary[]> {
    return sql<JourneyStepSummary[]>`
      SELECT
        a.milestone_days,
        COUNT(*)::int AS assigned,
        COUNT(*) FILTER (WHERE a.sent_at IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE a.delivered_at IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE a.clicked_at IS NOT NULL)::int AS clicked,
        COUNT(*) FILTER (WHERE a.send_status = 'failed' OR a.delivery_failed_at IS NOT NULL)::int AS failed,
        COUNT(*) FILTER (WHERE a.unsubscribed_at IS NOT NULL)::int AS unsubscribed
      FROM retention_email_assignments a
      JOIN retention_journey_enrollments e ON e.id = a.journey_enrollment_id
      WHERE e.journey_key = ${REACTIVATION_JOURNEY_KEY}
        AND e.journey_version = ${REACTIVATION_JOURNEY_VERSION}
      GROUP BY a.milestone_days
      ORDER BY a.milestone_days
    `;
  },

  async pause(adminUserId: string): Promise<JourneyConfig | null> {
    const [row] = await sql<JourneyConfig[]>`
      UPDATE retention_journey_configs
      SET status = 'paused', updated_by = ${adminUserId}
      WHERE journey_key = ${REACTIVATION_JOURNEY_KEY}
        AND status IN ('canary', 'live')
      RETURNING journey_key, version, feature_flag_key, status, assignment_cap,
                daily_assignment_cap, daily_send_cap, min_lifetime_matches,
                quiet_hours_start, quiet_hours_end, email_frequency_days,
                sms_status, updated_at::text
    `;
    return row ?? null;
  },
};
