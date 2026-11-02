/**
 * Transactional email — minimal sender behind an env switch.
 *
 * Production + RESEND_API_KEY set → sends through the Resend HTTP API.
 * Every non-production environment → disabled, even if a provider key was
 * accidentally copied into it. Callers get `false` and must NOT record the
 * send as done.
 *
 * EMAIL_FROM controls the sender identity (the domain must be verified with
 * the provider first, e.g. "Quizball <league@quizball.io>").
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

function activeResendApiKey(): string | null {
  // Railway environments can be cloned from production, including variables.
  // NODE_ENV is the final safety boundary: staging/local must never contact
  // real recipients even when a live provider key is accidentally present.
  if (process.env.NODE_ENV !== 'prod') return null;
  return process.env.RESEND_API_KEY?.trim() || null;
}

export function emailEnabled(): boolean {
  return activeResendApiKey() !== null;
}

const PUBLIC_API_FALLBACK = 'https://quizball-backend-production.up.railway.app';

/** First configured secret strong enough to sign with (≥32 chars — a weak
 *  secret would let one recipient brute-force it offline from their own
 *  (userId, token) pair and forge opt-outs). */
function unsubSecret(): string | null {
  return [process.env.EMAIL_UNSUB_SECRET, config.SUPABASE_JWT_SECRET]
    .find((s) => s != null && s.length >= 32) ?? null;
}

export function emailUnsubEnabled(): boolean {
  return unsubSecret() != null;
}

export function emailUnsubToken(userId: string): string | null {
  const secret = unsubSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`email-unsub:${userId}`).digest('hex');
}

/** Signed token for campaign links. The purpose is part of the signature so a
 * click token can never be replayed as an unsubscribe token (or vice versa). */
export function emailLinkToken(purpose: string, payload: string): string | null {
  const secret = unsubSecret();
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update(`email-link:${purpose}:${payload}`)
    .digest('hex');
}

export function verifyEmailLinkToken(
  purpose: string,
  payload: string,
  token: string,
): boolean {
  const expectedToken = emailLinkToken(purpose, payload);
  if (!expectedToken) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const given = Buffer.from(token, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifyEmailUnsubToken(userId: string, token: string): boolean {
  const expectedToken = emailUnsubToken(userId);
  if (!expectedToken) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const given = Buffer.from(token, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: string): string | null {
  const token = emailUnsubToken(userId);
  if (!token) return null;
  const base = config.API_BASE_URL ?? PUBLIC_API_FALLBACK;
  return `${base}/api/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
}

/** RFC 8058 one-click headers for marketing sends. */
export function marketingEmailHeaders(userId: string): Record<string, string> {
  const url = unsubscribeUrl(userId);
  if (!url) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export type EmailSendResult = {
  accepted: boolean;
  messageId: string | null;
};

export async function sendEmailDetailed(input: {
  to: string;
  subject: string;
  html: string;
  /** Stable per-logical-send key: Resend dedupes retries of the same send.
      SES has no idempotency header — a retry after an accepted-but-unlogged
      send can duplicate an email there (rare and harmless for our content). */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}): Promise<EmailSendResult> {
  if (config.EMAIL_PROVIDER === 'ses') return sendViaSes(input);
  const apiKey = activeResendApiKey();
  if (!apiKey) return { accepted: false, messageId: null };
  const from = process.env.EMAIL_FROM ?? 'Quizball <league@quizball.io>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'Email send failed');
      return { accepted: false, messageId: null };
    }
    const response = await res.json().catch(() => null) as { id?: unknown } | null;
    return {
      accepted: true,
      messageId: typeof response?.id === 'string' ? response.id : null,
    };
  } catch (error) {
    logger.warn({ err: error }, 'Email send transport error');
    return { accepted: false, messageId: null };
  }
}



// --- Amazon SES path (EMAIL_PROVIDER=ses) -----------------------------------
// Lazy client: the SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the
// environment. Kept out of module scope so Resend-only deployments never touch
// the SDK at boot.
let sesClient: import('@aws-sdk/client-sesv2').SESv2Client | null = null;

async function sendViaSes(input: {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}): Promise<EmailSendResult> {
  const from = process.env.EMAIL_FROM ?? 'Quizball <league@quizball.io>';
  try {
    const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    sesClient ??= new SESv2Client({
      region: config.AWS_SES_REGION,
      requestHandler: { requestTimeout: 5_000 },
    });
    const result = await sesClient.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: { Html: { Data: input.html, Charset: 'UTF-8' } },
          Headers: input.headers
            ? Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value }))
            : undefined,
        },
      },
    }));
    return { accepted: true, messageId: result.MessageId ?? null };
  } catch (error) {
    logger.warn({ err: error }, 'Email send transport error (ses)');
    return { accepted: false, messageId: null };
  }
}

export async function sendEmail(
  input: Parameters<typeof sendEmailDetailed>[0],
): Promise<boolean> {
  return (await sendEmailDetailed(input)).accepted;
}

// config import kept for future env plumbing consistency; avoids the module
// being env-read-order sensitive if EMAIL_* moves into validated config.
void config;
