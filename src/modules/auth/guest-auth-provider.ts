import type { AuthIdentity } from '../../core/types.js';
import { GUEST_TOKEN_SHAPE, guestService } from '../guest/guest.service.js';
import { GUEST_IDENTITY_PROVIDER } from '../guest/guest-identity.js';
import type { AuthProvider } from './auth.provider.js';

/**
 * Turns an opaque guest token (the one the public pages mint) into an identity
 * the users service can provision from: provider 'guest', subject = the guest
 * session id. The session's idle expiry and sha256-only storage stay in
 * guestService; this provider adds nothing a token holder does not already have.
 */
export class GuestAuthProvider implements AuthProvider {
  static handles(token: string): boolean {
    return GUEST_TOKEN_SHAPE.test(token);
  }

  async verifyToken(token: string): Promise<AuthIdentity> {
    const session = await guestService.resolve(token);
    return {
      provider: GUEST_IDENTITY_PROVIDER,
      subject: session.id,
      claims: { guestSessionId: session.id, locale: session.locale },
    };
  }
}

let guestProviderInstance: GuestAuthProvider | null = null;
export function getGuestAuthProvider(): GuestAuthProvider {
  if (!guestProviderInstance) guestProviderInstance = new GuestAuthProvider();
  return guestProviderInstance;
}
