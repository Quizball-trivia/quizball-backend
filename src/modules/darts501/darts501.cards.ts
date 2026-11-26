import { z } from 'zod';

/** What a board is, as the days calendar files it. Never used to judge a dart. */
export const D501_CARD_KINDS = ['apps', 'goals', 'cl', 'nt', 'combined', 'value', 'minus'] as const;

const short = z.string().trim().min(1).max(40);
const name = z.string().trim().min(1).max(60);

/**
 * A category's calendar card (darts501_cards): the subject's short name per language (English required, others fall back
 * to it), the competition code, and the picture: one crest (a club name the web crest resolver knows), a few crests for a
 * combined board, or a flag.
 */
export const d501CardSchema = z.object({
  kind: z.enum(D501_CARD_KINDS),
  competition: z.string().trim().min(1).max(40),
  subject: z.object({ en: short, es: short.optional(), ka: short.optional(), tr: short.optional(), ru: short.optional(), pt: short.optional(), de: short.optional(), fr: short.optional(), el: short.optional() }).strict(),
  crest: name.optional(),
  crests: z.array(name).min(2).max(4).optional(),
  flag: z.string().regex(/^[a-z]{2}(-[a-z]{3})?$/).optional(),
}).strict();
export type D501Card = z.infer<typeof d501CardSchema>;
