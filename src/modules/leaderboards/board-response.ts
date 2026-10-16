import { z } from 'zod';

export const nextTargetSchema = z.object({
  username: z.string(),
  rank: z.number().int().positive(),
  /** Points still needed to move above that player. */
  gap: z.number().int().positive(),
}).nullable();

export type NextTarget = z.infer<typeof nextTargetSchema>;

/** The player one place up and the points it takes to pass them. */
export function nextTargetOf(
  rank: number,
  points: number,
  above: { username: string; points: number } | null | undefined,
): NextTarget {
  if (!above || rank <= 1) return null;
  return { username: above.username, rank: rank - 1, gap: Math.max(1, above.points - points + 1) };
}
