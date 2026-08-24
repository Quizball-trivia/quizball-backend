/**
 * One-off announcement blast: the Auction mode beta launch, to every real
 * user with an email address. Owner-approved copy 2026-08-24 (KA + EN, beta
 * framing with a feedback ask). Reply-To routes feedback into the inbox the
 * bug-triage pipeline already polls.
 *
 * Same machinery as wl-weekly-announcement-blast.ts: resumable and
 * idempotent per recipient via wl_email_log under a fixed source_event_key,
 * eligibility re-read per batch (mid-run unsubscribes take effect),
 * duplicate addresses collapsed, 5 consecutive provider failures abort
 * (re-run to resume). Safety cutoff a week out so a stale re-run can't fire.
 *
 * Usage:
 *   npx tsx scripts/auction-beta-announcement-blast.ts --dry-run
 *   npx tsx scripts/auction-beta-announcement-blast.ts --test-to a@b.com
 *   npx tsx scripts/auction-beta-announcement-blast.ts --limit 10
 *   npx tsx scripts/auction-beta-announcement-blast.ts
 */
import { sql } from '../src/db/index.js';
import { sendEmail, emailEnabled, unsubscribeUrl, marketingEmailHeaders } from '../src/core/email.js';

const BLAST_KEY = 'blast:auction-beta-2026-08-25';
const SUBJECT = '🔨 ახალი რეჟიმი Quizball-ზე — ტრანსფერების აუქციონი (ბეტა)!';
const EXPIRES_AT = Date.parse('2026-09-01T00:00:00Z');
const BATCH_SIZE = 200;
const SEND_INTERVAL_MS = 550;
const MAX_CONSECUTIVE_FAILURES = 5;
const REPLY_TO = 'nika@quizball.io';

const DRY = process.argv.includes('--dry-run');
const testToArg = process.argv.indexOf('--test-to');
const TEST_TO = testToArg > -1 ? process.argv[testToArg + 1] ?? null : null;
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
    <div style="font-size: 30px; margin-bottom: 10px;">🔨</div>
    <h2 style="margin: 0 0 8px; color: #111; font-size: 22px;">Quizball-ზე ახალი რეჟიმი დაემატა — აუქციონი!</h2>
    <p style="margin: 0 0 16px; color: #444; line-height: 1.55;">
      წარმოიდგინე, რომ შენი გუნდის მენეჯერი ხარ: აუქციონზე ფეხბურთელები მინიშნებების
      მიხედვით ამოდიან — გამოიცანი ვინ არის, აჯობე მეტოქეს ვაჭრობაში და ბიუჯეტი
      ჭკვიანურად დახარჯე. საბოლოოდ შენი 7-კაციანი ოცნების გუნდი ააწყვე და დაამტკიცე,
      რომ ფეხბურთი ყველაზე კარგად შენ იცი. 🏆
    </p>
    <div style="background: #f6f4fa; border-radius: 12px; padding: 14px 16px; margin: 0 0 16px;">
      <p style="margin: 0 0 10px; color: #111; line-height: 1.5;">🃏&nbsp; გამოიცანი ფეხბურთელი მინიშნებებით</p>
      <p style="margin: 0 0 10px; color: #111; line-height: 1.5;">💰&nbsp; ივაჭრე მეტოქის წინააღმდეგ რეალურ დროში</p>
      <p style="margin: 0; color: #111; line-height: 1.5;">🐐&nbsp; ააწყვე შენი საუკეთესო შვიდეული</p>
    </div>
    <p style="margin: 0 0 18px; color: #444; line-height: 1.55;">
      🧪 <b>რეჟიმი ჯერჯერობით ბეტა ვერსიაშია</b> — ერთი კვირის განმავლობაში სატესტო
      რეჟიმში იქნება და შენი აზრი ძალიან გვჭირდება: რა მოგწონს, რა შევცვალოთ, რა
      გავაუმჯობესოთ და რა ხარვეზი შეამჩნიე? მოგვწერე პირდაპირ ამ მეილზე პასუხით ან
      აპლიკაციაში უკუკავშირის ღილაკით — ყველა შეტყობინებას ვკითხულობთ. 🙏
    </p>
    <a href="https://quizball.io/play" style="display: inline-block; background: #6B2FB3; color: #fff; padding: 13px 26px; border-radius: 10px; text-decoration: none; font-weight: 700;">სცადე ახლავე</a>
    <h3 style="margin: 26px 0 4px; color: #888; font-weight: 600; font-size: 15px;">New on Quizball — the Transfer Auction (Beta)!</h3>
    <p style="margin: 0 0 16px; color: #888; line-height: 1.5; font-size: 14px;">
      Step into the manager's seat: footballers come up for auction described only by clue
      cards — figure out who they are, outbid your opponent in real time, and build your
      7-a-side dream squad. The mode runs in beta for a week and your feedback matters:
      what do you like, what should change, what bugs did you spot? Reply to this email or
      use the in-app feedback button — we read every message.
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
    console.error('Safety cutoff passed (beta launch week over) — refusing to send.');
    process.exit(1);
  }
  if (!DRY && !emailEnabled()) {
    console.error('RESEND_API_KEY not set — aborting');
    process.exit(1);
  }

  const [probe] = await sql<Array<{ id: string }>>`SELECT id FROM users LIMIT 1`;
  const probeUrl = probe ? unsubscribeUrl(probe.id) : null;
  if (!probeUrl) {
    console.error('No unsubscribe secret configured — refusing to send marketing email without an unsubscribe link.');
    process.exit(1);
  }

  if (TEST_TO) {
    const [user] = await sql<Array<{ id: string; email: string }>>`
      SELECT id, email FROM users WHERE lower(email) = lower(${TEST_TO}) LIMIT 1
    `;
    if (!user) {
      console.error(`--test-to: no user with email ${TEST_TO}`);
      process.exit(1);
    }
    const url = unsubscribeUrl(user.id);
    const ok = await sendEmail({
      to: user.email,
      subject: SUBJECT,
      html: html(url!),
      headers: { ...marketingEmailHeaders(user.id), 'Reply-To': REPLY_TO },
    });
    console.log(ok ? `test email sent to ${maskEmail(user.email)} (no ledger write)` : 'test send FAILED');
    await sql.end();
    process.exit(ok ? 0 : 1);
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
      console.error(`safety cutoff passed mid-run — stopping. ${sent} sent, ${failed} failed.`);
      break;
    }
    const batch = await nextBatch();
    if (batch.length === 0) break;
    for (const c of batch) {
      if (sent + failed >= LIMIT) break outer;
      const address = c.email.toLowerCase();
      if (seenAddresses.has(address)) continue;
      seenAddresses.add(address);

      const url = unsubscribeUrl(c.user_id);
      const ok = await sendEmail({
        to: c.email,
        subject: SUBJECT,
        html: html(url!),
        idempotencyKey: `${BLAST_KEY}:${c.user_id}`,
        headers: { ...marketingEmailHeaders(c.user_id), 'Reply-To': REPLY_TO },
      });
      await recordAttempt(c.user_id, ok);
      if (ok) {
        sent += 1;
        consecutiveFailures = 0;
      } else {
        failed += 1;
        consecutiveFailures += 1;
        console.error(`send failed for ${maskEmail(c.email)} (${consecutiveFailures} consecutive)`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting (quota/outage?). Re-run to resume.`);
          break outer;
        }
      }
      if ((sent + failed) % 100 === 0) console.log(`progress: ${sent} sent, ${failed} failed`);
      await new Promise((resolve) => setTimeout(resolve, SEND_INTERVAL_MS));
    }
  }

  console.log(`DONE: ${sent} sent, ${failed} failed (key ${BLAST_KEY})`);
  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
