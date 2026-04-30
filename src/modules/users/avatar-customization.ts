import { z } from 'zod';

const freeSkins = ['skin_male_white'] as const;
const paidSkinProductSlugs = {
  skin_male_white_alt: 'avatar_skin_white_alt',
  skin_male_dark: 'avatar_skin_dark',
  skin_male_dark_alt: 'avatar_skin_dark_alt',
} as const;

const freeJerseys = [
  'jersey_green',
  'jersey_blue',
  'jersey_yellow',
  'jersey_red',
  'jersey_violet',
  'jersey_pink',
] as const;
const paidJerseyProductSlugs = {
  jersey_real: 'avatar_jersey_real',
  jersey_liverpool: 'avatar_jersey_liverpool',
  jersey_barcelona: 'avatar_jersey_barcelona',
  jersey_milan: 'avatar_jersey_milan',
  jersey_bayern: 'avatar_jersey_bayern',
  jersey_brazil_retro: 'avatar_jersey_brazil_retro',
  jersey_argentina_retro: 'avatar_jersey_argentina_retro',
  jersey_france_retro: 'avatar_jersey_france_retro',
  jersey_germany_retro: 'avatar_jersey_germany_retro',
  jersey_netherlands_retro: 'avatar_jersey_netherlands_retro',
} as const;

const freeHair = ['hair_boy_basic'] as const;
const paidHairProductSlugs = {
  hair_girl_basic: 'avatar_hair_girl_basic',
  hair_hamsik: 'avatar_hair_hamsik',
  hair_ramos: 'avatar_hair_ramos',
  hair_ronaldo_brazil: 'avatar_hair_ronaldo_brazil',
  hair_ronaldo_goat: 'avatar_hair_ronaldo_goat',
} as const;

const paidGlassesProductSlugs = {
  glasses_wayfarer: 'avatar_glasses_wayfarer',
  glasses_round: 'avatar_glasses_round',
  glasses_aviator: 'avatar_glasses_aviator',
} as const;

const paidFacialHairProductSlugs = {
  stache: 'avatar_facial_stache',
  beard: 'avatar_facial_beard',
} as const;

const skinIds = [
  ...freeSkins,
  ...Object.keys(paidSkinProductSlugs),
] as [string, ...string[]];
const jerseyIds = [
  ...freeJerseys,
  ...Object.keys(paidJerseyProductSlugs),
] as [string, ...string[]];
const hairIds = [
  ...freeHair,
  ...Object.keys(paidHairProductSlugs),
] as [string, ...string[]];
const glassesIds = Object.keys(paidGlassesProductSlugs) as [string, ...string[]];
const facialHairIds = Object.keys(paidFacialHairProductSlugs) as [string, ...string[]];

export const avatarCustomizationSchema = z.object({
  skin: z.enum(skinIds).optional(),
  jersey: z.enum(jerseyIds).optional(),
  hair: z.enum(hairIds).optional(),
  glasses: z.enum(glassesIds).optional(),
  facialHair: z.enum(facialHairIds).optional(),
}).strict();

export type AvatarCustomization = z.infer<typeof avatarCustomizationSchema>;

const partProductSlugById: Record<string, string | undefined> = {
  ...paidSkinProductSlugs,
  ...paidJerseyProductSlugs,
  ...paidHairProductSlugs,
  ...paidGlassesProductSlugs,
  ...paidFacialHairProductSlugs,
};

export function getRequiredAvatarProductSlugs(customization: AvatarCustomization): string[] {
  const slugs = [
    customization.skin ? partProductSlugById[customization.skin] : undefined,
    customization.jersey ? partProductSlugById[customization.jersey] : undefined,
    customization.hair ? partProductSlugById[customization.hair] : undefined,
    customization.glasses ? partProductSlugById[customization.glasses] : undefined,
    customization.facialHair ? partProductSlugById[customization.facialHair] : undefined,
  ];

  return [...new Set(slugs.filter((slug): slug is string => Boolean(slug)))];
}
