import { z } from 'zod';
import { FORMATIONS } from '../../modules/auction/auction.constants.js';

const formationNames = FORMATIONS.map((formation) => formation.name) as [
  (typeof FORMATIONS)[number]['name'],
  ...(typeof FORMATIONS)[number]['name'][],
];

export const auctionStartAiMatchSchema = z
  .object({
    formation: z.enum(formationNames).optional(),
    locale: z.enum(['en', 'ka']).optional(),
  })
  .optional()
  .transform((payload) => ({
    formation: payload?.formation,
    locale: payload?.locale ?? 'en',
  }));

export type AuctionStartAiMatchInput = z.infer<typeof auctionStartAiMatchSchema>;
