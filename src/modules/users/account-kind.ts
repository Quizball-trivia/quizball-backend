import type { User } from '../../db/types.js';

/**
 * Partner players (partner_slug set) and partner staff are not Quizball members: they are never discoverable,
 * befriendable, challengeable or publicly visible (docs/FREECROCO-ISOLATION-INVENTORY.md).
 */
export function isPartnerOrStaff(user: Partial<Pick<User, 'partner_slug' | 'role'>>): boolean {
  return user.partner_slug != null || user.role === 'partner_staff';
}
