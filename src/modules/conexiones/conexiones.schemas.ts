import { z } from 'zod';
import { moveSchema } from '../wordgame-daily/wordgame-daily.shared.js';
import { CX_GROUP_SIZE } from '../room/games/conexiones/conexiones.rules.js';

export const openSchema = moveSchema.strict();
export const guessSchema = moveSchema.extend({ ids: z.array(z.string().regex(/^[a-z0-9]{8}$/)).length(CX_GROUP_SIZE) }).strict();
export type GuessRequest = z.infer<typeof guessSchema>;
