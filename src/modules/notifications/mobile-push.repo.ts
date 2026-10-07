import { sql } from '../../db/index.js';
import { config } from '../../core/config.js';
import type { Json } from '../../db/types.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { encryptPushToken, pushTokenFingerprint, pushFingerprintKeyIdentity } from './mobile-push.crypto.js';
import type { PushDeviceInput, PushUnregisterInput, PushPreferences, PushPreferencesUpdate, PushCampaignInput } from './mobile-push.schemas.js';

interface PreferenceRow {
  match_invites_enabled: boolean; daily_reminders_enabled: boolean; new_games_enabled: boolean;
  daily_reminder_hour: number; timezone: string;
}
function preferences(row?: PreferenceRow): PushPreferences {
  return { matchInvitesEnabled: row?.match_invites_enabled ?? false, dailyRemindersEnabled: row?.daily_reminders_enabled ?? false,
    newGamesEnabled: row?.new_games_enabled ?? false, dailyReminderHour: row?.daily_reminder_hour ?? 19, timezone: row?.timezone ?? 'UTC' };
}
export interface PushJob {
  id: string; event_id: string; device_id: string; device_generation: number; lease_token: string;
  attempts: number; ticket_id: string | null; receipt_checks: number;
}
export interface PushPayload {
  token_encrypted: string; locale: 'en'|'ka'|'es'|'tr'; title: Record<string,string>; body: Record<string,string>;
  route: string; user_id: string; category: 'daily'|'new_games'|'test'; expires_at: Date;
}
const reminderTitle = { en: 'Your daily games are ready', ka: 'დღის თამაშები გელოდება', es: 'Tus juegos diarios están listos', tr: 'Günlük oyunların hazır' };
const reminderBody = { en: 'Take a football quiz break. Play today’s challenges.', ka: 'შეისვენე ფეხბურთის ქვიზით — ითამაშე დღევანდელი გამოწვევები.',
  es: 'Haz una pausa con fútbol. Juega los retos de hoy.', tr: 'Futbol bilgini test et. Bugünün görevlerini oyna.' };

export const mobilePushRepo = {
  async ensureProviderKey() {
    const identity = pushFingerprintKeyIdentity();
    const [row] = await sql`INSERT INTO mobile_push_provider_state(id,fingerprint_key_identity) VALUES('expo',${identity})
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id RETURNING fingerprint_key_identity`;
    if (row.fingerprint_key_identity !== identity) throw Object.assign(
      new Error('Push fingerprint key changed; use the documented migration procedure, not a silent rotation'),
      {code:'PUSH_FINGERPRINT_KEY_CHANGED'});
  },
  async providerBlocked() {
    const [row] = await sql`SELECT backoff_until > now() AS blocked FROM mobile_push_provider_state WHERE id='expo'`;
    return !row || row.blocked;
  },
  async backoffProvider(code:string, seconds:number) {
    await sql`UPDATE mobile_push_provider_state SET backoff_until=GREATEST(backoff_until,now()+make_interval(secs=>${seconds})),error_code=${code} WHERE id='expo'`;
  },
  async register(userId: string, input: PushDeviceInput) {
    await this.ensureProviderKey();
    const fingerprint = pushTokenFingerprint(input.expoPushToken), encrypted = encryptPushToken(input.expoPushToken);
    return sql.begin(async transaction => {
      // postgres.js transactions are callable tags at runtime; its Omit-based
      // TransactionSql declaration loses that call signature in this TS version.
      const tx = transaction as unknown as typeof sql;
      // Per-token lock handles first registration as well as owner A → B → A.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`;
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const [zone] = await tx`SELECT name FROM pg_timezone_names WHERE name = ${input.timezone}`;
      if (!zone) throw new AppError('Unsupported timezone', 422, ErrorCode.VALIDATION_ERROR);
      const [existing] = await tx<{ id: string; user_id: string; active: boolean; client_revision: string }[]>`SELECT id, user_id, active, client_revision FROM mobile_push_devices WHERE token_fingerprint = ${fingerprint} FOR UPDATE`;
      if (existing && Number(existing.client_revision) >= input.clientRevision) {
        return Number(existing.client_revision) === input.clientRevision && existing.user_id === userId && existing.active;
      }
      const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM mobile_push_devices WHERE user_id = ${userId} AND active`;
      if ((!existing || existing.user_id !== userId || !existing.active) && count.count >= 5) {
        throw new AppError('Push device limit reached', 409, ErrorCode.CONFLICT);
      }
      if (existing && (existing.user_id !== userId || !existing.active)) {
        await tx`UPDATE mobile_push_jobs SET status = 'cancelled', lease_token = NULL WHERE device_id = ${existing.id} AND status IN ('pending','sending')`;
      }
      await tx`INSERT INTO mobile_push_devices(user_id, token_fingerprint, token_encrypted, platform, locale, timezone, client_revision)
        VALUES(${userId},${fingerprint},${encrypted},${input.platform},${input.locale},${input.timezone},${input.clientRevision})
        ON CONFLICT(token_fingerprint) DO UPDATE SET
          generation = mobile_push_devices.generation + CASE WHEN mobile_push_devices.user_id <> EXCLUDED.user_id OR NOT mobile_push_devices.active THEN 1 ELSE 0 END,
          user_id = EXCLUDED.user_id, token_encrypted = EXCLUDED.token_encrypted, platform = EXCLUDED.platform,
          locale = EXCLUDED.locale, timezone = EXCLUDED.timezone, client_revision = EXCLUDED.client_revision, active = true, last_seen_at = now()`;
      await tx`INSERT INTO mobile_push_preferences(user_id, timezone) VALUES(${userId},${input.timezone})
        ON CONFLICT(user_id) DO NOTHING`;
      return true;
    });
  },
  async unregister(userId: string, input: PushUnregisterInput) {
    await this.ensureProviderKey();
    const fingerprint = pushTokenFingerprint(input.expoPushToken);
    await sql.begin(async transaction => {
      const tx = transaction as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`;
      // An inactive tombstone also handles unregister arriving BEFORE the
      // older register request. Do not remove it while that request can live.
      const rows = await tx<{ id: string }[]>`INSERT INTO mobile_push_devices(user_id,token_fingerprint,token_encrypted,platform,locale,active,client_revision)
        VALUES(${userId},${fingerprint},'',${input.platform},'en',false,${input.clientRevision})
        ON CONFLICT(token_fingerprint) DO UPDATE SET active=false,generation=mobile_push_devices.generation+1,
          token_encrypted='',last_seen_at=now(),client_revision=EXCLUDED.client_revision
        WHERE mobile_push_devices.user_id=EXCLUDED.user_id AND mobile_push_devices.client_revision < EXCLUDED.client_revision RETURNING id`;
      for (const row of rows) await tx`UPDATE mobile_push_jobs SET status = 'cancelled', lease_token = NULL WHERE device_id = ${row.id} AND status IN ('pending','sending')`;
    });
  },
  async getPreferences(userId: string) {
    const [row] = await sql<PreferenceRow[]>`SELECT * FROM mobile_push_preferences WHERE user_id = ${userId}`;
    return preferences(row);
  },
  async updatePreferences(userId: string, input: PushPreferencesUpdate) {
    return sql.begin(async transaction => {
      const tx = transaction as unknown as typeof sql;
      await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      if (input.timezone) {
        const [zone] = await tx`SELECT name FROM pg_timezone_names WHERE name = ${input.timezone}`;
        if (!zone) throw new AppError('Unsupported timezone', 422, ErrorCode.VALIDATION_ERROR);
      }
      await tx`INSERT INTO mobile_push_preferences(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
      const [row] = await tx<PreferenceRow[]>`UPDATE mobile_push_preferences SET
        match_invites_enabled = COALESCE(${input.matchInvitesEnabled ?? null}, match_invites_enabled),
        daily_reminders_enabled = COALESCE(${input.dailyRemindersEnabled ?? null}, daily_reminders_enabled),
        new_games_enabled = COALESCE(${input.newGamesEnabled ?? null}, new_games_enabled),
        daily_reminder_hour = COALESCE(${input.dailyReminderHour ?? null}, daily_reminder_hour),
        timezone = COALESCE(${input.timezone ?? null}, timezone), consent_epoch = consent_epoch + 1, updated_at = now()
        WHERE user_id = ${userId} RETURNING *`;
      await tx`INSERT INTO mobile_push_consent_log(user_id, choices) VALUES(${userId},${tx.json(input as Json)})`;
      await tx`UPDATE mobile_push_jobs j SET status = 'cancelled', lease_token = NULL FROM mobile_push_events e
        WHERE e.id = j.event_id AND e.user_id = ${userId} AND e.category <> 'test' AND j.status IN ('pending','sending')`;
      return preferences(row);
    });
  },
  async previewCampaign() {
    const [row] = await sql<{ users: number; devices: number; alreadyCapped: number }[]>`SELECT
      count(DISTINCT u.id) FILTER(WHERE NOT EXISTS(SELECT 1 FROM mobile_push_events e WHERE e.user_id=u.id AND e.category='new_games' AND e.local_day=(now() AT TIME ZONE p.timezone)::date))::int AS users,
      count(d.id) FILTER(WHERE NOT EXISTS(SELECT 1 FROM mobile_push_events e WHERE e.user_id=u.id AND e.category='new_games' AND e.local_day=(now() AT TIME ZONE p.timezone)::date))::int AS devices,
      count(DISTINCT u.id) FILTER(WHERE EXISTS(SELECT 1 FROM mobile_push_events e WHERE e.user_id=u.id AND e.category='new_games' AND e.local_day=(now() AT TIME ZONE p.timezone)::date))::int AS "alreadyCapped"
      FROM mobile_push_preferences p JOIN users u ON u.id = p.user_id JOIN mobile_push_devices d ON d.user_id = u.id AND d.active
      WHERE p.new_games_enabled AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_banned AND NOT u.is_deleted
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL AND (to_jsonb(u)->>'partner_slug') IS NULL AND u.role::text <> 'partner_staff'`;
    return row;
  },
  async queueTest(userId:string) {
    return sql.begin(async transaction=>{
      const tx = transaction as unknown as typeof sql;
      const [event]=await tx<{id:string}[]>`INSERT INTO mobile_push_events(user_id,category,local_day,source_key,consent_epoch,title,body,route,expires_at)
        SELECT p.user_id,'test',CURRENT_DATE,gen_random_uuid()::text,p.consent_epoch,
          ${tx.json({en:'Quizball push test',ka:'Quizball შეტყობინების ტესტი',es:'Prueba de Quizball',tr:'Quizball bildirim testi'})},
          ${tx.json({en:'Tap to open your daily games.',ka:'შეეხე დღის თამაშების გასახსნელად.',es:'Toca para abrir tus juegos diarios.',tr:'Günlük oyunlarını açmak için dokun.'})},
          '/(tabs)',now()+interval '10 minutes' FROM mobile_push_preferences p WHERE p.user_id=${userId} RETURNING id`;
      if (!event) return {queued:0};
      const jobs=await tx`INSERT INTO mobile_push_jobs(event_id,device_id,device_generation)
        SELECT ${event.id},d.id,d.generation FROM mobile_push_devices d WHERE d.user_id=${userId} AND d.active RETURNING id`;
      return {queued:jobs.length};
    });
  },
  async queueCampaign(creatorId: string, input: PushCampaignInput) {
    // Keep old operator requests compatible, but never queue the retired hub.
    const route = input.route === '/(app)/daily/challenges' ? '/(tabs)' : input.route;
    return sql.begin(async transaction => {
      const tx = transaction as unknown as typeof sql;
      const inserted = await tx`INSERT INTO mobile_push_campaigns(id, created_by, title, body, route)
        VALUES(${input.campaignId},${creatorId},${tx.json(input.title)},${tx.json(input.body)},${route}) ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted.length) return { queued: 0, duplicate: true };
      const events = await tx`INSERT INTO mobile_push_events(user_id, category, local_day, source_key, consent_epoch, title, body, route, expires_at)
        SELECT p.user_id, 'new_games', (now() AT TIME ZONE p.timezone)::date, ${input.campaignId}, p.consent_epoch,
          ${tx.json(input.title)},${tx.json(input.body)},${route}, now() + interval '24 hours'
        FROM mobile_push_preferences p JOIN users u ON u.id = p.user_id
        WHERE p.new_games_enabled AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_banned
          AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL AND (to_jsonb(u)->>'partner_slug') IS NULL AND u.role::text <> 'partner_staff'
          AND EXISTS(SELECT 1 FROM mobile_push_devices d WHERE d.user_id = p.user_id AND d.active)
        ON CONFLICT DO NOTHING RETURNING id`;
      const jobs=await tx`INSERT INTO mobile_push_jobs(event_id, device_id, device_generation)
        SELECT e.id,d.id,d.generation FROM mobile_push_events e JOIN mobile_push_devices d ON d.user_id = e.user_id AND d.active
        WHERE e.source_key = ${input.campaignId} ON CONFLICT DO NOTHING RETURNING id`;
      // Fail the entire transaction rather than silently excluding recipients
      // or accepting an audience beyond the verified initial worker budget.
      if (jobs.length > config.PUSH_CAMPAIGN_MAX_DEVICES) throw new AppError('Campaign audience exceeds the verified push capacity',422,ErrorCode.VALIDATION_ERROR);
      return { queued: events.length, duplicate: false };
    });
  },
  async queueReminders(allowedUsers?:string[]) {
    await sql.begin(async transaction => {
      const tx = transaction as unknown as typeof sql;
      await tx`INSERT INTO mobile_push_events(user_id,category,local_day,source_key,consent_epoch,title,body,route,expires_at)
        SELECT p.user_id,'daily',(now() AT TIME ZONE p.timezone)::date, 'daily:' || (now() AT TIME ZONE p.timezone)::date,
          p.consent_epoch,${tx.json(reminderTitle)},${tx.json(reminderBody)},'/(tabs)',
          LEAST(now() + interval '2 hours', (((now() AT TIME ZONE p.timezone)::date + make_interval(hours => p.daily_reminder_hour) + interval '2 hours') AT TIME ZONE p.timezone))
        FROM mobile_push_preferences p JOIN users u ON u.id = p.user_id
        WHERE p.daily_reminders_enabled AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_banned
          AND (${allowedUsers === undefined} OR p.user_id=ANY(${allowedUsers ?? []}::uuid[]))
          AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL AND (to_jsonb(u)->>'partner_slug') IS NULL AND u.role::text <> 'partner_staff'
          AND now() AT TIME ZONE p.timezone >= (now() AT TIME ZONE p.timezone)::date + make_interval(hours => p.daily_reminder_hour)
          AND now() AT TIME ZONE p.timezone < (now() AT TIME ZONE p.timezone)::date + make_interval(hours => p.daily_reminder_hour) + interval '2 hours'
          AND EXISTS(SELECT 1 FROM daily_challenge_configs WHERE is_active)
          AND EXISTS(SELECT 1 FROM mobile_push_devices d WHERE d.user_id = p.user_id AND d.active)
          AND NOT EXISTS(SELECT 1 FROM daily_challenge_completions c WHERE c.user_id = p.user_id AND c.challenge_day = (now() AT TIME ZONE 'UTC')::date)
          AND NOT EXISTS(SELECT 1 FROM daily_challenge_reminders r WHERE r.user_id = p.user_id AND r.status = 'sent' AND r.sent_at >= now() - interval '24 hours')
        ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO mobile_push_jobs(event_id,device_id,device_generation)
        SELECT e.id,d.id,d.generation FROM mobile_push_events e JOIN mobile_push_devices d ON d.user_id = e.user_id AND d.active
        WHERE e.category = 'daily' AND e.created_at > now() - interval '3 hours' AND e.expires_at > now()
          AND (${allowedUsers === undefined} OR e.user_id=ANY(${allowedUsers ?? []}::uuid[])) ON CONFLICT DO NOTHING`;
    });
  },
  async claim(receipts = false): Promise<PushJob | null> {
    const [job] = await sql<PushJob[]>`WITH candidate AS (
      SELECT j.id FROM mobile_push_jobs j JOIN mobile_push_events e ON e.id = j.event_id
      WHERE j.status = ${receipts ? 'ticketed' : 'pending'} AND j.next_attempt_at <= now()
        AND (j.lease_until IS NULL OR j.lease_until < now())
        AND CASE WHEN ${receipts} THEN j.ticketed_at > now() - interval '23 hours' ELSE e.expires_at > now() END
      ORDER BY CASE e.category WHEN 'test' THEN 0 WHEN 'daily' THEN 1 ELSE 2 END,
        e.expires_at,j.next_attempt_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
      UPDATE mobile_push_jobs j SET lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes',
        status = ${receipts ? 'ticketed' : 'sending'}, attempts = attempts + ${receipts ? 0 : 1}, receipt_checks = receipt_checks + ${receipts ? 1 : 0}
      FROM candidate c WHERE j.id = c.id RETURNING j.*`;
    return job ?? null;
  },
  async payload(job: PushJob): Promise<PushPayload | null> {
    const [row] = await sql<PushPayload[]>`SELECT d.token_encrypted,d.locale,e.title,e.body,e.route,e.user_id,e.category,e.expires_at
      FROM mobile_push_jobs j JOIN mobile_push_events e ON e.id = j.event_id
      JOIN mobile_push_devices d ON d.id = j.device_id JOIN users u ON u.id = e.user_id
      JOIN mobile_push_preferences p ON p.user_id = e.user_id
      WHERE j.id = ${job.id} AND j.lease_token = ${job.lease_token} AND d.active AND d.user_id = e.user_id
        AND d.generation = j.device_generation AND e.expires_at > now()
        AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_deleted AND NOT u.is_banned AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL AND (to_jsonb(u)->>'partner_slug') IS NULL AND u.role::text <> 'partner_staff'
        AND (e.category = 'test' OR (p.consent_epoch = e.consent_epoch AND
          ((e.category = 'daily' AND p.daily_reminders_enabled) OR (e.category = 'new_games' AND p.new_games_enabled))))`;
    return row ?? null;
  },
  async settle(job: PushJob, status: string, code: string | null = null, ticket: string | null = null, delaySeconds = 0) {
    await sql`UPDATE mobile_push_jobs SET status = ${status}, error_code = ${code}, ticket_id = COALESCE(${ticket},ticket_id),
      ticketed_at=CASE WHEN ${ticket !== null} THEN now() ELSE ticketed_at END,
      lease_token = NULL, lease_until = NULL, next_attempt_at = now() + make_interval(secs => ${delaySeconds})
      WHERE id = ${job.id} AND lease_token = ${job.lease_token}`;
  },
  async disable(job: PushJob) {
    await sql`UPDATE mobile_push_devices SET active = false, token_encrypted = '', generation = generation + 1
      WHERE id = ${job.device_id} AND generation = ${job.device_generation}
        AND EXISTS(SELECT 1 FROM mobile_push_jobs j WHERE j.id=${job.id} AND j.lease_token=${job.lease_token} AND j.lease_until>now())`;
  },
  async defer(job:PushJob, delaySeconds:number, code:string|null=null) {
    await sql`UPDATE mobile_push_jobs SET status='pending', attempts=GREATEST(0,attempts-1),
      lease_token=NULL,lease_until=NULL,next_attempt_at=now()+make_interval(secs=>${delaySeconds}),error_code=COALESCE(${code},error_code)
      WHERE id=${job.id} AND lease_token=${job.lease_token}`;
  },
  async maintain(retention = false) {
    // A timed-out send is ambiguous; retry at least once, bounded by attempts,
    // expiry and a stable collapse id. Expo cannot guarantee exactly-once.
    await sql`UPDATE mobile_push_jobs SET status = CASE WHEN attempts >= 6 THEN 'unknown' ELSE 'pending' END,
      error_code = 'LEASE_EXPIRED_AMBIGUOUS', lease_token = NULL, lease_until = NULL, next_attempt_at = now() + interval '30 seconds'
      WHERE status = 'sending' AND lease_until < now()`;
    await sql`UPDATE mobile_push_jobs j SET status = CASE WHEN ticket_id IS NOT NULL THEN 'unknown' ELSE 'cancelled' END,
      lease_token = NULL, lease_until = NULL FROM mobile_push_events e WHERE e.id = j.event_id
      AND ((e.expires_at <= now() AND j.status IN ('pending','sending'))
        OR (j.ticketed_at <= now() - interval '23 hours' AND j.status = 'ticketed'))`;
    if (retention) {
      await sql`DELETE FROM mobile_push_events WHERE created_at < now() - interval '30 days'`;
      await sql`DELETE FROM mobile_push_devices WHERE last_seen_at < now() - interval '90 days'`;
    }
  },
};
