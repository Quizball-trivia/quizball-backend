import type { DailyChallengeType } from './daily-challenges.schemas.js';

/**
 * Content tags for "more like the one you just played". Deliberately coarse —
 * three axes a player would actually recognise:
 *  quiz      — you answer questions from options/text
 *  guessing  — you deduce an identity or a hidden value
 *  timed     — the clock is the main pressure
 *  wager     — you stake something on your confidence
 */
export const DAILY_CHALLENGE_TAGS: Record<DailyChallengeType, readonly string[]> = {
  moneyDrop: ['quiz', 'wager'],
  trueFalse: ['quiz', 'timed'],
  clues: ['guessing'],
  countdown: ['timed', 'quiz'],
  putInOrder: ['quiz'],
  imposter: ['guessing', 'quiz'],
  careerPath: ['guessing'],
  highLow: ['guessing', 'wager'],
  footballLogic: ['quiz'],
  missingXi: ['guessing', 'timed'],
  passChain: ['guessing', 'timed'],
  statSniper: ['guessing', 'timed'],
  fifaCards: ['guessing'],
  cardDetective: ['guessing'],
};

export interface DailyChallengeRankingInput {
  /** Every challenge the player could start right now (already filtered). */
  candidates: DailyChallengeType[];
  /** Distinct players who finished each challenge today. */
  playersToday: Map<string, number>;
  /** The player's own completions over the recent window. */
  playsByUser: Map<string, number>;
  /** What they just finished — drives the similarity bonus. */
  justPlayed?: DailyChallengeType | null;
}

export interface RankedDailyChallenge {
  challengeType: DailyChallengeType;
  score: number;
  /** Why it was picked — surfaced for analytics, not shown to players. */
  reason: 'trending' | 'similar' | 'fresh';
}

/**
 * Ranks what to play next from three cheap signals, the small honest version of
 * a streaming-service row:
 *
 *  trending — distinct players who finished it today (normalised 0–1)
 *  similar  — shares a tag with the challenge just played
 *  fresh    — the player has played it least over the recent window
 *
 * The result is deliberately DIVERSE: the top pick is whatever scores highest,
 * then later picks are penalised for repeating an already-chosen tag, so the
 * row never becomes two of the same thing.
 */
export function rankDailyChallenges(
  input: DailyChallengeRankingInput,
  limit = 2
): RankedDailyChallenge[] {
  const { candidates, playersToday, playsByUser, justPlayed } = input;
  if (candidates.length === 0) return [];

  const maxPlayers = Math.max(1, ...candidates.map((type) => playersToday.get(type) ?? 0));
  const maxPlays = Math.max(1, ...candidates.map((type) => playsByUser.get(type) ?? 0));
  const justPlayedTags = new Set(justPlayed ? DAILY_CHALLENGE_TAGS[justPlayed] ?? [] : []);

  const scored = candidates.map((challengeType) => {
    const trending = (playersToday.get(challengeType) ?? 0) / maxPlayers;
    // Inverted: fewer personal plays scores higher.
    const freshness = 1 - (playsByUser.get(challengeType) ?? 0) / maxPlays;
    const tags = DAILY_CHALLENGE_TAGS[challengeType] ?? [];
    const similarity = justPlayedTags.size === 0
      ? 0
      : tags.filter((tag) => justPlayedTags.has(tag)).length / justPlayedTags.size;

    const score = trending * 0.4 + freshness * 0.35 + similarity * 0.25;
    const reason: RankedDailyChallenge['reason'] =
      similarity >= 0.5 ? 'similar' : trending >= freshness ? 'trending' : 'fresh';
    return { challengeType, score, reason, tags };
  });

  const picked: RankedDailyChallenge[] = [];
  const usedTags = new Set<string>();
  while (picked.length < limit && picked.length < scored.length) {
    let best: (typeof scored)[number] | null = null;
    let bestScore = -Infinity;
    for (const candidate of scored) {
      if (picked.some((item) => item.challengeType === candidate.challengeType)) continue;
      // Diversity: repeating a tag already on the row costs the candidate. The
      // penalty scales with how much of the candidate IS the repeated tag, so a
      // second pure-"guessing" pick loses its whole score while a mixed one
      // (e.g. quiz+wager after quiz) only loses part.
      const overlap = candidate.tags.filter((tag) => usedTags.has(tag)).length;
      const overlapShare = candidate.tags.length === 0 ? 0 : overlap / candidate.tags.length;
      const adjusted = candidate.score - overlapShare * 0.6;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        best = candidate;
      }
    }
    if (!best) break;
    picked.push({ challengeType: best.challengeType, score: best.score, reason: best.reason });
    for (const tag of best.tags) usedTags.add(tag);
  }
  return picked;
}
