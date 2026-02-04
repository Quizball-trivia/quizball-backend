/**
 * Shared types used across the application.
 */

/**
 * Validated request data attached by validation middleware.
 */
export interface ValidatedRequest {
  body?: unknown;
  query?: unknown;
  params?: unknown;
}

/**
 * Auth identity from token verification.
 */
export interface AuthIdentity {
  provider: string;
  subject: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  claims: Record<string, unknown>;
}

/**
 * Internal user record.
 */
export interface User {
  id: string;
  email: string | null;
  nickname: string | null;
  country: string | null;
  avatarUrl: string | null;
  onboardingComplete: boolean;
  createdAt: Date;
  updatedAt: Date;
}
