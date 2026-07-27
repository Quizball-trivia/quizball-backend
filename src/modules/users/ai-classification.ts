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

/**
 * Public-serialization predicate: does this user present to other players as a
 * human? Real humans and persistent roster bots do (persistent bots read
 * `isAi:false`, keep their tier, and are profile-navigable — §1.2 masking).
 * Ephemeral and auction bots present as AI.
 *
 * The public `isAi` field is `!isPubliclyHumanPresenting(user)`. Internal
 * columns (`users.is_ai`, `ai_kind`) are never rewritten — only the outward
 * serialization is masked. Mirrors the SQL fragment
 * `(u.is_ai = false OR u.ai_kind = 'persistent')`.
 */
export function isPubliclyHumanPresenting(user: AiClassifiable): boolean {
  if (!user.is_ai) return true;
  return user.ai_kind === ('persistent' satisfies AiKind);
}
