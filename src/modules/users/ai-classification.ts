import type { AiKind } from './users.repo.js';

/** Minimal shape needed to classify a user for ranked participation. */
export interface AiClassifiable {
  is_ai: boolean;
  ai_kind: string | null;
}

/**
 * Positive allowlist for ranked settlement & progression: a real human OR a
 * persistent roster bot. Persistent bots settle like humans (RP, W/L/D, streak,
 * placement, XP, season reset) even though `is_ai` is true.
 *
 * Deliberately NOT expressed as "not ephemeral": auction bots and any future
 * ai_kind stay excluded unless explicitly listed. Mirrors the SQL predicate
 * `is_ai = false OR ai_kind = 'persistent'` used by the users repo.
 */
export function isRankedSettleEligible(user: AiClassifiable): boolean {
  if (!user.is_ai) return true;
  return user.ai_kind === ('persistent' satisfies AiKind);
}
