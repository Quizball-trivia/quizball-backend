/** Analytics-only client declaration. Never use it for authorization. */
export const CLIENT_PLATFORM_HEADER = 'x-quizball-platform';
export type ClientPlatform = 'web' | 'android' | 'ios' | 'unknown';

export function parseClientPlatform(raw: unknown): ClientPlatform {
  // Reject repeated/comma-joined headers rather than choosing an arbitrary one.
  return raw === 'web' || raw === 'android' || raw === 'ios' ? raw : 'unknown';
}
