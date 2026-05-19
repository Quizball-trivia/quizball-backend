import type { MatchQuestionEvaluation } from '../modules/matches/matches.service.js';
import { clamp } from './scoring.js';

const MIN_PREFIX_LENGTH = 3;

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

export function fuzzyMatchesAnswer(input: string, acceptedAnswers: string[]): boolean {
  const normalizedInput = normalizeAnswer(input);
  if (!normalizedInput) return false;

  return acceptedAnswers.some((acceptedAnswer) => {
    const normalizedAccepted = normalizeAnswer(acceptedAnswer);
    if (!normalizedAccepted) return false;
    if (normalizedInput === normalizedAccepted) return true;
    if (normalizedInput.length >= 4 && normalizedAccepted.includes(normalizedInput)) return true;
    const maxDistance = normalizedAccepted.length > 6 ? 2 : 1;
    return levenshtein(normalizedInput, normalizedAccepted) <= maxDistance;
  });
}

export function countdownMatch(
  evaluation: Extract<MatchQuestionEvaluation, { kind: 'countdown' }>,
  guess: string,
  foundIds: Set<string>
): { id: string; display: Record<string, string> } | null {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return null;

  for (const answerGroup of evaluation.answerGroups) {
    if (foundIds.has(answerGroup.id)) continue;
    if (fuzzyMatchesAnswer(guess, answerGroup.acceptedAnswers)) {
      return {
        id: answerGroup.id,
        display: answerGroup.display,
      };
    }
  }

  if (normalizedGuess.length >= MIN_PREFIX_LENGTH) {
    const prefixCandidates: Array<{ id: string; display: Record<string, string> }> = [];
    for (const answerGroup of evaluation.answerGroups) {
      if (foundIds.has(answerGroup.id)) continue;
      const hasPrefix = answerGroup.acceptedAnswers.some((accepted) =>
        normalizeAnswer(accepted).startsWith(normalizedGuess)
      );
      if (hasPrefix) {
        prefixCandidates.push({ id: answerGroup.id, display: answerGroup.display });
      }
    }
    if (prefixCandidates.length === 1) {
      return prefixCandidates[0];
    }
  }

  return null;
}

export function clueIndexForTimeMs(clueCount: number, timeMs: number, questionTimeMs: number): number {
  if (clueCount <= 1) return 0;
  const sliceMs = questionTimeMs / clueCount;
  return clamp(Math.floor(timeMs / sliceMs), 0, clueCount - 1);
}

export function shouldFinalizeWrongCluesGuess(params: {
  clueCount: number;
  currentAnswerCount: number;
  expectedCount: number;
  existingRevealCount: number;
  timedClueIndex: number;
}): boolean {
  const opponentAlreadyAnswered = params.expectedCount > 1
    && params.currentAnswerCount >= params.expectedCount - 1;
  if (opponentAlreadyAnswered) return true;

  const nextRevealCount = clamp(
    Math.max(params.existingRevealCount, params.timedClueIndex + 2),
    1,
    params.clueCount
  );
  return nextRevealCount >= params.clueCount;
}
