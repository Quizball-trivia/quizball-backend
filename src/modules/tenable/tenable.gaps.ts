import type { GapSeen, GapVerdict } from '../content-gaps/content-gaps.buffer.js';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import type { TenableList } from './tenable.content.js';
import { sharedReadings, TENABLE_JUDGE_VERSION, type Directory } from './tenable.identify.js';

const GAP_OF: Partial<Record<string, GapVerdict>> = { unknown: 'unknown', ambiguous: 'ambiguous', wrong: 'miss' };

/** A Tenable answer as a content gap: an unknown or ambiguous text, or a real entity the list does not hold. */
export function tenableGap(kind: string, text: string, eid: string | null, list: TenableList, directory: Directory | null): GapSeen | null {
  const gap = GAP_OF[kind];
  if (!gap || !text) return null;
  return {
    game: 'tenable',
    boardKey: list.id,
    // Clubs and nations carry pinned alias overlays: their (small) directory's keys, hashed once per loaded directory,
    // say which. People keep their names (no overlay), so a player directory is never hashed here.
    context: `${list.kind}|${list.release}|m${list.matcher}j${TENABLE_JUDGE_VERSION}|ru${directory?.russian ? '+' : '-'}${directory?.greek ? 'el+' : ''}|d${directory && list.kind !== 'player' ? revisionOf(directory, (d: Directory) => d.identifyingKeys().sort()) : '-'}|${revisionOf(list)}`,
    verdict: gap,
    text,
    resolvedId: eid,
    // A shared name charged as a miss still names every holder: the Content Fixer may need a holder other than the charged one.
    candidateIds: gap === 'ambiguous' ? directory?.candidates?.(text) ?? null : gap === 'miss' ? sharedHolders(directory, text) : null,
  };
}

const sharedHolders = (directory: Directory | null, text: string): string[] | null => {
  const holders = directory ? sharedReadings(directory, text) : [];
  return holders.length > 1 ? holders.slice(0, 10) : null;
};
