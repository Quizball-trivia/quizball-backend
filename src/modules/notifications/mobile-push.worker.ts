import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { decryptPushToken, PushTokenDecryptionError } from './mobile-push.crypto.js';
import { mobilePushRepo, type PushJob } from './mobile-push.repo.js';
import { PushTransportError, readExpoReceipt, sendExpoPush } from './mobile-push.transport.js';

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;
let retentionAt = 0;
const testUsers = () => config.PUSH_TEST_USER_IDS.split(',').map(v => v.trim()).filter(Boolean);
export const pushUserAllowed = (userId: string) => config.NODE_ENV === 'prod' || testUsers().includes(userId);
const backoff = (attempt: number) => Math.min(1800, 30 * 2 ** Math.min(attempt - 1, 6)) + Math.floor(Math.random() * 10);
// These may mean the app's credentials need repair. Keep the job retryable
// until its original expiry. Tokens are client supplied, so a foreign-project
// token must not open an account-wide circuit and block unrelated players.
const credentialFailure = (code:string|null) => code==='InvalidCredentials'||code==='MismatchSenderId';
async function providerFailure(error: unknown) {
  if (!(error instanceof PushTransportError)) return;
  if ([0,401,403,429].includes(error.status) || error.status >= 500) {
    await mobilePushRepo.backoffProvider(`HTTP_${error.status}`, Math.max(error.retryAfterSeconds,
      error.status === 401 || error.status === 403 ? 300 : 60));
  }
}
export async function deliverPushJob(job: PushJob) {
  const payload = await mobilePushRepo.payload(job);
  if (!payload || !pushUserAllowed(payload.user_id) || (payload.category === 'daily' && !config.PUSH_REMINDERS_ENABLED)) {
    await mobilePushRepo.settle(job, 'cancelled'); return;
  }
  if (!config.PUSH_DELIVERY_ENABLED || await mobilePushRepo.providerBlocked()) { await mobilePushRepo.defer(job, 60); return; }
  if (payload.category === 'new_games') {
    const timezone = (await mobilePushRepo.getPreferences(payload.user_id)).timezone;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (hour < 9 || hour >= 21) { await mobilePushRepo.defer(job, 1800); return; }
  }
  try {
    // Final owner/generation/consent fence, immediately before provider handoff.
    const current = await mobilePushRepo.payload(job);
    if (!current || !config.PUSH_DELIVERY_ENABLED || !pushUserAllowed(current.user_id) ||
        (current.category === 'daily' && !config.PUSH_REMINDERS_ENABLED)) { await mobilePushRepo.settle(job, 'cancelled'); return; }
    const token = decryptPushToken(current.token_encrypted);
    const ticket = await sendExpoPush({ to: token, sound: 'default', channelId: 'default',
      title: current.title[current.locale] ?? current.title.en, body: current.body[current.locale] ?? current.body.en,
      data: { route: current.route, eventId: job.event_id, pushOwnerId: current.user_id },
      ttl: Math.max(1, Math.floor((new Date(current.expires_at).getTime() - Date.now()) / 1000)),
      collapseId: job.event_id, tag: job.event_id, threadId: 'quizball-games' });
    if (ticket.status === 'ok') { await mobilePushRepo.settle(job, 'ticketed', null, ticket.id!, 900); return; }
    const code = ticket.details?.error ?? 'TICKET_ERROR';
    if (credentialFailure(code)) { await mobilePushRepo.defer(job,1800,code); logger.warn({jobId:job.id,code},'Push credential failure; job retained until expiry'); return; }
    if (code === 'DeviceNotRegistered') await mobilePushRepo.disable(job);
    // A client supplies its token; individual ticket/receipt errors must never
    // pause unrelated devices. Only request-level provider failures open backoff.
    await mobilePushRepo.settle(job, code === 'MessageRateExceeded' && job.attempts < 6 ? 'pending' : 'failed', code, null, backoff(job.attempts));
    logger.warn({ jobId: job.id, code }, 'Push provider rejected ticket');
  } catch (error) {
    if (error instanceof PushTokenDecryptionError) { await mobilePushRepo.settle(job, 'failed', 'TOKEN_KEY_VERSION_UNAVAILABLE'); return; }
    await providerFailure(error);
    const status = error instanceof PushTransportError ? error.status : 0;
    const transient = status === 0 || status === 429 || status >= 500;
    await mobilePushRepo.settle(job, transient && job.attempts < 6 ? 'pending' : transient ? 'unknown' : 'failed',
      status ? `HTTP_${status}` : 'SEND_AMBIGUOUS', null, backoff(job.attempts));
    logger.warn({ jobId: job.id, status }, 'Push attempt failed; tokens and provider messages intentionally omitted');
  }
}
export async function checkPushReceipt(job: PushJob) {
  try {
    const receipt = await readExpoReceipt(job.ticket_id!);
    if (!receipt) { await mobilePushRepo.settle(job, job.receipt_checks < 6 ? 'ticketed' : 'unknown', 'RECEIPT_MISSING', null, 300); return; }
    const code = receipt.details?.error ?? null;
    if (credentialFailure(code)) { await mobilePushRepo.defer(job,1800,code); logger.warn({jobId:job.id,code},'Push receipt credential failure; job retained until expiry'); return; }
    if (code === 'DeviceNotRegistered') await mobilePushRepo.disable(job);
    await mobilePushRepo.settle(job, receipt.status === 'ok' ? 'provider_accepted' : 'failed', code);
  } catch (error) {
    await providerFailure(error);
    await mobilePushRepo.settle(job, job.receipt_checks < 6 ? 'ticketed' : 'unknown', 'RECEIPT_CHECK_FAILED', null, 300);
  }
}
async function drain(receipts: boolean, limit: number) {
  for (let n = 0; n < limit; n += 4) {
    if (!config.PUSH_DELIVERY_ENABLED || await mobilePushRepo.providerBlocked()) break;
    let empty = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
      if (await mobilePushRepo.providerBlocked()) return;
      const job = await mobilePushRepo.claim(receipts);
      if (!job) { empty = true; return; }
      await (receipts ? checkPushReceipt(job) : deliverPushJob(job));
    }));
    if (empty) break;
  }
}
export async function tickMobilePush() {
  if (!config.PUSH_DELIVERY_ENABLED) return;
  await mobilePushRepo.ensureProviderKey();
  if (await mobilePushRepo.providerBlocked()) return;
  const retention = Date.now() >= retentionAt;
  await mobilePushRepo.maintain(retention);
  if (retention) retentionAt = Date.now() + 3600_000;
  if (config.PUSH_REMINDERS_ENABLED) await mobilePushRepo.queueReminders(config.NODE_ENV === 'prod' ? undefined : testUsers());
  await drain(false, 80);
  await drain(true, 80);
}
export function startMobilePushWorker() {
  if (timer || !config.PUSH_DELIVERY_ENABLED) return;
  const run = () => { if (inFlight) return; inFlight = tickMobilePush().catch(() => logger.error('Mobile push tick failed')).finally(() => { inFlight = null; }); };
  run(); timer = setInterval(run, 30_000); timer.unref();
}
export async function stopMobilePushWorker() { if (timer) clearInterval(timer); timer = null; await inFlight; }
