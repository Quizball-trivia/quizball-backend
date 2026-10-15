import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeName, normalizeNameCyrillic } from './footballers.text.js';
import { SUPPORTED_MATCHER_VERSIONS } from './footballers.universe.js';

/** Every limit here mirrors a CHECK of wordgame_releases / wordgame_players: a file that passes can be written. */
const playerSchema = z.object({
  pid: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  game: z.string().min(1).max(80),
  fame: z.number().int().min(0).max(100),
  aliases: z.array(z.string().min(1).max(80)).max(16).default([]),
  /** Matcher 2: the Russian name and the Russian name the footballer is known by, both or neither. */
  nameRu: z.string().min(1).max(80).optional(),
  gameRu: z.string().min(1).max(80).optional(),
}).strict().refine((p) => (p.nameRu === undefined) === (p.gameRu === undefined), 'nameRu and gameRu come together');

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
  const version = file.release.matcherVersion;
  if (!SUPPORTED_MATCHER_VERSIONS.includes(version)) throw new Error(`Release was built for matcher ${version}; this build supports ${SUPPORTED_MATCHER_VERSIONS.join(', ')}`);
  const russian = file.players.filter((p) => p.nameRu !== undefined);
  if (version < 2 && russian.length > 0) throw new Error('Russian names need matcher 2');
  if (version >= 2 && russian.length === 0) throw new Error('A matcher-2 release carries Russian names');
  // A Russian name with no Cyrillic letter could neither start nor continue a Russian chain.
  const noCyrillic = russian.filter((p) => !/[а-я]/.test(normalizeNameCyrillic(p.nameRu!)) || !/[а-я]/.test(normalizeNameCyrillic(p.gameRu!))).length;
  if (noCyrillic > 0) throw new Error(`${noCyrillic} footballers have a Russian name without a Cyrillic letter`);
  if (new Set(file.players.map((p) => p.pid)).size !== file.players.length) throw new Error('Duplicate footballer id in the release');
  // A name with no letter of the games' alphabet can neither start nor continue a chain.
  const unusable = file.players.filter((p) => !/[a-z]/.test(normalizeName(p.name)) || !/[a-z]/.test(normalizeName(p.game))).length;
  if (unusable > 0) throw new Error(`${unusable} footballers have a name without a Latin letter`);
  // Matcher-1 fingerprints stay exactly as they were; matcher 2 also covers the Russian names.
  const canonical = [...file.players].sort((a, b) => (a.pid < b.pid ? -1 : 1))
    .map((p) => (version < 2 ? [p.pid, p.name, p.game, p.fame, p.aliases] : [p.pid, p.name, p.game, p.fame, p.aliases, p.nameRu ?? null, p.gameRu ?? null]));
  const fingerprint = createHash('sha256').update(JSON.stringify([file.release.matcherVersion, canonical])).digest('hex').slice(0, 32);
  return { file, fingerprint };
}
