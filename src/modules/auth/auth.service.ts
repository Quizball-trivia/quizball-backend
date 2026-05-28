import { getAuthClient } from './supabase-auth-client.js';
import { usersService } from '../users/index.js';
import { AuthenticationError, BadRequestError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { withSpan } from '../../core/tracing.js';
import type {
  AuthSession,
  RegisterRequest,
  LoginRequest,
  SocialLoginTokenRequest,
  SupabaseSmsHookRequest,
} from './auth.schemas.js';

const GEORGIAN_MOBILE_RE = /^\+9955\d{8}$/;

type SmsOfficeSendResponse = {
  Success?: boolean;
  Message?: string;
  ErrorCode?: number;
};

function normalizeGeorgianPhone(rawPhone: string): string {
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

async function sendSmsOfficeOtp(phone: string, otp: string): Promise<void> {
  if (!config.SMSOFFICE_API_KEY) {
    throw new ExternalServiceError('SMSOffice API key is not configured');
  }

  const form = new URLSearchParams({
    key: config.SMSOFFICE_API_KEY,
    destination: toSmsOfficeDestination(phone),
    sender: config.SMSOFFICE_SENDER,
    content: `QuizBall code: ${otp}`,
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
}

/**
 * Provision user identity in our database.
 * Called after successful auth to ensure user record exists.
 *
 * Best-effort: transient infrastructure errors (DB hiccup, network blip) are logged and
 * swallowed so a flaky DB doesn't lock everyone out of login. AuthenticationError is the
 * only typed error that propagates — it signals an account-state problem (e.g. scheduled
 * deletion) that MUST block the auth flow.
 */
async function provisionIdentity(session: AuthSession): Promise<void> {
  await withSpan('auth.provision_identity', {
    'quizball.auth_provider': session.provider ?? 'unknown',
  }, async (span) => {
    if (!session.provider || !session.user?.providerSub) {
      span.setAttribute('quizball.identity_provision_skipped', true);
      logger.warn(
        { provider: session.provider, providerSub: session.user?.providerSub },
        'Missing provider or providerSub, skipping identity provisioning'
      );
      return;
    }

    span.setAttribute('quizball.user_subject', session.user.providerSub);
    try {
      await usersService.getOrCreateFromIdentity({
        provider: session.provider,
        subject: session.user.providerSub,
        email: session.user.email ?? undefined,
        claims: {},
      });
    } catch (error) {
      if (error instanceof AuthenticationError) {
        // Account-state errors (deletion etc.) MUST block auth.
        throw error;
      }
      // Transient errors are logged but don't break the auth flow.
      span.setAttribute('quizball.identity_provision_warning', true);
      logger.warn(
        { error: error instanceof Error ? error.message : error, provider: session.provider, userId: session.user.providerSub },
        'Failed to provision identity during auth'
      );
    }
  });
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
      if (session.accessToken) {
        await provisionIdentity(session);
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
      await provisionIdentity(session);
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
      await provisionIdentity(session);
      return session;
    });
  },

  async startGeorgianPhoneOtp(rawPhone: string): Promise<void> {
    return withSpan('auth.georgian_phone_otp_start', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      const authClient = getAuthClient();
      await authClient.sendPhoneOtp(phone);
    });
  },

  async verifyGeorgianPhoneOtp(rawPhone: string, token: string): Promise<AuthSession> {
    return withSpan('auth.georgian_phone_otp_verify', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const phone = normalizeGeorgianPhone(rawPhone);
      const authClient = getAuthClient();
      const session = await authClient.verifyPhoneOtp(phone, token);
      await provisionIdentity(session);
      return session;
    });
  },

  async sendSupabaseSmsHook(request: SupabaseSmsHookRequest): Promise<void> {
    return withSpan('auth.supabase_sms_hook', {
      'quizball.sms_provider': 'smsoffice',
    }, async () => {
      const phone = normalizeGeorgianPhone(request.user.phone ?? '');
      await sendSmsOfficeOtp(phone, request.sms.otp);
    });
  },

  /**
   * Verifies the session belongs to an account that is still allowed to authenticate.
   * Reuses the provisioning flow because it already loads the user and runs the deletion check.
   * Only AuthenticationError propagates — transient errors are swallowed inside provisionIdentity.
   */
  async ensureSessionAccountActive(session: AuthSession): Promise<void> {
    await provisionIdentity(session);
  },
};
