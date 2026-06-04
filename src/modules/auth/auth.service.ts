import { getAuthClient } from './supabase-auth-client.js';
import { usersService } from '../users/index.js';
import { AuthenticationError, BadRequestError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { withSpan } from '../../core/tracing.js';
import { randomBytes } from 'node:crypto';
import { smsDeliveryRepo, type SmsDeliveryStatus } from './sms-delivery.repo.js';
import type {
  AuthSession,
  RegisterRequest,
  LoginRequest,
  SocialLoginTokenRequest,
  SupabaseSmsHookRequest,
  PhoneLinkStartResponse,
  SmsOfficeCallbackQuery,
  SmsOfficeStatusResponse,
} from './auth.schemas.js';
import type { AuthIdentity } from '../../core/types.js';

const GEORGIAN_MOBILE_RE = /^\+9955\d{8}$/;
const PROFILE_PROVISIONING_DETAILS = { reason: 'profile_provisioning_failed' } as const;
const PROVISION_RETRY_DELAYS_MS = [150, 300] as const;

type SmsOfficeSendResponse = {
  Success?: boolean;
  Message?: string;
  Output?: unknown;
  ErrorCode?: number;
};

type SmsOfficeStatusResponsePayload = {
  Success?: boolean;
  Message?: string;
  Output?: {
    Status?: string;
  };
  ErrorCode?: number;
};

export class PendingDeletionSessionError extends AuthenticationError {
  public readonly session: AuthSession;

  constructor(session: AuthSession) {
    super('Account is scheduled for deletion', { reason: 'pending_deletion' });
    this.session = session;
  }
}

export function normalizeGeorgianPhone(rawPhone: string): string {
  const compact = rawPhone.replace(/[\s()-]/g, '');
  const withPlus = compact.startsWith('+')
    ? compact
    : compact.startsWith('995')
      ? `+${compact}`
      : compact.startsWith('5')
        ? `+995${compact}`
        : compact;

  if (!GEORGIAN_MOBILE_RE.test(withPlus)) {
    throw new BadRequestError('Only Georgian mobile numbers are supported right now');
  }

  return withPlus;
}

function toSmsOfficeDestination(phone: string): string {
  return phone.replace(/^\+/, '');
}

function isSmsOfficeDryRunEnabled(): boolean {
  return config.SMSOFFICE_DRY_RUN && config.NODE_ENV !== 'prod';
}

export function buildSmsOfficeReference(): string {
  return `qb${Date.now().toString(36)}${randomBytes(3).toString('hex')}`.slice(0, 20);
}

function parseSmsOfficeTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp || !/^\d{14}$/.test(timestamp)) {
    return null;
  }
  const year = timestamp.slice(0, 4);
  const month = timestamp.slice(4, 6);
  const day = timestamp.slice(6, 8);
  const hour = timestamp.slice(8, 10);
  const minute = timestamp.slice(10, 12);
  const second = timestamp.slice(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

async function recordSmsDelivery(input: {
  reference: string;
  destination: string;
  status: SmsDeliveryStatus;
  errorCode?: number | null;
  errorMessage?: string | null;
  rawCallback?: Record<string, unknown> | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
}): Promise<void> {
  try {
    await smsDeliveryRepo.upsert(input);
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : error,
        reference: input.reference,
        destination: input.destination,
      },
      'Failed to record SMS delivery event',
    );
  }
}

async function sendSmsOfficeOtp(phone: string, otp: string): Promise<{ reference: string; destination: string; dryRun: boolean }> {
  const reference = buildSmsOfficeReference();
  const destination = toSmsOfficeDestination(phone);
  const sentAt = new Date().toISOString();

  if (isSmsOfficeDryRunEnabled()) {
    logger.info(
      {
        destination,
        reference,
        otpPreview: otp,
      },
      'SMSOffice dry-run OTP generated',
    );
    await recordSmsDelivery({
      reference,
      destination,
      status: 'dry_run',
      sentAt,
      rawCallback: { dryRun: true },
    });
    return { reference, destination, dryRun: true };
  }

  if (!config.SMSOFFICE_API_KEY) {
    await recordSmsDelivery({
      reference,
      destination,
      status: 'failed',
      errorMessage: 'SMSOffice API key is not configured',
      sentAt,
    });
    throw new ExternalServiceError('SMSOffice API key is not configured');
  }

  const form = new URLSearchParams({
    key: config.SMSOFFICE_API_KEY,
    destination,
    sender: config.SMSOFFICE_SENDER,
    content: `QuizBall code: ${otp}`,
    reference,
    urgent: 'true',
  });

  const response = await fetch('https://smsoffice.ge/api/v2/send/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  let payload: SmsOfficeSendResponse | null = null;
  try {
    payload = await response.json() as SmsOfficeSendResponse;
  } catch {
    // SMSOffice should return JSON. Fall through to a provider error.
  }

  if (!response.ok || !payload?.Success) {
    await recordSmsDelivery({
      reference,
      destination,
      status: 'failed',
      errorCode: payload?.ErrorCode ?? null,
      errorMessage: payload?.Message ?? 'SMSOffice OTP send failed',
      sentAt,
    });
    logger.warn(
      {
        status: response.status,
        errorCode: payload?.ErrorCode,
        message: payload?.Message,
      },
      'SMSOffice OTP send failed',
    );
    throw new ExternalServiceError(payload?.Message ?? 'SMSOffice OTP send failed');
  }

  await recordSmsDelivery({
    reference,
    destination,
    status: 'accepted',
    errorCode: payload.ErrorCode ?? null,
    errorMessage: payload.Message ?? null,
    sentAt,
  });
  return { reference, destination, dryRun: false };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProfileProvisioningError(error: unknown): ExternalServiceError {
  return new ExternalServiceError('Failed to provision user profile', {
    ...PROFILE_PROVISIONING_DETAILS,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function getProvisioningIdentity(session: AuthSession): AuthIdentity {
  if (!session.provider || !session.user?.providerSub) {
    throw createProfileProvisioningError(
      new Error('Session is missing provider or provider subject')
    );
  }

  return {
    provider: session.provider,
    subject: session.user.providerSub,
    email: session.user.email ?? undefined,
    phoneNumber: session.user.phone ?? undefined,
    phoneVerifiedAt: session.user.phoneConfirmedAt,
    claims: {},
  };
}

async function getOrCreateProvisionedIdentity(session: AuthSession): Promise<void> {
  const identity = getProvisioningIdentity(session);
  await usersService.getOrCreateFromIdentity(identity);
}

async function provisionIdentityWithRetry(session: AuthSession): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= PROVISION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await getOrCreateProvisionedIdentity(session);
      logger.info(
        {
          provider: session.provider,
          userId: session.user?.providerSub,
          hasEmail: !!session.user?.email,
          attempts: attempt + 1,
        },
        'Identity provisioned during auth'
      );
      return;
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      lastError = error;
      if (attempt < PROVISION_RETRY_DELAYS_MS.length) {
        const delayMs = PROVISION_RETRY_DELAYS_MS[attempt];
        logger.warn(
          {
            err: error,
            provider: session.provider,
            userId: session.user?.providerSub,
            delayMs,
            attempt: attempt + 1,
          },
          'Identity provisioning failed, retrying'
        );
        await wait(delayMs);
      }
    }
  }

  throw createProfileProvisioningError(lastError);
}

/**
 * Provision user identity in our database.
 * Called after successful auth to ensure user record exists.
 *
 * Best-effort: used only for the routine refresh path. A successful Supabase
 * refresh can rotate the refresh token, so transient app-profile hiccups must
 * not withhold the new session from the browser.
 */
async function provisionIdentity(session: AuthSession): Promise<void> {
  await withSpan('auth.provision_identity', {
    'quizball.auth_provider': session.provider ?? 'unknown',
  }, async (span) => {
    try {
      span.setAttribute('quizball.user_subject', session.user?.providerSub ?? 'unknown');
      await provisionIdentityWithRetry(session);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        // Account-state errors (deletion etc.) MUST block auth.
        throw error;
      }
      span.setAttribute('quizball.identity_provision_warning', true);
      logger.warn(
        {
          err: error,
          provider: session.provider,
          userId: session.user?.providerSub,
          hasEmail: Boolean(session.user?.email),
          reason: PROFILE_PROVISIONING_DETAILS.reason,
        },
        'Failed to provision identity during refresh; returning rotated session'
      );
    }
  });
}

function isPendingDeletionAuthenticationError(error: unknown): boolean {
  if (!(error instanceof AuthenticationError)) {
    return false;
  }
  const details = error.details;
  return Boolean(
    details &&
      typeof details === 'object' &&
      'reason' in details &&
      (details as { reason?: unknown }).reason === 'pending_deletion'
  );
}

async function provisionIdentityOrThrowSession(session: AuthSession): Promise<void> {
  try {
    await provisionIdentityWithRetry(session);
  } catch (error) {
    if (isPendingDeletionAuthenticationError(error) && session.refreshToken) {
      throw new PendingDeletionSessionError(session);
    }
    throw error;
  }
}

function toSessionIdentity(session: AuthSession): AuthIdentity {
  if (!session.provider || !session.user?.providerSub) {
    throw new BadRequestError('Session does not include a restorable identity');
  }

  return {
    provider: session.provider,
    subject: session.user.providerSub,
    email: session.user.email ?? undefined,
    phoneNumber: session.user.phone ?? undefined,
    phoneVerifiedAt: session.user.phoneConfirmedAt,
    claims: {},
  };
}

async function restorePendingDeletionForSession(session: AuthSession): Promise<void> {
  await usersService.restorePendingDeletionFromIdentity(toSessionIdentity(session));
}

export const authService = {
  async register(request: RegisterRequest): Promise<AuthSession> {
    return withSpan('auth.register', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signUp(
        request.email,
        request.password,
        request.redirect_to,
        request.locale,
      );
      if (session.alreadyRegistered) {
        const pendingUser = await usersService.getPendingDeletionByEmail(request.email);
        if (pendingUser) {
          session.pendingDeletion = true;
        }
      }
      if (session.accessToken) {
        await provisionIdentityOrThrowSession(session);
      }
      return session;
    });
  },

  async login(request: LoginRequest): Promise<AuthSession> {
    return withSpan('auth.login', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signIn(request.email, request.password);
      await provisionIdentityOrThrowSession(session);
      return session;
    });
  },

  async restorePendingDeletionWithLogin(request: LoginRequest): Promise<AuthSession> {
    return withSpan('auth.restore_pending_deletion_login', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signIn(request.email, request.password);
      await restorePendingDeletionForSession(session);
      return session;
    });
  },

  async restorePendingDeletionWithRefreshToken(refreshToken: string): Promise<AuthSession> {
    return withSpan('auth.restore_pending_deletion_refresh', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.refresh(refreshToken);
      await restorePendingDeletionForSession(session);
      return session;
    });
  },

  async socialLoginToken(request: SocialLoginTokenRequest): Promise<AuthSession> {
    return withSpan('auth.social_login_token', {
      'quizball.auth_provider': 'supabase',
      'quizball.oauth_provider': request.provider,
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signInWithIdToken(
        request.provider,
        request.id_token,
        request.nonce,
      );
      if (request.restore_pending_deletion) {
        await restorePendingDeletionForSession(session);
      } else {
        await provisionIdentityOrThrowSession(session);
      }
      return session;
    });
  },

  async startGeorgianPhoneOtp(rawPhone: string): Promise<void> {
    return withSpan('auth.georgian_phone_otp_start', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      const linkedUser = await usersService.getRestorableVerifiedByPhoneNumber(phone);
      if (!linkedUser) {
        logger.info('Phone OTP requested for unlinked phone; returning generic success');
        return;
      }

      const authClient = getAuthClient();
      await authClient.sendPhoneOtp(phone);
    });
  },

  async verifyGeorgianPhoneOtp(rawPhone: string, token: string, restorePendingDeletion = false): Promise<AuthSession> {
    return withSpan('auth.georgian_phone_otp_verify', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      const authClient = getAuthClient();
      const session = await authClient.verifyPhoneOtp(phone, token);
      if (session.user) {
        session.user.phone = session.user.phone ?? phone;
        session.user.phoneConfirmedAt = session.user.phoneConfirmedAt ?? new Date().toISOString();
      }
      if (restorePendingDeletion) {
        await restorePendingDeletionForSession(session);
      } else {
        await provisionIdentityOrThrowSession(session);
      }
      return session;
    });
  },

  async startGeorgianPhoneLink(userId: string, accessToken: string, rawPhone: string): Promise<PhoneLinkStartResponse> {
    return withSpan('auth.georgian_phone_link_start', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      const availability = await usersService.assertPhoneCanBeLinked(userId, phone);
      if (availability === 'already_verified') {
        return {
          message: 'Phone number is already linked',
          phone,
          otp_required: false,
        };
      }

      const authClient = getAuthClient();
      await authClient.updateUserPhone(accessToken, phone);
      return {
        message: 'Verification code sent',
        phone,
        otp_required: true,
      };
    });
  },

  async verifyGeorgianPhoneLink(userId: string, accessToken: string, rawPhone: string, token: string) {
    return withSpan('auth.georgian_phone_link_verify', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      await usersService.assertPhoneCanBeLinked(userId, phone);

      const authClient = getAuthClient();
      const session = await authClient.verifyPhoneChange(accessToken, phone, token);
      const verifiedAt = session.user?.phoneConfirmedAt ?? new Date().toISOString();
      const user = await usersService.setVerifiedPhoneNumber(userId, phone, verifiedAt);

      return { session, user };
    });
  },

  async sendSupabaseSmsHook(request: SupabaseSmsHookRequest): Promise<void> {
    return withSpan('auth.supabase_sms_hook', {
      'quizball.sms_provider': 'smsoffice',
    }, async () => {
      const phone = normalizeGeorgianPhone(
        request.user.new_phone ?? request.user.phone_change ?? request.user.phone ?? '',
      );
      await sendSmsOfficeOtp(phone, request.sms.otp);
    });
  },

  async handleSmsOfficeCallback(query: SmsOfficeCallbackQuery): Promise<void> {
    return withSpan('auth.smsoffice_callback', {
      'quizball.sms_provider': 'smsoffice',
    }, async () => {
      if (config.SMSOFFICE_CALLBACK_SECRET && query.secret !== config.SMSOFFICE_CALLBACK_SECRET) {
        throw new AuthenticationError('Invalid SMSOffice callback secret');
      }

      const destination = toSmsOfficeDestination(normalizeGeorgianPhone(query.destination));
      const deliveredAt = query.status.toLowerCase() === 'delivered'
        ? parseSmsOfficeTimestamp(query.timestamp)
        : null;

      await recordSmsDelivery({
        reference: query.reference,
        destination,
        status: query.status as SmsDeliveryStatus,
        errorMessage: query.reason || null,
        deliveredAt,
        rawCallback: {
          reference: query.reference,
          status: query.status,
          reason: query.reason,
          destination: query.destination,
          timestamp: query.timestamp,
          operator: query.operator,
        },
      });
    });
  },

  async checkSmsOfficeStatus(rawDestination: string, reference: string): Promise<SmsOfficeStatusResponse> {
    return withSpan('auth.smsoffice_status', {
      'quizball.sms_provider': 'smsoffice',
    }, async () => {
      const destination = toSmsOfficeDestination(normalizeGeorgianPhone(rawDestination));

      if (isSmsOfficeDryRunEnabled()) {
        return {
          reference,
          destination,
          status: 'dry_run',
          message: 'SMSOffice dry run is enabled',
        };
      }

      if (!config.SMSOFFICE_API_KEY) {
        throw new ExternalServiceError('SMSOffice API key is not configured');
      }

      const params = new URLSearchParams({
        key: config.SMSOFFICE_API_KEY,
        destination,
        reference,
      });
      const response = await fetch(`https://smsoffice.ge/api/v2/getMessageStatus/?${params.toString()}`);

      let payload: SmsOfficeStatusResponsePayload | null = null;
      try {
        payload = await response.json() as SmsOfficeStatusResponsePayload;
      } catch {
        // Provider should return JSON. Fall through to a provider error.
      }

      if (!response.ok || !payload?.Success) {
        throw new ExternalServiceError(payload?.Message ?? 'SMSOffice status check failed');
      }

      const status = payload.Output?.Status ?? 'Unknown';
      await recordSmsDelivery({
        reference,
        destination,
        status: status as SmsDeliveryStatus,
        errorCode: payload.ErrorCode ?? null,
        errorMessage: payload.Message ?? null,
      });

      return {
        reference,
        destination,
        status,
        message: payload.Message ?? null,
      };
    });
  },

  /**
   * Verifies the session belongs to an account that is still allowed to authenticate.
   * Refresh is intentionally tolerant of transient app-profile provisioning failures:
   * Supabase may already have rotated the refresh token, so the new session must
   * be returned to the browser. Account-state AuthenticationError still blocks.
   */
  async ensureSessionAccountActive(session: AuthSession): Promise<void> {
    await provisionIdentity(session);
  },
};
