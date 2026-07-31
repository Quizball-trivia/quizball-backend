import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';

const MIN_PREFIX_LENGTH = 3;

type AcceptedAnswerMatchKind = 'exact' | 'wholeWord' | 'alias' | 'typo';

interface AcceptedAnswerMatch {
  kind: AcceptedAnswerMatchKind;
  distance: number;
}

interface CountdownCandidate {
  id: string;
  display: Record<string, string>;
  match: AcceptedAnswerMatch;
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function levenshtein(left: string, right: string): number {
  const matrix: number[][] = [];
  for (let row = 0; row <= right.length; row += 1) {
    matrix[row] = [row];
  }
  for (let column = 0; column <= left.length; column += 1) {
    matrix[0][column] = column;
  }
  for (let row = 1; row <= right.length; row += 1) {
    for (let column = 1; column <= left.length; column += 1) {
      matrix[row][column] = right[row - 1] === left[column - 1]
        ? matrix[row - 1][column - 1]
        : Math.min(
            matrix[row - 1][column - 1] + 1,
            matrix[row][column - 1] + 1,
            matrix[row - 1][column] + 1
          );
    }
  }
  return matrix[right.length][left.length];
}

// Whole-word match: input must appear as a complete token in the accepted
// answer (surrounded by string boundaries or whitespace), not as an interior
// substring. After normalizeAnswer, the only separators are single spaces.
function containsWholeWord(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  if (haystack.startsWith(`${needle} `)) return true;
  if (haystack.endsWith(` ${needle}`)) return true;
  return haystack.includes(` ${needle} `);
}

function answerTokens(value: string): string[] {
  return value.split(' ').filter(Boolean);
}

function tokensMatchByAlias(inputToken: string, acceptedToken: string): boolean {
  if (inputToken === acceptedToken) return true;

  const aliases = new Map([
    ['man', 'manchester'],
    ['utd', 'united'],
  ]);

  return aliases.get(inputToken) === acceptedToken
    || aliases.get(acceptedToken) === inputToken;
}

function hasTokenAliasMatch(normalizedInput: string, normalizedAccepted: string): boolean {
  const inputTokens = answerTokens(normalizedInput);
  const acceptedTokens = answerTokens(normalizedAccepted);
  if (inputTokens.length < 2 || inputTokens.length !== acceptedTokens.length) return false;

  return inputTokens.every((token, index) => tokensMatchByAlias(token, acceptedTokens[index]));
}

function maxTypoDistance(target: string): number {
  if (target.length < 5) return 0;
  return target.length > 6 ? 2 : 1;
}

function betterAcceptedMatch(
  current: AcceptedAnswerMatch | null,
  next: AcceptedAnswerMatch
): AcceptedAnswerMatch {
  if (!current) return next;

  const kindRank: Record<AcceptedAnswerMatchKind, number> = {
    exact: 3,
    wholeWord: 2,
    alias: 2,
    typo: 1,
  };

  const currentRank = kindRank[current.kind];
  const nextRank = kindRank[next.kind];
  if (nextRank !== currentRank) return nextRank > currentRank ? next : current;
  return next.distance < current.distance ? next : current;
}

function matchNormalizedAcceptedAnswer(
  normalizedInput: string,
  normalizedAccepted: string
): AcceptedAnswerMatch | null {
  if (!normalizedAccepted) return null;
  if (normalizedInput === normalizedAccepted) return { kind: 'exact', distance: 0 };
  if (containsWholeWord(normalizedAccepted, normalizedInput)) {
    return { kind: 'wholeWord', distance: 0 };
  }
  if (hasTokenAliasMatch(normalizedInput, normalizedAccepted)) {
    return { kind: 'alias', distance: 0 };
  }

  if (normalizedInput.length < 4) return null;

  const typoTargets = [normalizedAccepted, ...answerTokens(normalizedAccepted)];
  let bestTypo: AcceptedAnswerMatch | null = null;

  for (const target of typoTargets) {
    const allowedDistance = maxTypoDistance(target);
    if (allowedDistance <= 0) continue;

    const distance = levenshtein(normalizedInput, target);
    if (distance <= allowedDistance) {
      bestTypo = betterAcceptedMatch(bestTypo, { kind: 'typo', distance });
    }
  }

  return bestTypo;
}

function matchAcceptedAnswers(input: string, acceptedAnswers: string[]): AcceptedAnswerMatch | null {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return null;

  return acceptedAnswers.reduce<AcceptedAnswerMatch | null>((best, acceptedAnswer) => {
    const match = matchNormalizedAcceptedAnswer(normalizedInput, normalizeAnswer(acceptedAnswer));
    return match ? betterAcceptedMatch(best, match) : best;
  }, null);
}

export function fuzzyMatchesAnswer(input: string, acceptedAnswers: string[]): boolean {
  return matchAcceptedAnswers(input, acceptedAnswers) !== null;
}

export type ClueGuessRejectReason =
  | 'empty_normalized_guess'
  | 'empty_answer_set'
  | 'below_typo_min_length'
  | 'no_typo_eligible_target'
  | 'no_rule_matched'
  | 'give_up';

export interface ClueGuessCandidateExplanation {
  accepted: string;
  normalizedAccepted: string;
  matchedRule: AcceptedAnswerMatchKind | null;
  /** Distance of the match the matcher actually made, when it matched. */
  matchDistance: number | null;
  /**
   * Closest target the matcher was WILLING to typo-match (budget > 0), and the
   * budget that applied to it. Reporting the globally closest target instead
   * would be misleading: short tokens get a budget of 0, so a "distance 1,
   * allowed 0" pair would imply a near-miss the matcher never considered.
   * Null when no target was typo-eligible.
   */
  closestTypoTarget: string | null;
  bestDistance: number | null;
  allowedDistance: number;
  /** Closest target of any kind, ignoring eligibility. Context only. */
  nearestDistance: number | null;
}

export interface ClueGuessExplanation {
  normalizedGuess: string;
  matchedRule: AcceptedAnswerMatchKind | null;
  matchDistance: number | null;
  rejectReason: ClueGuessRejectReason | null;
  candidates: ClueGuessCandidateExplanation[];
}

/**
 * Read-only diagnosis of how `fuzzyMatchesAnswer` reached its verdict.
 *
 * Instrumentation ONLY — the live verdict still comes from
 * `fuzzyMatchesAnswer`; this never feeds back into scoring. It deliberately
 * calls the same private rule helpers rather than reimplementing them, so the
 * recorded explanation cannot drift from the rules actually applied.
 */
export function explainClueGuess(input: string, acceptedAnswers: string[]): ClueGuessExplanation {
  const normalizedGuess = normalizeAnswer(input);

  const candidates: ClueGuessCandidateExplanation[] = acceptedAnswers.map((accepted) => {
    const normalizedAccepted = normalizeAnswer(accepted);
    const match = normalizedGuess && normalizedAccepted
      ? matchNormalizedAcceptedAnswer(normalizedGuess, normalizedAccepted)
      : null;

    // Mirror the matcher's own target list, scoring typo-ELIGIBLE targets
    // separately from the global nearest, so the recorded budget always belongs
    // to the target it is reported against.
    const typoTargets = [normalizedAccepted, ...answerTokens(normalizedAccepted)];
    let closestTypoTarget: string | null = null;
    let bestDistance: number | null = null;
    let allowedDistance = 0;
    let nearestDistance: number | null = null;

    for (const target of typoTargets) {
      if (!target) continue;
      const distance = levenshtein(normalizedGuess, target);
      if (nearestDistance === null || distance < nearestDistance) {
        nearestDistance = distance;
      }
      const budget = maxTypoDistance(target);
      if (budget > 0 && (bestDistance === null || distance < bestDistance)) {
        closestTypoTarget = target;
        bestDistance = distance;
        allowedDistance = budget;
      }
    }

    return {
      accepted,
      normalizedAccepted,
      matchedRule: match?.kind ?? null,
      matchDistance: match ? match.distance : null,
      closestTypoTarget,
      bestDistance,
      allowedDistance,
      nearestDistance,
    };
  });

  // Use the distance the matcher itself produced rather than re-deriving it.
  const best = candidates.reduce<AcceptedAnswerMatch | null>((acc, candidate) => {
    if (!candidate.matchedRule) return acc;
    return betterAcceptedMatch(acc, {
      kind: candidate.matchedRule,
      distance: candidate.matchDistance ?? 0,
    });
  }, null);

  // Order matters: content-side failures are checked before guess-side ones, so
  // an unusable answer set is never mislabelled as "the player typed too little".
  let rejectReason: ClueGuessRejectReason | null = null;
  if (!best) {
    if (!normalizedGuess) rejectReason = 'empty_normalized_guess';
    else if (candidates.every((candidate) => !candidate.normalizedAccepted)) rejectReason = 'empty_answer_set';
    else if (candidates.every((candidate) => candidate.closestTypoTarget === null)) {
      // Every accepted answer was too short to earn a typo budget, so the typo
      // rule never ran. Distinct from a near-miss that blew a real budget —
      // conflating them points the investigation at the threshold instead of
      // at the fact that short names bypass typo matching entirely.
      rejectReason = 'no_typo_eligible_target';
    } else if (normalizedGuess.length < 4) rejectReason = 'below_typo_min_length';
    else rejectReason = 'no_rule_matched';
  }

  return {
    normalizedGuess,
    matchedRule: best?.kind ?? null,
    matchDistance: best ? best.distance : null,
    rejectReason,
    candidates,
  };
}

function hasPrefixMatch(acceptedAnswers: string[], normalizedGuess: string): boolean {
  return acceptedAnswers.some((accepted) => {
    const normalizedAccepted = normalizeAnswer(accepted);
    if (!normalizedAccepted) return false;
    return normalizedAccepted.startsWith(normalizedGuess)
      || answerTokens(normalizedAccepted).some((token) => token.startsWith(normalizedGuess));
  });
}

export function countdownMatch(
  evaluation: Extract<MatchQuestionEvaluation, { kind: 'countdown' }>,
  guess: string,
  foundIds: Set<string>
): { id: string; display: Record<string, string> } | null {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return null;

  const candidates = evaluation.answerGroups.reduce<CountdownCandidate[]>((matches, answerGroup) => {
    const match = matchAcceptedAnswers(guess, answerGroup.acceptedAnswers);
    if (match) {
      matches.push({
        id: answerGroup.id,
        display: answerGroup.display,
        match,
      });
    }
    return matches;
  }, []);

  for (const kind of ['exact', 'wholeWord', 'alias', 'typo'] satisfies AcceptedAnswerMatchKind[]) {
    const matchesForKind = candidates.filter((candidate) => candidate.match.kind === kind);
    if (matchesForKind.length > 0) {
      const uniqueGroupIds = new Set(matchesForKind.map((candidate) => candidate.id));
      if (uniqueGroupIds.size !== 1) return null;

      const candidate = matchesForKind[0];
      if (!foundIds.has(candidate.id)) {
        return {
          id: candidate.id,
          display: candidate.display,
        };
      }
    }
  }

  if (normalizedGuess.length >= MIN_PREFIX_LENGTH) {
    const prefixCandidates: Array<{ id: string; display: Record<string, string> }> = [];
    for (const answerGroup of evaluation.answerGroups) {
      if (hasPrefixMatch(answerGroup.acceptedAnswers, normalizedGuess)) {
        prefixCandidates.push({ id: answerGroup.id, display: answerGroup.display });
      }
    }
    if (prefixCandidates.length === 1) {
      const candidate = prefixCandidates[0];
      if (!foundIds.has(candidate.id)) return candidate;
    }
  }

  return null;
}

export function clueIndexForTimeMs(clueCount: number, timeMs: number, questionTimeMs: number): number {
  if (clueCount <= 1) return 0;
  const sliceMs = questionTimeMs / clueCount;
  return clamp(Math.floor(timeMs / sliceMs), 0, clueCount - 1);
}
