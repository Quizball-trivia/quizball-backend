import type {
  BuiltMatchQuestionPayload,
  MatchQuestionEvaluation,
} from '../modules/matches/matches.service.js';
import type {
  GameQuestionDTO,
  MatchQuestionKind,
  MatchRoundReveal,
  MultipleChoiceQuestionDTO,
} from './socket.types.js';

type LegacyMultipleChoiceQuestionDTO = Omit<MultipleChoiceQuestionDTO, 'kind'> & {
  kind?: 'multipleChoice';
};

type LegacyMatchQuestionPayload = Omit<BuiltMatchQuestionPayload, 'question' | 'evaluation' | 'reveal'> & {
  question: GameQuestionDTO | LegacyMultipleChoiceQuestionDTO;
  evaluation?: MatchQuestionEvaluation;
  reveal?: MatchRoundReveal;
  correctIndex?: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLegacyMultipleChoiceQuestionDTO(question: unknown): question is LegacyMultipleChoiceQuestionDTO {
  return isRecord(question) && 'prompt' in question && Array.isArray(question.options);
}

const KNOWN_QUESTION_KINDS = new Set<MatchQuestionKind>([
  'multipleChoice',
  'countdown',
  'putInOrder',
  'clues',
]);

function inferQuestionKind(question: unknown): MatchQuestionKind | null {
  if (isRecord(question) && typeof question.kind === 'string' && KNOWN_QUESTION_KINDS.has(question.kind as MatchQuestionKind)) {
    return question.kind as MatchQuestionKind;
  }

  if (isLegacyMultipleChoiceQuestionDTO(question)) {
    return 'multipleChoice';
  }

  return null;
}

function normalizeQuestionDTO(question: GameQuestionDTO | LegacyMultipleChoiceQuestionDTO): GameQuestionDTO | null {
  const kind = inferQuestionKind(question);
  if (kind === 'multipleChoice' && isLegacyMultipleChoiceQuestionDTO(question)) {
    return {
      ...question,
      kind: 'multipleChoice',
    };
  }

  return kind ? (question as GameQuestionDTO) : null;
}

export function getMultipleChoiceCorrectIndexFromPayload(payload: {
  question: GameQuestionDTO | LegacyMultipleChoiceQuestionDTO;
  evaluation?: MatchQuestionEvaluation;
  reveal?: MatchRoundReveal;
  correctIndex?: number | null;
}): number | null {
  if (inferQuestionKind(payload.question) !== 'multipleChoice') {
    return null;
  }

  if (payload.evaluation?.kind === 'multipleChoice') {
    return payload.evaluation.correctIndex;
  }

  if (payload.reveal?.kind === 'multipleChoice') {
    return payload.reveal.correctIndex;
  }

  if (typeof payload.correctIndex === 'number') {
    return payload.correctIndex;
  }

  return null;
}

export function normalizeMatchQuestionPayload(
  payload: LegacyMatchQuestionPayload | null
): BuiltMatchQuestionPayload | null {
  if (!payload) return null;

  const question = normalizeQuestionDTO(payload.question);
  if (!question) return null;

  const correctIndex = getMultipleChoiceCorrectIndexFromPayload(payload);
  const evaluation = payload.evaluation ?? (
    question.kind === 'multipleChoice' && typeof correctIndex === 'number'
      ? {
          kind: 'multipleChoice' as const,
          correctIndex,
        }
      : null
  );

  if (!evaluation) {
    return null;
  }

  const reveal = payload.reveal ?? (
    evaluation.kind === 'multipleChoice'
      ? {
          kind: 'multipleChoice' as const,
          correctIndex: evaluation.correctIndex,
        }
      : null
  );

  if (!reveal) {
    return null;
  }

  return {
    question,
    evaluation,
    reveal,
    categoryId: payload.categoryId,
    phaseKind: payload.phaseKind,
    phaseRound: payload.phaseRound,
    shooterSeat: payload.shooterSeat,
    attackerSeat: payload.attackerSeat,
  };
}

export function getCachedMultipleChoiceCorrectIndex(question: {
  kind?: MatchQuestionKind;
  correctIndex?: number | null;
  evaluation?: MatchQuestionEvaluation | null;
  questionDTO?: unknown;
}): number | null {
  const inferredKind = question.kind ?? inferQuestionKind(question.questionDTO);
  if (inferredKind !== 'multipleChoice') {
    return null;
  }

  if (question.evaluation?.kind === 'multipleChoice') {
    return question.evaluation.correctIndex;
  }

  if (typeof question.correctIndex === 'number') {
    return question.correctIndex;
  }

  return null;
}
