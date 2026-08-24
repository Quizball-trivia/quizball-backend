import { sql } from '../../db/index.js';

export type RetentionEmailVariant = 'control' | 'test';
export type RetentionEmailCtaState = 'qualifying' | 'qualified' | 'comeback';
export type RetentionEmailMessageKind = 'weekend_league' | 'dormant_comeback';

export type RetentionEmailCandidate = {
  user_id: string;
  email: string;
  nickname: string | null;
  preferred_language: string;
  tournament_id: string | null;
  entry_closes_at: string | null;
  message_kind: RetentionEmailMessageKind;
  qp_remaining: number;
  lifetime_matches: number;
  cta_state: RetentionEmailCtaState;
  destination_path: '/play' | '/weekend-league';
  last_match_started_at: string;
};

export type RetentionEmailAssignment = RetentionEmailCandidate & {
  id: string;
  campaign_key: string;
  feature_flag_key: string;
  variant: RetentionEmailVariant;
  assigned_at: string;
  send_status: 'not_applicable' | 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
};

export type RetentionEmailClickAssignment = {
  id: string;
  user_id: string;
  campaign_key: string;
  variant: RetentionEmailVariant;
  message_kind: RetentionEmailMessageKind;
  cta_state: RetentionEmailCtaState;
  destination_path: '/play' | '/weekend-league';
  send_status: string;
  clicked_at: string | null;
};

export type RetentionEmailUnsubscribeAttribution = {
  user_id: string;
  campaign_key: string;
  variant: RetentionEmailVariant;
  assigned_at: string;
};

export type RetentionEmailProviderAttribution = {
  id: string;
  user_id: string;
  campaign_key: string;
  variant: RetentionEmailVariant;
  message_kind: RetentionEmailMessageKind;
  cta_state: RetentionEmailCtaState;
  destination_path: '/play' | '/weekend-league';
};

export const retentionEmailRepo = {
  async listEligibleCandidates(input: {
    campaignKey: string;
    minInactiveDays: number;
    maxInactiveDays: number;
    frequencyDays: number;
    minLeadHours: number;
    maxLeadHours: number;
    userIdAllowlist: string[];
    limit: number;
  }): Promise<RetentionEmailCandidate[]> {
    return sql<RetentionEmailCandidate[]>`
      WITH current_tournament AS (
        SELECT
          t.id,
          t.entry_closes_at,
          CASE
            WHEN t.config->>'qp_target' ~ '^[0-9]{1,6}$'
              THEN (t.config->>'qp_target')::int
            ELSE 200
          END AS qp_target
        FROM wl_tournaments t
        WHERE t.is_test = false
          AND t.status = 'entry_open'
          AND t.entry_closes_at IS NOT NULL
          AND t.entry_closes_at > NOW() + make_interval(hours => ${input.minLeadHours})
          AND t.entry_closes_at <= NOW() + make_interval(hours => ${input.maxLeadHours})
        ORDER BY t.entry_closes_at ASC
        LIMIT 1
      )
      SELECT
        u.id AS user_id,
        u.email,
        u.nickname,
        u.preferred_language,
        t.id AS tournament_id,
        t.entry_closes_at::text AS entry_closes_at,
        'weekend_league'::text AS message_kind,
        GREATEST(0, t.qp_target - qp.balance)::int AS qp_remaining,
        activity.lifetime_matches,
        CASE WHEN qp.balance >= t.qp_target THEN 'qualified' ELSE 'qualifying' END AS cta_state,
        CASE WHEN qp.balance >= t.qp_target THEN '/weekend-league' ELSE '/play' END AS destination_path,
        activity.last_match_started_at::text AS last_match_started_at
      FROM users u
      CROSS JOIN current_tournament t
      JOIN LATERAL (
        SELECT
          MAX(m.started_at) AS last_match_started_at,
          COUNT(DISTINCT m.id)::int AS lifetime_matches
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id
          AND m.is_dev = false
      ) activity ON activity.last_match_started_at IS NOT NULL
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(a.points), 0)::int AS balance
        FROM wl_qp_awards a
        WHERE a.user_id = u.id
          AND a.created_at > COALESCE(
            (SELECT MAX(r.reset_at) FROM wl_qp_resets r WHERE r.user_id = u.id),
            '-infinity'::timestamptz
          )
      ) qp
      WHERE u.email IS NOT NULL
        AND BTRIM(u.email) <> ''
        AND UPPER(BTRIM(COALESCE(u.country, ''))) = 'GE'
        AND u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
        AND activity.last_match_started_at <= NOW() - make_interval(days => ${input.minInactiveDays})
        AND activity.last_match_started_at > NOW() - make_interval(days => ${input.maxInactiveDays})
        AND (
          ${input.userIdAllowlist.length === 0}
          OR u.id = ANY(${sql.array(input.userIdAllowlist)}::uuid[])
        )
        AND NOT EXISTS (
          SELECT 1 FROM email_unsubscribes x WHERE x.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_entries e
          WHERE e.tournament_id = t.id AND e.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments a
          WHERE a.campaign_key = ${input.campaignKey}
            AND a.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments recent
          WHERE recent.user_id = u.id
            AND recent.assigned_at >= NOW() - make_interval(days => ${input.frequencyDays})
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_email_log legacy
          WHERE legacy.user_id = u.id
            AND legacy.sent_at >= NOW() - make_interval(days => ${input.frequencyDays})
        )
      ORDER BY activity.last_match_started_at DESC, u.id
      LIMIT ${input.limit}
    `;
  },

  async listDormantCandidates(input: {
    campaignKey: string;
    minInactiveDays: number;
    maxInactiveDays: number;
    minLifetimeMatches: number;
    frequencyDays: number;
    userIdAllowlist: string[];
    limit: number;
  }): Promise<RetentionEmailCandidate[]> {
    return sql<RetentionEmailCandidate[]>`
      SELECT
        u.id AS user_id,
        u.email,
        u.nickname,
        u.preferred_language,
        NULL::uuid AS tournament_id,
        NULL::text AS entry_closes_at,
        'dormant_comeback'::text AS message_kind,
        0::int AS qp_remaining,
        activity.lifetime_matches,
        'comeback'::text AS cta_state,
        '/play'::text AS destination_path,
        activity.last_match_started_at::text AS last_match_started_at
      FROM users u
      JOIN LATERAL (
        SELECT
          MAX(m.started_at) AS last_match_started_at,
          COUNT(DISTINCT m.id)::int AS lifetime_matches
        FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id
          AND m.is_dev = false
      ) activity ON activity.last_match_started_at IS NOT NULL
      WHERE u.email IS NOT NULL
        AND BTRIM(u.email) <> ''
        AND UPPER(BTRIM(COALESCE(u.country, ''))) = 'GE'
        AND u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
        AND activity.lifetime_matches >= ${input.minLifetimeMatches}
        AND activity.last_match_started_at <= NOW() - make_interval(days => ${input.minInactiveDays})
        AND activity.last_match_started_at > NOW() - make_interval(days => ${input.maxInactiveDays})
        AND (
          ${input.userIdAllowlist.length === 0}
          OR u.id = ANY(${sql.array(input.userIdAllowlist)}::uuid[])
        )
        AND NOT EXISTS (
          SELECT 1 FROM email_unsubscribes x WHERE x.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments a
          WHERE a.campaign_key = ${input.campaignKey}
            AND a.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM retention_email_assignments recent
          WHERE recent.user_id = u.id
            AND recent.assigned_at >= NOW() - make_interval(days => ${input.frequencyDays})
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_email_log legacy
          WHERE legacy.user_id = u.id
            AND legacy.sent_at >= NOW() - make_interval(days => ${input.frequencyDays})
        )
      ORDER BY hashtextextended(u.id::text || ${input.campaignKey}, 0), u.id
      LIMIT ${input.limit}
    `;
  },

  async insertAssignment(input: {
    campaignKey: string;
    featureFlagKey: string;
    candidate: RetentionEmailCandidate;
    variant: RetentionEmailVariant;
    assignmentCap: number;
  }): Promise<RetentionEmailAssignment | null> {
    const [row] = await sql<RetentionEmailAssignment[]>`
      WITH campaign_gate AS (
        SELECT pg_advisory_xact_lock(hashtextextended(${input.campaignKey}, 0))
      ), within_cap AS (
        SELECT 1
        FROM campaign_gate
        WHERE (
          SELECT COUNT(*)
          FROM retention_email_assignments existing
          WHERE existing.campaign_key = ${input.campaignKey}
        ) < ${input.assignmentCap}
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
        send_status
      )
      SELECT
        ${input.campaignKey},
        ${input.featureFlagKey},
        ${input.candidate.user_id},
        ${input.candidate.tournament_id},
        ${input.candidate.message_kind},
        ${input.variant},
        ${input.candidate.cta_state},
        ${input.candidate.destination_path},
        ${input.candidate.qp_remaining},
        ${input.candidate.lifetime_matches},
        ${input.candidate.last_match_started_at},
        ${input.variant === 'test' ? 'pending' : 'not_applicable'}
      FROM within_cap
      ON CONFLICT (campaign_key, user_id) DO NOTHING
      RETURNING *
    `;
    if (!row) return null;
    return {
      ...row,
      email: input.candidate.email,
      nickname: input.candidate.nickname,
      preferred_language: input.candidate.preferred_language,
      entry_closes_at: input.candidate.entry_closes_at,
    };
  },

  async recoverStaleClaims(maxAttempts: number, staleMinutes: number): Promise<void> {
    await sql`
      UPDATE retention_email_assignments
      SET send_status = CASE WHEN attempts >= ${maxAttempts} THEN 'failed' ELSE 'pending' END,
          cancel_reason = CASE WHEN attempts >= ${maxAttempts} THEN 'attempt_limit' ELSE NULL END
      WHERE send_status = 'sending'
        AND last_attempt_at < NOW() - make_interval(mins => ${staleMinutes})
    `;
  },

  async cancelInvalidPending(): Promise<void> {
    await sql`
      UPDATE retention_email_assignments a
      SET send_status = 'cancelled',
          cancel_reason = CASE
            WHEN EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = a.user_id)
              THEN 'unsubscribed'
            WHEN NOT EXISTS (
              SELECT 1 FROM users u
              WHERE u.id = a.user_id
                AND u.email IS NOT NULL
                AND BTRIM(u.email) <> ''
                AND u.is_ai = false
                AND u.is_seed = false
                AND u.is_deleted = false
                AND u.deleted_at IS NULL
                AND u.pending_deletion_at IS NULL
                AND u.is_banned = false
                AND UPPER(BTRIM(COALESCE(u.country, ''))) = 'GE'
            ) THEN 'user_ineligible'
            WHEN a.message_kind = 'weekend_league' AND EXISTS (
              SELECT 1 FROM wl_entries e
              WHERE e.tournament_id = a.tournament_id AND e.user_id = a.user_id
            ) THEN 'already_entered'
            WHEN EXISTS (
              SELECT 1
              FROM match_players mp
              JOIN matches m ON m.id = mp.match_id
              WHERE mp.user_id = a.user_id
                AND m.is_dev = false
                AND m.started_at > a.assigned_at
            ) THEN 'already_returned'
            WHEN EXISTS (
              SELECT 1 FROM wl_email_log legacy
              WHERE legacy.user_id = a.user_id AND legacy.sent_at > a.assigned_at
            ) THEN 'another_marketing_email_sent'
            WHEN a.message_kind = 'weekend_league' THEN 'entry_window_closed'
            ELSE 'campaign_no_longer_eligible'
          END
      WHERE a.send_status = 'pending'
        AND (
          EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = a.user_id)
          OR NOT EXISTS (
            SELECT 1 FROM users u
            WHERE u.id = a.user_id
              AND u.email IS NOT NULL
              AND BTRIM(u.email) <> ''
              AND u.is_ai = false
              AND u.is_seed = false
              AND u.is_deleted = false
              AND u.deleted_at IS NULL
              AND u.pending_deletion_at IS NULL
              AND u.is_banned = false
              AND UPPER(BTRIM(COALESCE(u.country, ''))) = 'GE'
          )
          OR (a.message_kind = 'weekend_league' AND EXISTS (
            SELECT 1 FROM wl_entries e
            WHERE e.tournament_id = a.tournament_id AND e.user_id = a.user_id
          ))
          OR EXISTS (
            SELECT 1
            FROM match_players mp
            JOIN matches m ON m.id = mp.match_id
            WHERE mp.user_id = a.user_id
              AND m.is_dev = false
              AND m.started_at > a.assigned_at
          )
          OR EXISTS (
            SELECT 1 FROM wl_email_log legacy
            WHERE legacy.user_id = a.user_id AND legacy.sent_at > a.assigned_at
          )
          OR (a.message_kind = 'weekend_league' AND NOT EXISTS (
            SELECT 1 FROM wl_tournaments t
            WHERE t.id = a.tournament_id
              AND t.status = 'entry_open'
              AND t.entry_closes_at > NOW()
          ))
        )
    `;
  },

  async claimOne(maxAttempts: number): Promise<RetentionEmailAssignment | null> {
    const [row] = await sql<RetentionEmailAssignment[]>`
      WITH candidate AS (
        SELECT
          a.id,
          u.email,
          u.nickname,
          u.preferred_language,
          t.entry_closes_at,
          CASE
            WHEN t.config->>'qp_target' ~ '^[0-9]{1,6}$'
              THEN (t.config->>'qp_target')::int
            ELSE 200
          END AS qp_target,
          qp.balance
        FROM retention_email_assignments a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN wl_tournaments t ON t.id = a.tournament_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(award.points), 0)::int AS balance
          FROM wl_qp_awards award
          WHERE award.user_id = a.user_id
            AND award.created_at > COALESCE(
              (SELECT MAX(r.reset_at) FROM wl_qp_resets r WHERE r.user_id = a.user_id),
              '-infinity'::timestamptz
            )
        ) qp
        WHERE a.variant = 'test'
          AND a.send_status = 'pending'
          AND a.attempts < ${maxAttempts}
          AND u.email IS NOT NULL
          AND BTRIM(u.email) <> ''
          AND u.is_ai = false
          AND u.is_seed = false
          AND u.is_deleted = false
          AND u.deleted_at IS NULL
          AND u.pending_deletion_at IS NULL
          AND u.is_banned = false
          AND UPPER(BTRIM(COALESCE(u.country, ''))) = 'GE'
          AND (
            a.message_kind = 'dormant_comeback'
            OR (t.status = 'entry_open' AND t.entry_closes_at > NOW())
          )
          AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = a.user_id)
          AND (
            a.message_kind = 'dormant_comeback'
            OR NOT EXISTS (
              SELECT 1 FROM wl_entries e
              WHERE e.tournament_id = a.tournament_id AND e.user_id = a.user_id
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM match_players mp
            JOIN matches m ON m.id = mp.match_id
            WHERE mp.user_id = a.user_id
              AND m.is_dev = false
              AND m.started_at > a.assigned_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM wl_email_log legacy
            WHERE legacy.user_id = a.user_id
              AND legacy.sent_at > a.assigned_at
          )
        ORDER BY a.assigned_at, a.id
        FOR UPDATE OF a SKIP LOCKED
        LIMIT 1
      )
      UPDATE retention_email_assignments a
      SET send_status = 'sending',
          attempts = a.attempts + 1,
          last_attempt_at = NOW(),
          cta_state = CASE
            WHEN a.message_kind = 'weekend_league'
              THEN CASE WHEN candidate.balance >= candidate.qp_target THEN 'qualified' ELSE 'qualifying' END
            ELSE a.cta_state
          END,
          destination_path = CASE
            WHEN a.message_kind = 'weekend_league'
              THEN CASE WHEN candidate.balance >= candidate.qp_target THEN '/weekend-league' ELSE '/play' END
            ELSE a.destination_path
          END,
          qp_remaining = CASE
            WHEN a.message_kind = 'weekend_league'
              THEN GREATEST(0, candidate.qp_target - candidate.balance)::int
            ELSE a.qp_remaining
          END
      FROM candidate
      WHERE a.id = candidate.id
      RETURNING a.*, candidate.email, candidate.nickname,
                candidate.preferred_language, candidate.entry_closes_at::text
    `;
    return row ?? null;
  },

  async markDelivery(input: {
    assignmentId: string;
    accepted: boolean;
    providerMessageId: string | null;
    maxAttempts: number;
  }): Promise<void> {
    await sql`
      UPDATE retention_email_assignments
      SET send_status = CASE
            WHEN ${input.accepted} THEN 'sent'
            WHEN attempts >= ${input.maxAttempts} THEN 'failed'
            ELSE 'pending'
          END,
          sent_at = CASE WHEN ${input.accepted} THEN NOW() ELSE sent_at END,
          provider_message_id = CASE
            WHEN ${input.accepted} THEN ${input.providerMessageId}
            ELSE provider_message_id
          END,
          cancel_reason = CASE
            WHEN NOT ${input.accepted} AND attempts >= ${input.maxAttempts} THEN 'attempt_limit'
            ELSE cancel_reason
          END
      WHERE id = ${input.assignmentId}
        AND send_status = 'sending'
    `;
  },

  async getClickAssignment(id: string): Promise<RetentionEmailClickAssignment | null> {
    const [row] = await sql<RetentionEmailClickAssignment[]>`
      SELECT id, user_id, campaign_key, variant, message_kind, cta_state,
             destination_path, send_status, clicked_at::text
      FROM retention_email_assignments
      WHERE id = ${id}
      LIMIT 1
    `;
    return row ?? null;
  },

  async markClicked(id: string): Promise<{ clicked_at: string; first_click: boolean } | null> {
    const [row] = await sql<Array<{ clicked_at: string; first_click: boolean }>>`
      WITH target AS (
        SELECT id, (clicked_at IS NULL) AS first_click
        FROM retention_email_assignments
        WHERE id = ${id}
          AND variant = 'test'
          AND send_status = 'sent'
        FOR UPDATE
      )
      UPDATE retention_email_assignments a
      SET clicked_at = COALESCE(a.clicked_at, NOW())
      FROM target
      WHERE a.id = target.id
      RETURNING a.clicked_at::text, target.first_click
    `;
    return row ?? null;
  },

  async markUnsubscribed(input: {
    assignmentId: string;
    userId: string;
  }): Promise<RetentionEmailUnsubscribeAttribution | null> {
    const [row] = await sql<RetentionEmailUnsubscribeAttribution[]>`
      UPDATE retention_email_assignments
      SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
      WHERE id = ${input.assignmentId}
        AND user_id = ${input.userId}
      RETURNING user_id, campaign_key, variant, assigned_at::text
    `;
    return row ?? null;
  },

  async applyProviderEvent(input: {
    eventId: string;
    eventType: 'email.delivered' | 'email.delivery_delayed' | 'email.bounced'
      | 'email.failed' | 'email.suppressed' | 'email.complained' | 'email.opened';
    providerMessageId: string;
    occurredAt: string;
  }): Promise<RetentionEmailProviderAttribution | null> {
    const deliveryStatus = input.eventType === 'email.opened'
      ? null
      : input.eventType.replace('email.', '').replace('delivery_', '') as
        | 'delivered' | 'delayed' | 'bounced' | 'failed' | 'suppressed' | 'complained';
    const [row] = await sql<RetentionEmailProviderAttribution[]>`
      WITH matched AS (
        SELECT id, user_id
        FROM retention_email_assignments
        WHERE provider_message_id = ${input.providerMessageId}
          AND variant = 'test'
          AND send_status = 'sent'
        LIMIT 1
      ), inserted AS (
        INSERT INTO email_provider_webhook_events (
          provider,
          event_id,
          event_type,
          provider_message_id,
          occurred_at
        )
        SELECT 'resend', ${input.eventId}, ${input.eventType},
               ${input.providerMessageId}, ${input.occurredAt}::timestamptz
        FROM matched
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING event_id
      ), updated AS (
        UPDATE retention_email_assignments a
        SET delivery_status = CASE
              WHEN ${input.eventType} = 'email.opened' THEN a.delivery_status
              WHEN a.delivery_status_at IS NULL
                OR ${input.occurredAt}::timestamptz >= a.delivery_status_at
                THEN ${deliveryStatus}
              ELSE a.delivery_status
            END,
            delivery_status_at = CASE
              WHEN ${input.eventType} = 'email.opened' THEN a.delivery_status_at
              ELSE GREATEST(
                COALESCE(a.delivery_status_at, '-infinity'::timestamptz),
                ${input.occurredAt}::timestamptz
              )
            END,
            delivered_at = CASE
              WHEN ${input.eventType} = 'email.delivered'
                THEN GREATEST(
                  COALESCE(a.delivered_at, '-infinity'::timestamptz),
                  ${input.occurredAt}::timestamptz
                )
              ELSE a.delivered_at
            END,
            delivery_failed_at = CASE
              WHEN ${input.eventType} IN ('email.bounced', 'email.failed', 'email.suppressed', 'email.complained')
                THEN GREATEST(
                  COALESCE(a.delivery_failed_at, '-infinity'::timestamptz),
                  ${input.occurredAt}::timestamptz
                )
              ELSE a.delivery_failed_at
            END,
            opened_at = CASE
              WHEN ${input.eventType} = 'email.opened'
                THEN COALESCE(a.opened_at, ${input.occurredAt}::timestamptz)
              ELSE a.opened_at
            END,
            open_count = a.open_count + CASE
              WHEN ${input.eventType} = 'email.opened' THEN 1
              ELSE 0
            END
        FROM matched, inserted
        WHERE a.id = matched.id
        RETURNING a.id, a.user_id, a.campaign_key, a.variant,
                  a.message_kind, a.cta_state, a.destination_path
      ), suppressed AS (
        INSERT INTO email_unsubscribes (user_id, source)
        SELECT user_id, ${`resend:${deliveryStatus}`}
        FROM updated
        WHERE ${input.eventType} IN ('email.bounced', 'email.suppressed', 'email.complained')
        ON CONFLICT (user_id) DO NOTHING
      )
      SELECT * FROM updated
    `;
    return row ?? null;
  },
};
