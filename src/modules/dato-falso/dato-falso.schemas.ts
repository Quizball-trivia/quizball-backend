import { z } from 'zod';
import { moveSchema } from '../wordgame-daily/wordgame-daily.shared.js';
import { DF_OPTIONS } from '../room/games/dato-falso/dato-falso.rules.js';

export const jokerSchema = moveSchema.extend({ kind: z.enum(['cut', 'double']) });
export type JokerRequest = z.infer<typeof jokerSchema>;
export const pickSchema = moveSchema.extend({ option: z.number().int().min(0).max(DF_OPTIONS - 1) });
export type PickRequest = z.infer<typeof pickSchema>;
