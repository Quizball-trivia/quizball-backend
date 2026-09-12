import { createHash } from 'crypto';
import type { AvatarCustomization } from '../users/avatar-customization.js';

/** Provider name a guest identity is stored under in user_identities. */
export const GUEST_IDENTITY_PROVIDER = 'guest';

/** Funny but harmless — never a real player's handle, never a slur target. */
const ADJECTIVES = [
  'Anonymous', 'Mystery', 'Secret', 'Incognito', 'Masked', 'Rogue', 'Silent', 'Sneaky', 'Wandering', 'Undercover',
];
const NOUNS = [
  'Striker', 'Keeper', 'Winger', 'Playmaker', 'Libero', 'Sweeper', 'Poacher', 'Gaffer', 'Ultra', 'Scout',
  'Fullback', 'Regista', 'Trequartista', 'Mezzala', 'Pivot',
];

/** Deterministic base + a large suffix space; the creation loop walks the candidates on nickname collisions. */
export function guestNameCandidates(guestSessionId: string, count = 6): string[] {
  const digest = createHash('sha256').update(`guest-name:${guestSessionId}`).digest();
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const adjective = ADJECTIVES[digest[i * 3] % ADJECTIVES.length];
    const noun = NOUNS[digest[i * 3 + 1] % NOUNS.length];
    const suffix = ((digest.readUInt16BE(i * 3 + 2) % 9000) + 1000).toString();
    out.push(`${adjective} ${noun} ${suffix}`);
  }
  return out;
}

/** Three default kits; guests cannot open the avatar store. */
const KITS: AvatarCustomization[] = [
  { jersey: 'jersey_green' },
  { jersey: 'jersey_yellow' },
  { jersey: 'jersey_blue' },
];

export function guestKitFor(guestSessionId: string): AvatarCustomization {
  const digest = createHash('sha256').update(`guest-kit:${guestSessionId}`).digest();
  return KITS[digest[0] % KITS.length];
}
