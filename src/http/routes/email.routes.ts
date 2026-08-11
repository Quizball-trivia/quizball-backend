import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { verifyEmailUnsubToken } from '../../core/email.js';

const router = Router();

const unsubQuery = z.object({
  u: z.string().uuid(),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

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
  if (!parsed.success || !verifyEmailUnsubToken(parsed.data.u, parsed.data.t)) {
    res.status(400).send('Invalid unsubscribe link');
    return;
  }
  res.set('Cache-Control', 'private, no-store');
  res.status(200).type('html').send(CONFIRM_FORM);
});

router.post('/unsubscribe', (req: Request, res: Response, next) => {
  const parsed = unsubQuery.safeParse(req.query);
  if (!parsed.success || !verifyEmailUnsubToken(parsed.data.u, parsed.data.t)) {
    res.status(400).send('Invalid unsubscribe link');
    return;
  }
  sql`
    INSERT INTO email_unsubscribes (user_id, source)
    SELECT id, 'link' FROM users WHERE id = ${parsed.data.u}
    ON CONFLICT (user_id) DO NOTHING
  `.then(() => {
    res.set('Cache-Control', 'private, no-store');
    res.status(200).type('html').send(DONE_PAGE);
  }).catch(next);
});

export const emailRoutes = router;
