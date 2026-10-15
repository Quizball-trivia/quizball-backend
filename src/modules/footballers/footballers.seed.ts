import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeName } from './footballers.text.js';
import { MATCHER_VERSION } from './footballers.universe.js';

/** Every limit here mirrors a CHECK of wordgame_releases / wordgame_players: a file that passes can be written. */
const playerSchema = z.object({
  pid: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  game: z.string().min(1).max(80),
  fame: z.number().int().min(0).max(100),
  aliases: z.array(z.string().min(1).max(80)).max(16).default([]),
}).strict();

export const releaseFileSchema = z.object({
  release: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/), matcherVersion: z.number().int().positive() }).strict(),
  players: z.array(playerSchema).min(1),
}).strict();
export type ReleaseFile = z.infer<typeof releaseFileSchema>;

export interface CheckedRelease { file: ReleaseFile; fingerprint: string }

/** Validates a release file beyond its shape; throws with a message that never quotes a name. */
export function checkRelease(raw: unknown): CheckedRelease {
  const parsed = releaseFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid release: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.code}`).join('; ')}`);
  const file = parsed.data;
  if (file.release.matcherVersion !== MATCHER_VERSION) throw new Error(`Release was built for matcher ${file.release.matcherVersion}; this build has ${MATCHER_VERSION}`);
  if (new Set(file.players.map((p) => p.pid)).size !== file.players.length) throw new Error('Duplicate footballer id in the release');
  // A name with no letter of the games' alphabet can neither start nor continue a chain.
  const unusable = file.players.filter((p) => !/[a-z]/.test(normalizeName(p.name)) || !/[a-z]/.test(normalizeName(p.game))).length;
  if (unusable > 0) throw new Error(`${unusable} footballers have a name without a Latin letter`);
  const canonical = [...file.players].sort((a, b) => (a.pid < b.pid ? -1 : 1)).map((p) => [p.pid, p.name, p.game, p.fame, p.aliases]);
  const fingerprint = createHash('sha256').update(JSON.stringify([file.release.matcherVersion, canonical])).digest('hex').slice(0, 32);
  return { file, fingerprint };
}
