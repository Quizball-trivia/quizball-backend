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

export const auctionSearchStartSchema = auctionStartAiMatchSchema;

export type AuctionSearchStartInput = z.infer<typeof auctionSearchStartSchema>;

export const auctionBidSchema = z.object({
  matchId: z.string().min(1),
  amount: z.number().int().positive(),
});

export const auctionFoldSchema = z.object({
  matchId: z.string().min(1),
});

export const auctionSoloPickSelectSchema = z.object({
  matchId: z.string().min(1),
  option: z.enum(['A', 'B']),
});

export type AuctionBidInput = z.infer<typeof auctionBidSchema>;
export type AuctionFoldInput = z.infer<typeof auctionFoldSchema>;
export type AuctionSoloPickSelectInput = z.infer<typeof auctionSoloPickSelectSchema>;
