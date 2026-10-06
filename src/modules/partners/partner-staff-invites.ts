/** Supabase accounts for new Freecroco staff. `supabase` mode sends a real invite email through the Auth admin API;
 *  `stub` mode only logs the would-be invite, so local and staging runs never email anyone or write to a Supabase
 *  project. PARTNER_STAFF_INVITE_MODE picks one; the default is `supabase` in production and `stub` elsewhere. */

import { randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { PartnerError } from './partner-errors.js';

export type StaffInviteMode = 'stub' | 'supabase';

export interface StaffInviteResult {
  /** The Supabase auth user id (user_identities.subject for provider 'supabase'). */
  authUserId: string;
  /** False when the email already had a Supabase account: no email was sent, they sign in as before. */
  invited: boolean;
}

export interface StaffInviter {
  readonly mode: StaffInviteMode;
  invite(email: string): Promise<StaffInviteResult>;
}

const TIMEOUT_MS = 10_000;
/** Clock skew allowed between us and Supabase when telling a fresh invite from an account that already existed. */
const PREEXISTING_MARGIN_MS = 60_000;

export function staffInviteMode(env: NodeJS.ProcessEnv = process.env, nodeEnv: string = config.NODE_ENV): StaffInviteMode {
  const raw = env.PARTNER_STAFF_INVITE_MODE?.trim();
  if (raw && raw !== 'stub' && raw !== 'supabase') {
    throw new Error(`PARTNER_STAFF_INVITE_MODE must be 'stub' or 'supabase', not '${raw}'`);
  }
  const mode = (raw as StaffInviteMode | undefined) ?? (nodeEnv === 'prod' ? 'supabase' : 'stub');
  // A stub on production would create staff rows no one can ever sign in to.
  if (mode === 'stub' && nodeEnv === 'prod') throw new Error('PARTNER_STAFF_INVITE_MODE=stub is not allowed in production');
  return mode;
}

/** `ab***@example.com`: enough to recognise in a log, not the whole address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export const stubInviter: StaffInviter = {
  mode: 'stub',
  async invite(email) {
    const authUserId = randomUUID();
    logger.info({ email: maskEmail(email), authUserId }, 'Partner staff invite (stub): no email sent, no Supabase account created');
    return { authUserId, invited: true };
  },
};

interface SupabaseInviterOptions {
  baseUrl: string;
  /** sb_secret_… (sent as apikey only) or a legacy service_role JWT (sent as apikey and bearer). */
  key: string;
  redirectTo?: string;
  fetchImpl?: typeof fetch;
}

export function createSupabaseInviter(options: SupabaseInviterOptions): StaffInviter {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: options.key };
  if (!options.key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${options.key}`;

  const post = async (path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> => {
    const response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, data };
  };

  const userId = (data: Record<string, unknown>): string | null =>
    typeof data.id === 'string' ? data.id : typeof (data.user as { id?: unknown })?.id === 'string' ? (data.user as { id: string }).id : null;

  const createdBefore = (data: Record<string, unknown>, cutoffMs: number): boolean => {
    const user = (data.user as Record<string, unknown> | undefined) ?? data;
    const created = typeof user.created_at === 'string' ? Date.parse(user.created_at) : NaN;
    return Number.isFinite(created) && created < cutoffMs;
  };

  const emailConfirmed = (data: Record<string, unknown>): boolean => {
    const user = (data.user as Record<string, unknown> | undefined) ?? data;
    return typeof user.email_confirmed_at === 'string' && user.email_confirmed_at.length > 0;
  };

  return {
    mode: 'supabase',
    async invite(email) {
      try {
        const query = options.redirectTo ? `?${new URLSearchParams({ redirect_to: options.redirectTo })}` : '';
        const sentAt = Date.now();
        const invited = await post(`/auth/v1/invite${query}`, { email });
        const invitedId = invited.status < 300 ? userId(invited.data) : null;
        // Supabase re-invites an existing unconfirmed account (200, not 422): one made before this request may have
        // been registered by someone else, with their password.
        if (invitedId && createdBefore(invited.data, sentAt - PREEXISTING_MARGIN_MS)) {
          logger.warn({ email: maskEmail(email) }, 'Partner staff invite: email belongs to an older unconfirmed account');
          throw new PartnerError('staff_not_eligible', 'This email has an unconfirmed account; ask engineering to resolve it');
        }
        if (invitedId) return { authUserId: invitedId, invited: true };

        const exists = invited.status === 422 &&
          (invited.data.error_code === 'email_exists' || /already been registered/i.test(String(invited.data.msg ?? '')));
        if (exists) {
          // The account exists in Supabase but not here yet: resolve its id. The link is generated, never sent.
          const link = await post('/auth/v1/admin/generate_link', { type: 'magiclink', email });
          const existingId = link.status < 300 ? userId(link.data) : null;
          // Sign-up is public: an unconfirmed account may have been registered by someone else, with their password.
          if (existingId && !emailConfirmed(link.data)) {
            logger.warn({ email: maskEmail(email) }, 'Partner staff invite: existing account has an unconfirmed email');
            throw new PartnerError('staff_not_eligible', 'This email has an unconfirmed account; ask engineering to resolve it');
          }
          if (existingId) return { authUserId: existingId, invited: false };
          logger.error({ status: link.status, code: link.data.error_code }, 'Partner staff invite: existing account id not resolved');
        } else {
          logger.error({ status: invited.status, code: invited.data.error_code }, 'Partner staff invite refused by Supabase');
        }
      } catch (err) {
        if (err instanceof PartnerError) throw err;
        logger.error({ err }, 'Partner staff invite request failed');
      }
      throw new PartnerError('invite_failed');
    },
  };
}

let override: StaffInviter | null = null;
let cached: StaffInviter | null = null;

export function getStaffInviter(): StaffInviter {
  if (override) return override;
  if (cached) return cached;
  if (staffInviteMode() === 'stub') return (cached = stubInviter);
  const key = config.SUPABASE_SECRET_KEY?.trim() || config.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!config.SUPABASE_URL || !key) {
    throw new Error('Partner staff invites need SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
  }
  return (cached = createSupabaseInviter({
    baseUrl: config.SUPABASE_URL,
    key,
    redirectTo: process.env.PARTNER_STAFF_INVITE_REDIRECT_URL?.trim() || undefined,
  }));
}

/** Test hook only. */
export function setStaffInviterForTests(inviter: StaffInviter | null): void {
  override = inviter;
  cached = null;
}
