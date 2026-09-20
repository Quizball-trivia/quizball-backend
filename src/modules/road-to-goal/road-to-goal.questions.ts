import type { I18nField, Json } from '../../db/types.js';
import { randomBytes } from 'node:crypto';
import {
  ROAD_TO_GOAL_ACCURACY_PRIORS_BP,
  ROAD_TO_GOAL_DIFFICULTIES,
} from './road-to-goal.constants.js';
import type {
  RoadToGoalDifficulty,
  RoadToGoalQuestionCandidate,
  RoadToGoalQuestionImage,
  RoadToGoalQuestionSelectionMode,
  RoadToGoalQuestionSnapshot,
} from './road-to-goal.types.js';

interface McqOption {
  id: string;
  text: I18nField;
  is_correct: boolean;
}

function parseJson(value: Json): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseI18n(value: unknown): I18nField | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.length === 0
    || entries.some(([locale, text]) => locale.length > 10 || typeof text !== 'string' || text.length === 0)
  ) {
    return null;
  }
  return Object.fromEntries(entries) as I18nField;
}

function parseOptions(payload: Json): McqOption[] | null {
  const parsed = parseJson(payload);
  const rawOptions = (parsed as { options?: unknown } | null)?.options;
  if (!Array.isArray(rawOptions) || rawOptions.length !== 4) return null;

  const options: McqOption[] = [];
  const ids = new Set<string>();
  for (const rawOption of rawOptions) {
    const option = rawOption as { id?: unknown; text?: unknown; is_correct?: unknown };
    const text = parseI18n(option.text);
    if (
      typeof option.id !== 'string'
      || option.id.length === 0
      || option.id.length > 64
      || ids.has(option.id)
      || text == null
      || typeof option.is_correct !== 'boolean'
    ) {
      return null;
    }
    ids.add(option.id);
    options.push({ id: option.id, text, is_correct: option.is_correct });
  }

  return options.filter((option) => option.is_correct).length === 1 ? options : null;
}

function parseImage(payload: Json): RoadToGoalQuestionImage | null | undefined {
  const parsed = parseJson(payload);
  const rawImage = (parsed as { image?: unknown } | null)?.image;
  if (rawImage == null) return undefined;
  if (typeof rawImage !== 'object' || Array.isArray(rawImage)) return null;

  const image = rawImage as {
    url?: unknown;
    width?: unknown;
    height?: unknown;
    aspect_ratio?: unknown;
  };
  if (
    typeof image.url !== 'string'
    || image.url.length === 0
    || !Number.isInteger(image.width)
    || (image.width as number) <= 0
    || !Number.isInteger(image.height)
    || (image.height as number) <= 0
    || (image.aspect_ratio != null && typeof image.aspect_ratio !== 'string')
  ) {
    return null;
  }

  try {
    const url = new URL(image.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  return {
    url: image.url,
    width: image.width as number,
    height: image.height as number,
    ...(image.aspect_ratio ? { aspect_ratio: image.aspect_ratio } : {}),
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function parseCandidate(
  candidate: RoadToGoalQuestionCandidate,
  random: () => number
): RoadToGoalQuestionSnapshot | null {
  const prompt = parseI18n(parseJson(candidate.prompt));
  const options = parseOptions(candidate.payload);
  const image = parseImage(candidate.payload);
  if (!prompt || !options || image === null) return null;

  const correct = options.find((option) => option.is_correct);
  if (!correct) return null;
  return {
    commitment_salt: randomBytes(32).toString('hex'),
    question_id: candidate.id,
    difficulty: candidate.difficulty,
    prompt,
    ...(image ? { image } : {}),
    options: shuffled(options, random).map(({ id, text }) => ({ id, text })),
    correct_option_id: correct.id,
    expected_accuracy_bp: ROAD_TO_GOAL_ACCURACY_PRIORS_BP[candidate.difficulty],
    calibration_source: 'difficulty_prior',
  };
}

/** Builds the fixed easy/easy/easy/easy, medium×4, hard×3 progression. Invalid
 * legacy payloads are skipped rather than leaking malformed questions to a run. */
export function buildRoadToGoalQuestionSet(
  candidates: RoadToGoalQuestionCandidate[],
  random: () => number = Math.random,
  mode: RoadToGoalQuestionSelectionMode = 'unseen'
): RoadToGoalQuestionSnapshot[] | null {
  const byDifficulty: Record<RoadToGoalDifficulty, RoadToGoalQuestionSnapshot[]> = {
    easy: [],
    medium: [],
    hard: [],
  };
  const seen = new Set<string>();

  const orderedCandidates = mode === 'least_exposed'
    ? [...candidates].sort(
        (left, right) => (left.selection_priority ?? Number.MAX_SAFE_INTEGER)
          - (right.selection_priority ?? Number.MAX_SAFE_INTEGER)
      )
    : shuffled(candidates, random);

  for (const candidate of orderedCandidates) {
    if (seen.has(candidate.id)) continue;
    const parsed = parseCandidate(candidate, random);
    if (!parsed) continue;
    seen.add(candidate.id);
    byDifficulty[candidate.difficulty].push(parsed);
  }

  const selected: RoadToGoalQuestionSnapshot[] = [];
  for (const difficulty of ROAD_TO_GOAL_DIFFICULTIES) {
    const question = byDifficulty[difficulty].shift();
    if (!question) return null;
    selected.push(question);
  }
  return selected;
}
