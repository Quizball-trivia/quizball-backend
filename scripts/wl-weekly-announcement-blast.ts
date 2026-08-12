/**
 * One-off announcement blast: "the Weekend League runs every week" to every
 * real user with an email address. Owner-approved template 2026-08-11.
 *
 * Resumable and idempotent per recipient through wl_email_log under a fixed
 * source_event_key — re-running skips everyone already sent. Eligibility is
 * re-read in small batches during the ~50-minute run (an unsubscribe or
 * account deletion mid-run takes effect), duplicate addresses across
 * accounts get one copy, 5 consecutive provider failures abort the run
 * (quota/outage — investigate, then re-run to resume), and the content is
 * dated: the script refuses to run after entry closes for the Aug-15 event.
 *
 * Usage:
 *   npx tsx scripts/wl-weekly-announcement-blast.ts --dry-run   # count + masked sample
 *   npx tsx scripts/wl-weekly-announcement-blast.ts --limit 10  # canary
 *   npx tsx scripts/wl-weekly-announcement-blast.ts             # full send
 *
 * Run with prod env (DATABASE_URL pooler + RESEND_API_KEY + EMAIL_FROM +
 * SUPABASE_JWT_SECRET or EMAIL_UNSUB_SECRET for unsubscribe links).
 */
import { sql } from '../src/db/index.js';
import { sendEmail, emailEnabled, unsubscribeUrl, marketingEmailHeaders } from '../src/core/email.js';

const BLAST_KEY = 'blast:wl-weekly-2026-08-11';
const SUBJECT = 'უიქენდის ლიგა ყოველ შაბათ-კვირას — შენც ითამაშე! 🏆';
const EXPIRES_AT = Date.parse('2026-08-14T08:00:00Z');
const BATCH_SIZE = 200;
const SEND_INTERVAL_MS = 550;
const MAX_CONSECUTIVE_FAILURES = 5;

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
let LIMIT = Infinity;
if (limitArg > -1) {
  const parsed = Number(process.argv[limitArg + 1]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--limit requires a positive integer, got: ${process.argv[limitArg + 1]}`);
    process.exit(1);
  }
  LIMIT = parsed;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local ?? '').slice(0, 2)}***@${domain ?? ''}`;
}

function html(unsubUrl: string): string {
  return `
  <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 28px 20px;">
    <div style="font-size: 30px; margin-bottom: 10px;">🏆</div>
    <h2 style="margin: 0 0 8px; color: #111; font-size: 22px;">უიქენდის ლიგა უკვე ყოველ კვირაა!</h2>
    <p style="margin: 0 0 18px; color: #444; line-height: 1.55;">
      ყოველ შაბათს 14:00-ზე კვალიფიკაცია, კვირას 14:00-ზე — ფინალი.
      საუკეთესო სამეული ჩემპიონის მედლებს იღებს, რომლებიც პროფილზე სამუდამოდ რჩება.
    </p>
    <div style="background: #f6f8f6; border-radius: 12px; padding: 14px 16px; margin: 0 0 18px;">
      <p style="margin: 0 0 10px; color: #111; line-height: 1.5;"><b style="color:#38B60E;">1.</b>&nbsp; ითამაშე რანკედი კვირის განმავლობაში და დააგროვე <b>200 QP</b></p>
      <p style="margin: 0 0 10px; color: #111; line-height: 1.5;"><b style="color:#38B60E;">2.</b>&nbsp; დარეგისტრირდი ივენთების გვერდზე — რეგისტრაცია იხურება <b>პარასკევს 12:00-ზე</b></p>
      <p style="margin: 0; color: #111; line-height: 1.5;"><b style="color:#38B60E;">3.</b>&nbsp; შაბათ-კვირას გაიარე ჩექინი <b>13:50–14:00</b> და ითამაშე ⚽</p>
    </div>
    <p style="margin: 0 0 20px; color: #444; line-height: 1.5;">
      ამ კვირას: <b>შაბათი, 15 აგვისტო</b> და <b>კვირა, 16 აგვისტო</b> — ჯერ კიდევ ასწრებ!
    </p>
    <a href="https://quizball.io/events" style="display: inline-block; background: #38B60E; color: #fff; padding: 13px 26px; border-radius: 10px; text-decoration: none; font-weight: 700;">ითამაშე</a>
    <h3 style="margin: 26px 0 4px; color: #888; font-weight: 600; font-size: 15px;">The Weekend League runs every week!</h3>
    <p style="margin: 0 0 16px; color: #888; line-height: 1.5; font-size: 14px;">
      Qualifiers every Saturday 14:00, the final on Sunday 14:00. Play ranked during the week to collect
      200 QP, register before Friday 12:00, check in 13:50–14:00 and play. Top 3 earn permanent champion
      medals. This week: Sat Aug 15 &amp; Sun Aug 16.
    </p>
    <p style="margin: 20px 0 0; color: #bbb; font-size: 12px; line-height: 1.5;">
      ამ მეილს იღებ, რადგან Quizball-ზე ანგარიში გაქვს. · You’re receiving this because you have a Quizball account.<br>
      <a href="${unsubUrl}" style="color: #bbb;">გამოწერის გაუქმება · Unsubscribe</a>
    </p>
  </div>`;
}

function nextBatch(): Promise<Array<{ user_id: string; email: string }>> {
  return sql<Array<{ user_id: string; email: string }>>`
    SELECT DISTINCT ON (lower(u.email)) u.id AS user_id, u.email
    FROM users u
    WHERE u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
      AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
      AND u.is_banned = false AND u.email IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = u.id)
      AND NOT EXISTS (
        SELECT 1 FROM wl_email_log l
        WHERE l.user_id = u.id AND l.source_event_key = ${BLAST_KEY}
          AND (l.sent_at IS NOT NULL OR l.attempts >= 5)
      )
      AND NOT EXISTS (
        SELECT 1 FROM wl_email_log l2
        JOIN users u2 ON u2.id = l2.user_id
        WHERE l2.source_event_key = ${BLAST_KEY} AND l2.sent_at IS NOT NULL
          AND u2.id <> u.id AND lower(u2.email) = lower(u.email)
      )
    ORDER BY lower(u.email), u.created_at
    LIMIT ${BATCH_SIZE}
  `;
}

async function recordAttempt(userId: string, ok: boolean): Promise<void> {
  await sql`
    INSERT INTO wl_email_log (user_id, source_event_key, sent_at, attempts)
    VALUES (${userId}, ${BLAST_KEY}, ${ok ? new Date() : null}, 1)
    ON CONFLICT (user_id, source_event_key) DO UPDATE SET
      sent_at = COALESCE(wl_email_log.sent_at, EXCLUDED.sent_at),
      attempts = wl_email_log.attempts + 1,
      last_attempt_at = now()
  `;
}

async function main(): Promise<void> {
  if (Date.now() > EXPIRES_AT) {
    console.error('This blast is dated (Aug 15-16 event) and entry has closed — refusing to send.');
    process.exit(1);
  }
  if (!DRY && !emailEnabled()) {
    console.error('RESEND_API_KEY not set — aborting');
    process.exit(1);
  }

  const [probe] = await sql<Array<{ id: string }>>`SELECT id FROM users LIMIT 1`;
  const probeUrl = probe ? unsubscribeUrl(probe.id) : null;
  if (!probeUrl) {
    console.error('No unsubscribe secret configured (SUPABASE_JWT_SECRET or EMAIL_UNSUB_SECRET, ≥32 chars) — refusing to send marketing email without an unsubscribe link.');
    process.exit(1);
  }

  if (DRY) {
    const [count] = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
      FROM users u
      WHERE u.is_ai = false AND u.is_seed = false AND u.is_deleted = false
        AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
        AND u.is_banned = false AND u.email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM email_unsubscribes x WHERE x.user_id = u.id)
        AND NOT EXISTS (
          SELECT 1 FROM wl_email_log l
          WHERE l.user_id = u.id AND l.source_event_key = ${BLAST_KEY}
            AND (l.sent_at IS NOT NULL OR l.attempts >= 5)
        )
    `;
    const sample = await nextBatch();
    console.log(`candidates: ${count?.n ?? 0} (key ${BLAST_KEY})`);
    console.log('sample:', sample.slice(0, 3).map((c) => maskEmail(c.email)));
    console.log('unsubscribe link: configured');
    await sql.end();
    return;
  }

  let sent = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const seenAddresses = new Set<string>();

  outer: for (;;) {
    if (Date.now() > EXPIRES_AT) {
      console.error(`entry-close cutoff passed mid-run — stopping. ${sent} sent, ${failed} failed.`);
      break;
    }
    const batch = await nextBatch();
    if (batch.length === 0) break;
    for (const c of batch) {
      if (sent + failed >= LIMIT) break outer;
      const address = c.email.toLowerCase();
      if (seenAddresses.has(address)) {
        await recordAttempt(c.user_id, true);
        continue;
      }
      const unsubUrl = unsubscribeUrl(c.user_id);
      if (!unsubUrl) {
        console.error('unsubscribe URL generation stopped working mid-run — aborting');
        process.exit(1);
      }
      const [optedOut] = await sql<Array<{ user_id: string }>>`
        SELECT user_id FROM email_unsubscribes WHERE user_id = ${c.user_id}
      `;
      if (optedOut) continue;
      const ok = await sendEmail({
        to: c.email,
        idempotencyKey: `${BLAST_KEY}:${c.user_id}`,
        subject: SUBJECT,
        html: html(unsubUrl),
        headers: marketingEmailHeaders(c.user_id),
      });
      await recordAttempt(c.user_id, ok);
      if (ok) {
        sent += 1;
        consecutiveFailures = 0;
        seenAddresses.add(address);
      } else {
        failed += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures (quota/outage?) — aborting; re-run to resume. ${sent} sent, ${failed} failed so far.`);
          await sql.end();
          process.exit(1);
        }
      }
      if ((sent + failed) % 100 === 0) console.log(`progress: ${sent} sent, ${failed} failed`);
      await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
    }
  }
  console.log(`done: ${sent} sent, ${failed} failed`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
