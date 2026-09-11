import { z } from 'zod';
export const season3MatchSchema = z.object({ matchId: z.string().uuid() }).strict();
const base = { matchId: z.string().uuid(), locale: z.enum(['en','ka','es','tr']) };
export const season3ResponseSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('vote'), removeOrder: z.boolean(), removeWho: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('idea'), idea: z.string().trim().min(1).max(500) }).strict(),
]);
export type Season3Response = z.infer<typeof season3ResponseSchema>;
