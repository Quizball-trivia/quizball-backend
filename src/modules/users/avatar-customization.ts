import { z } from 'zod';

const freeSkins = [
  'skin_male_white',
  'skin_male_white_alt',
  'skin_male_dark',
  'skin_male_dark_alt',
] as const;

const freeJerseys = [
  'jersey_green',
  'jersey_blue',
  'jersey_yellow',
  'jersey_red',
  'jersey_violet',
  'jersey_pink',
] as const;
const freeHair = ['hair_boy_basic'] as const;

export const AVATAR_SLOTS = ['skin', 'jersey', 'hair', 'glasses', 'facialHair'] as const;
export type AvatarSlot = typeof AVATAR_SLOTS[number];

export const FREE_AVATAR_PART_IDS: Record<AvatarSlot, ReadonlySet<string>> = {
  skin: new Set(freeSkins),
  jersey: new Set(freeJerseys),
  hair: new Set(freeHair),
  glasses: new Set(),
  facialHair: new Set(),
};

// Paid parts are catalog data, not an API-code enum. Ownership validation in
// users.service matches these bounded identifiers against the purchased
// product's avatarPartId + slot metadata. This prevents every catalog addition
// from requiring a second, easy-to-forget backend allowlist update.
const avatarPartIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const avatarCustomizationSchema = z.object({
  skin: avatarPartIdSchema.optional(),
  jersey: avatarPartIdSchema.optional(),
  hair: avatarPartIdSchema.optional(),
  glasses: avatarPartIdSchema.optional(),
  facialHair: avatarPartIdSchema.optional(),
}).strict();

export type AvatarCustomization = z.infer<typeof avatarCustomizationSchema>;

export function parseStoredAvatarCustomization(value: unknown): AvatarCustomization | null {
  if (value == null) {
    return null;
  }

  const result = avatarCustomizationSchema.safeParse(value);
  return result.success ? result.data : null;
}
