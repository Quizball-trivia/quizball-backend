import { CapabilityRequiredError } from '../../core/errors.js';
import { isRankedSettleEligible, type AiClassifiable } from './ai-classification.js';

/**
 * What an account kind may do. Members hold every capability; guests (account-less
 * friend-room players, `users.is_guest`) hold only the two friendly-room ones.
 *
 * Socket event → entry service → capability (enforced in the services, not the
 * handlers, so every transport that reaches a service is covered):
 *   lobby:create {mode:'ranked'} → startRankedAiForUser          → rankedEntry
 *   ranked:queue_join            → rankedMatchmaking.handleQueueJoin → rankedEntry
 *   auction:search_start         → auctionMatchmaking.handleSearchStart → queueEntry
 *   auction:start_ai_match       → auctionRealtime.handleStartAiMatch  → queueEntry
 *   grid:search_start            → footballGridMatchmaking.handleSearchStart → queueEntry
 *   lobby:create {mode:'friendly'} / lobby:join_by_code           → createFriendlyRoom / joinFriendlyRoom
 *   lobby:challenge_* / friends HTTP                              → social
 *   WL enter / checkin (HTTP, authMiddleware — guests never carry a Supabase JWT) → weekendLeague
 *   wallet / tickets / XP / streak / objectives writers           → progression, wallet
 *   nickname + avatar-store endpoints                             → profileEdit
 *   user search, public projections                               → discoverable
 */
export type Capability =
  | 'createFriendlyRoom'
  | 'joinFriendlyRoom'
  | 'rankedEntry'
  | 'queueEntry'
  | 'weekendLeague'
  | 'social'
  | 'progression'
  | 'wallet'
  | 'profileEdit'
  | 'discoverable';

export interface GuestClassifiable {
  is_guest?: boolean | null;
}

const MEMBER_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'createFriendlyRoom', 'joinFriendlyRoom', 'rankedEntry', 'queueEntry', 'weekendLeague',
  'social', 'progression', 'wallet', 'profileEdit', 'discoverable',
]);
const GUEST_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>(['createFriendlyRoom', 'joinFriendlyRoom']);

export function isGuestUser(user: GuestClassifiable): boolean {
  return user.is_guest === true;
}

export function capabilitiesFor(user: GuestClassifiable): ReadonlySet<Capability> {
  return isGuestUser(user) ? GUEST_CAPABILITIES : MEMBER_CAPABILITIES;
}

export function hasCapability(user: GuestClassifiable, capability: Capability): boolean {
  return capabilitiesFor(user).has(capability);
}

/** Throws CapabilityRequiredError (403, code CAPABILITY_REQUIRED) — the web maps it to the sign-up dialog. */
export function assertCapability(user: GuestClassifiable, capability: Capability): void {
  if (!hasCapability(user, capability)) throw new CapabilityRequiredError(capability);
}

/**
 * Who receives XP / coins / achievements / objectives / stats. Keeps the existing
 * bot policy (persistent bots level like humans, ephemeral/auction AI do not)
 * and adds the guest exclusion. Match SEMANTICS (head-to-head, forfeit) must be
 * computed from participants BEFORE filtering recipients with this.
 */
export function isProgressionEligible(user: AiClassifiable & GuestClassifiable): boolean {
  return isRankedSettleEligible(user) && !isGuestUser(user);
}
