import { trackEvent } from '../../core/analytics.js';
import { config } from '../../core/config.js';
import {
  emailEnabled,
  marketingEmailHeaders,
  sendEmail,
  unsubscribeUrl,
} from '../../core/email.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';

const TICK_MS = 60_000;
const MAX_ATTEMPTS = 5;
const CLAIM_STALE_AFTER_MINUTES = 10;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

type ClaimedReminder = {
  user_id: string;
  email: string | null;
  attempts: number;
  remind_at: string;
};

function reminderHtml(userId: string): string {
  const unsub = unsubscribeUrl(userId);
  return `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111">
      <div style="font-size:28px;margin-bottom:8px">🔥</div>
      <h2 style="margin:0 0 8px">დღის გამოწვევა გელოდება</h2>
      <p style="margin:0 0 20px;line-height:1.5;color:#444">შეინარჩუნე სერია და ითამაშე დღევანდელი გამოწვევა.</p>
      <h3 style="margin:0 0 6px;color:#777">Your Daily Challenge is ready</h3>
      <p style="margin:0 0 20px;line-height:1.5;color:#777">Keep your streak alive with today’s challenge.</p>
      <a href="https://quizball.io/daily/challenges?utm_source=daily_reminder&utm_medium=email&utm_campaign=daily_comeback"
         style="display:inline-block;background:#38b60e;color:white;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700">
        ითამაშე · Play now
      </a>${unsub ? `
      <p style="margin:20px 0 0;font-size:12px"><a href="${unsub}" style="color:#aaa">გამოწერის გაუქმება · Unsubscribe</a></p>` : ''}
    </div>`;
}

async function recoverStaleClaims(): Promise<void> {
  await sql`
    UPDATE daily_challenge_reminders
    SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END
    WHERE status = 'sending'
      AND last_attempt_at < NOW() - make_interval(mins => ${CLAIM_STALE_AFTER_MINUTES})
  `;
}

async function claimOne(): Promise<ClaimedReminder | null> {
  const [row] = await sql<ClaimedReminder[]>`
    WITH candidate AS (
      SELECT r.user_id
      FROM daily_challenge_reminders r
      JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending'
        AND r.remind_at <= NOW()
        AND r.attempts < ${MAX_ATTEMPTS}
        AND u.email IS NOT NULL
        AND u.is_ai = false
        AND u.is_seed = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
        AND NOT EXISTS (
          SELECT 1 FROM email_unsubscribes x WHERE x.user_id = r.user_id
        )
      ORDER BY r.remind_at, r.user_id
      FOR UPDATE OF r SKIP LOCKED
      LIMIT 1
    )
    UPDATE daily_challenge_reminders r
    SET status = 'sending',
        attempts = r.attempts + 1,
        last_attempt_at = NOW()
    FROM candidate c, users u
    WHERE r.user_id = c.user_id
      AND u.id = r.user_id
    RETURNING r.user_id, u.email, r.attempts, r.remind_at
  `;
  return row ?? null;
}

async function deliverClaim(claim: ClaimedReminder): Promise<void> {
  if (!claim.email) return;
  const delivered = await sendEmail({
    to: claim.email,
    subject: 'დღის გამოწვევა გელოდება · Your Daily Challenge is ready',
    html: reminderHtml(claim.user_id),
    idempotencyKey: `daily-comeback:${claim.user_id}:${claim.remind_at.slice(0, 10)}`,
    headers: marketingEmailHeaders(claim.user_id),
  });

  await sql`
    UPDATE daily_challenge_reminders
    SET status = ${delivered ? 'sent' : claim.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'},
        sent_at = ${delivered ? new Date() : null}
    WHERE user_id = ${claim.user_id}
      AND status = 'sending'
  `;

  trackEvent(
    delivered ? 'daily_challenge_reminder_sent' : 'daily_challenge_reminder_failed',
    claim.user_id,
    { channel: 'email', attempt: claim.attempts },
  );
}

async function tick(): Promise<void> {
  if (!config.DAILY_REMINDERS_ENABLED || !emailEnabled()) return;
  await recoverStaleClaims();
  for (let count = 0; count < 20; count += 1) {
    const claim = await claimOne();
    if (!claim) break;
    await deliverClaim(claim);
  }
}

export function startDailyComebackReminderWorker(): void {
  if (timer || !config.DAILY_REMINDERS_ENABLED) return;
  logger.info('Daily comeback reminder worker started');
  const run = () => {
    if (inFlight) return;
    inFlight = tick()
      .catch((error) => logger.error({ error }, 'Daily comeback reminder tick failed'))
      .finally(() => { inFlight = null; });
  };
  run();
  timer = setInterval(run, TICK_MS);
  timer.unref?.();
}

export async function stopDailyComebackReminderWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
