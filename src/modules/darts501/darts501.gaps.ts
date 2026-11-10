import type { GapSeen, GapVerdict } from '../content-gaps/content-gaps.buffer.js';
import { revisionOf } from '../content-gaps/content-gaps.context.js';
import type { Directory } from '../tenable/tenable.identify.js';
import type { D501Category } from './darts501.content.js';
import type { DartVerdict } from './darts501.rules.js';

const GAP_OF: Partial<Record<DartVerdict, GapVerdict>> = { unknown: 'unknown', ambiguous: 'ambiguous', uncovered: 'uncovered', miss: 'miss' };

/** One judged dart or free answer as a content gap, or null when the verdict is not one (a score, a repeat…). */
export function dartsGap(verdict: DartVerdict, text: string, eid: string | null, category: D501Category, directory: Directory | null): GapSeen | null {
  const gap = GAP_OF[verdict];
  if (!gap) return null;
  return {
    game: 'darts501',
    boardKey: category.id,
    // Player names carry no alias overlay; the Russian names are the only optional layer on the release.
    context: `${category.release}|${category.coverage}|m${category.matcher}|ru${directory?.russian ? '+' : '-'}|${revisionOf(category)}`,
    verdict: gap,
    text,
    resolvedId: eid,
    candidateIds: gap === 'ambiguous' ? directory?.candidates?.(text) ?? null : null,
  };
}
