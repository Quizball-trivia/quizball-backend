import type { GapSeen, GapVerdict } from '../content-gaps/content-gaps.buffer.js';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import type { TenableList } from './tenable.content.js';
import type { Directory } from './tenable.identify.js';

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
    context: `${list.kind}|${list.release}|m${list.matcher}|ru${directory?.russian ? '+' : '-'}|d${directory && list.kind !== 'player' ? revisionOf(directory, (d: Directory) => d.identifyingKeys().sort()) : '-'}|${revisionOf(list)}`,
    verdict: gap,
    text,
    resolvedId: eid,
    candidateIds: gap === 'ambiguous' ? directory?.candidates?.(text) ?? null : null,
  };
}
