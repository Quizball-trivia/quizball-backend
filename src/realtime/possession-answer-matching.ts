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
  if (normalizedInput.length >= 4 && containsWholeWord(normalizedAccepted, normalizedInput)) {
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
