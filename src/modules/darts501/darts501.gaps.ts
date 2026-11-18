import type { GapSeen, GapVerdict } from '../content-gaps/content-gaps.buffer.js';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import { sharedReadings, TENABLE_JUDGE_VERSION, type Directory } from '../tenable/tenable.identify.js';
import type { D501Category } from './darts501.content.js';
import { DARTS_JUDGE_REVISION, type DartVerdict } from './darts501.rules.js';

const GAP_OF: Partial<Record<DartVerdict, GapVerdict>> = { unknown: 'unknown', ambiguous: 'ambiguous', uncovered: 'uncovered', miss: 'miss' };

/** One judged dart or free answer as a content gap, or null when the verdict is not one (a score, a repeat…). */
export function dartsGap(verdict: DartVerdict, text: string, eid: string | null, category: D501Category, directory: Directory | null): GapSeen | null {
  const gap = GAP_OF[verdict];
  if (!gap) return null;
  return {
    game: 'darts501',
    boardKey: category.id,
    // Player names carry no alias overlay; the Russian and Greek names are the only optional layers on the release.
    context: `${category.release}|${category.coverage}|m${category.matcher}j${TENABLE_JUDGE_VERSION}d${DARTS_JUDGE_REVISION}|ru${directory?.russian ? '+' : '-'}${directory?.greek ? 'el+' : ''}|${revisionOf(category)}`,
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
