import { createHash } from 'node:crypto';
import type { GapSeen } from '../content-gaps/content-gaps.buffer.js';
import type { Universe } from './footballers.universe.js';

const short = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * Diagnostics only (scoring is untouched): `resolve` is the release-wide reading, so `resolvedId` is who the text most
 * likely meant, not proof of anything.
 *
 * "Played for both": a text the pair did not accept. Nobody the release knows → unknown; one footballer → a miss (he
 * may have played for both and the pair lacks him); several namesakes → ambiguous.
 */
export function sharedPlayerGap(universe: Universe, pair: { a: { key: string }; b: { key: string }; accepted: readonly string[] }, text: string, russianVersion?: string | null): GapSeen | null {
  if (!text.trim()) return null;
  const pids = universe.resolve(text);
  return {
    game: 'shared_player',
    boardKey: [pair.a.key, pair.b.key].sort().join('|'),
    context: `${universe.releaseId}|ru:${russianVersion ?? '-'}|${short([...pair.accepted].sort())}`,
    verdict: pids.length === 0 ? 'unknown' : pids.length === 1 ? 'miss' : 'ambiguous',
    text,
    resolvedId: pids.length === 1 ? pids[0] : null,
    candidateIds: pids.length > 1 ? pids.slice(0, 10) : null,
  };
}

/** The name chain: a name the release does not know (a refusal for the letter or a repeat is the player's, not ours). */
export function nameChainGap(universe: Universe, text: string, russianVersion?: string | null): GapSeen | null {
  if (!text.trim() || universe.resolve(text).length > 0) return null;
  return { game: 'name_chain', boardKey: universe.releaseId, context: `${universe.releaseId}|ru:${russianVersion ?? '-'}`, verdict: 'unknown', text };
}
