import { Router, Request, Response } from 'express';
import { Webhook } from 'standardwebhooks';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { config } from '../../core/config.js';
import { verifyEmailUnsubToken } from '../../core/email.js';
import {
  handleRetentionEmailClick,
  handleRetentionEmailProviderEvent,
  markRetentionEmailUnsubscribed,
  verifyRetentionUnsubscribeToken,
} from '../../modules/retention-email/retention-email.service.js';

const router = Router();

const unsubQuery = z.object({
  u: z.string().uuid(),
  a: z.string().uuid().optional(),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

const retentionClickQuery = z.object({
  a: z.string().uuid(),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

const retentionProviderEventSchema = z.object({
  type: z.enum([
    'email.delivered',
    'email.delivery_delayed',
    'email.bounced',
    'email.failed',
    'email.suppressed',
    'email.complained',
    'email.opened',
  ]),
  created_at: z.string().datetime(),
  data: z.object({ email_id: z.string().min(1) }).passthrough(),
}).passthrough();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function validUnsubscribeLink(input: z.infer<typeof unsubQuery>): boolean {
  return input.a
    ? verifyRetentionUnsubscribeToken(input.a, input.u, input.t)
    : verifyEmailUnsubToken(input.u, input.t);
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="ka">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quizball</title></head>
<body style="font-family: sans-serif; background: #f0f2f5; margin: 0; padding: 48px 16px; text-align: center;">
  <div style="max-width: 460px; margin: 0 auto; background: #fff; border-radius: 14px; padding: 32px 24px;">${body}</div>
</body>
</html>`;
}

const CONFIRM_FORM = page(`
    <div style="font-size: 30px; margin-bottom: 10px;">📭</div>
    <h2 style="margin: 0 0 8px; color: #111;">გააუქმო გამოწერა?</h2>
    <p style="margin: 0 0 18px; color: #444; line-height: 1.5;">
      აღარ მიიღებ Quizball-ის სარეკლამო მეილებს. ივენთების შეხსენებები, რომლებზეც დარეგისტრირდები, კვლავ მოგივა.
    </p>
    <p style="margin: 0 0 22px; color: #888; line-height: 1.5; font-size: 14px;">
      Stop receiving Quizball marketing emails? Reminders for events you register for will still arrive.
    </p>
    <form method="post">
      <button type="submit" style="background: #38B60E; color: #fff; border: 0; padding: 13px 26px; border-radius: 10px; font-weight: 700; font-size: 15px; cursor: pointer;">გამოწერის გაუქმება · Unsubscribe</button>
    </form>`);

const DONE_PAGE = page(`
    <div style="font-size: 30px; margin-bottom: 10px;">✅</div>
    <h2 style="margin: 0 0 8px; color: #111;">გამოწერა გაუქმებულია</h2>
    <p style="margin: 0 0 18px; color: #444; line-height: 1.5;">
      სარეკლამო მეილებს აღარ მიიღებ. ივენთების შეხსენებები, რომლებზეც დარეგისტრირდები, კვლავ მოგივა.
    </p>
    <p style="margin: 0; color: #888; line-height: 1.5; font-size: 14px;">
      You've been unsubscribed from marketing emails. Reminders for events you register for will still arrive.
    </p>`);

/**
 * Marketing-email unsubscribe. Unauthenticated by design (opened from a mail
 * client); authorization is the HMAC token minted per recipient at send time.
 * GET only renders a confirm form — mail-client link scanners prefetch GET
 * URLs, and a mutating GET would silently unsubscribe scanned recipients
 * (the reason RFC 8058 one-click is POST). POST mutates: it serves both the
 * form submit and the provider one-click header target, idempotently.
 */
router.get('/unsubscribe', (req: Request, res: Response) => {
  const parsed = unsubQuery.safeParse(req.query);
  if (!parsed.success || !validUnsubscribeLink(parsed.data)) {
    res.status(400).send('Invalid unsubscribe link');
    return;
  }
  res.set('Cache-Control', 'private, no-store');
  res.status(200).type('html').send(CONFIRM_FORM);
});

router.post('/unsubscribe', async (req: Request, res: Response, next) => {
  const parsed = unsubQuery.safeParse(req.query);
  if (!parsed.success || !validUnsubscribeLink(parsed.data)) {
    res.status(400).send('Invalid unsubscribe link');
    return;
  }
  try {
    const inserted = await sql<Array<{ user_id: string }>>`
      INSERT INTO email_unsubscribes (user_id, source)
      SELECT id, 'link' FROM users WHERE id = ${parsed.data.u}
      ON CONFLICT (user_id) DO NOTHING
      RETURNING user_id
    `;
    if (inserted.length === 1 && parsed.data.a) {
      await markRetentionEmailUnsubscribed(parsed.data.a, parsed.data.u);
    }
    res.set('Cache-Control', 'private, no-store');
    res.status(200).type('html').send(DONE_PAGE);
  } catch (error) {
    next(error);
  }
});

/** Signed, allowlisted campaign redirect. Tracking is diagnostic; decision
 * metrics remain intention-to-treat from the server-side assignment event. */
router.get('/retention/click', async (req: Request, res: Response, next) => {
  const parsed = retentionClickQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).send('Invalid email link');
    return;
  }
  try {
    const destination = await handleRetentionEmailClick(parsed.data.a, parsed.data.t);
    if (!destination) {
      res.status(400).send('Invalid or expired email link');
      return;
    }
    res.set('Cache-Control', 'private, no-store');
    res.redirect(302, destination);
  } catch (error) {
    next(error);
  }
});

/** Signed Resend lifecycle events. Raw-body verification and the durable event
 * ledger make the at-least-once provider stream safe to replay. */
router.post('/resend/webhook', async (req: Request, res: Response, next) => {
  if (!config.RESEND_WEBHOOK_SECRET) {
    res.status(404).send('Not found');
    return;
  }
  const id = firstHeader(req.headers['svix-id']);
  const timestamp = firstHeader(req.headers['svix-timestamp']);
  const signature = firstHeader(req.headers['svix-signature']);
  if (!req.rawBody || !id || !timestamp || !signature) {
    res.status(400).send('Invalid webhook');
    return;
  }
  try {
    const verified = new Webhook(config.RESEND_WEBHOOK_SECRET).verify(req.rawBody, {
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    });
    const parsed = retentionProviderEventSchema.safeParse(verified);
    if (parsed.success) {
      await handleRetentionEmailProviderEvent({
        eventId: id,
        eventType: parsed.data.type,
        providerMessageId: parsed.data.data.email_id,
        occurredAt: parsed.data.created_at,
      });
    }
    res.status(200).json({ received: true });
  } catch (error) {
    // Signature failures must be rejected; processing errors should reach the
    // normal error handler so Resend retries the event later.
    if (error instanceof Error && /signature|timestamp|webhook/i.test(error.message)) {
      res.status(400).send('Invalid webhook');
      return;
    }
    next(error);
  }
});

export const emailRoutes = router;
