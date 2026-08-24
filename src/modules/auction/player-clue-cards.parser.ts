import type { ClueCardDifficulty, ParsedClueRow } from './player-clue-cards.types.js';

const PLAYER_PREFIX = /^Player\s+(\d+)\s*/i;
const CLUE_MARKER = /Clue\s+(\d+)\s*:/gi;
// Answer runs to "Difficulty:" OR a trailing bare difficulty word
// ("Answer: Lionel Messi. Easy" / "Answer: Lionel Messi Easy") OR end of block.
const ANSWER_PATTERN =
  /Answer\s*:\s*(.+?)(?:[.\s]+(?:Difficulty\s*:\s*)?(?:easy|medium|hard))?\s*$/i;
const DIFFICULTY_PATTERN = /Difficulty\s*:\s*(easy|medium|hard)\b/i;
const ANY_DIFFICULTY_PATTERN = /Difficulty\s*:\s*(\S+)/i;
// A bare difficulty word right after the answer, with or without "Difficulty:".
const TRAILING_DIFFICULTY_PATTERN =
  /Answer\s*:\s*.+?[.\s]+(?:Difficulty\s*:\s*)?(easy|medium|hard)\s*$/i;

const MIN_CLUE_LENGTH = 10;
const MAX_CLUE_LENGTH = 300;

export function parsePlayerClueFile(
  text: string,
  defaultDifficulty: ClueCardDifficulty = 'medium'
): { rows: ParsedClueRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: ParsedClueRow[] = [];
  const errors: string[] = [];

  let currentBlock: string[] = [];
  let currentPlayerNumber: number | null = null;
  let blockStartLine = 0;

  function flushBlock(): void {
    if (currentBlock.length === 0) return;

    const blockText = currentBlock.join(' ').trim();
    if (!blockText) {
      currentBlock = [];
      currentPlayerNumber = null;
      return;
    }

    const parsed = parseBlock(blockText, currentPlayerNumber, defaultDifficulty, blockStartLine);
    if (parsed) {
      rows.push(parsed);
    } else {
      errors.push(`Line ${blockStartLine + 1}: could not parse player block`);
    }

    currentBlock = [];
    currentPlayerNumber = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const playerMatch = line.match(PLAYER_PREFIX);

    if (playerMatch && !line.match(/^Clue\s+\d+/i) && !line.match(/^Answer\s*:/i)) {
      flushBlock();
      currentPlayerNumber = parseInt(playerMatch[1], 10);
      blockStartLine = i;

      const restOfLine = line.slice(playerMatch[0].length).trim();
      if (restOfLine.length > 0) {
        currentBlock.push(restOfLine);
      }
    } else {
      currentBlock.push(line);
    }
  }

  flushBlock();

  rows.sort((a, b) => a.rowIndex - b.rowIndex);
  for (let i = 0; i < rows.length; i++) {
    rows[i].rowIndex = i + 1;
  }

  return { rows, errors };
}

function parseBlock(
  blockText: string,
  sourcePlayerNumber: number | null,
  defaultDifficulty: ClueCardDifficulty,
  _lineNumber: number
): ParsedClueRow | null {
  const warnings: string[] = [];
  const validationErrors: string[] = [];
  const factRiskFlags: string[] = [];

  const clues: string[] = [];
  const markers: Array<{ index: number; num: number; end: number }> = [];
  let markerMatch: RegExpExecArray | null;
  const markerRegex = new RegExp(CLUE_MARKER.source, 'gi');
  while ((markerMatch = markerRegex.exec(blockText)) !== null) {
    markers.push({
      index: markerMatch.index,
      num: parseInt(markerMatch[1], 10),
      end: markerMatch.index + markerMatch[0].length,
    });
  }

  const answerIdx = blockText.search(/Answer\s*:/i);
  const difficultyIdx = blockText.search(/Difficulty\s*:/i);
  const contentEnd = answerIdx >= 0 ? answerIdx : (difficultyIdx >= 0 ? difficultyIdx : blockText.length);

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker.num < 1 || marker.num > 3) continue;
    const nextBoundary = i + 1 < markers.length ? markers[i + 1].index : contentEnd;
    const clueText = blockText.slice(marker.end, nextBoundary).trim();
    while (clues.length < marker.num - 1) clues.push('');
    clues[marker.num - 1] = clueText;
  }

  const answerMatch = blockText.match(ANSWER_PATTERN);
  if (!answerMatch) {
    return null;
  }
  const answerName = answerMatch[1].trim();
  if (!answerName) {
    return null;
  }

  // Difficulty may come as "Difficulty: X" or as a bare word trailing the
  // answer ("Answer: Lionel Messi. Easy"). When neither is present we leave it
  // unset and flag for AI rating downstream.
  const difficultyMatch = blockText.match(DIFFICULTY_PATTERN);
  const trailingMatch = blockText.match(TRAILING_DIFFICULTY_PATTERN);
  const anyDifficultyMatch = blockText.match(ANY_DIFFICULTY_PATTERN);
  let difficulty: ClueCardDifficulty;
  let difficultySource: 'row' | 'default';

  const explicit = difficultyMatch?.[1] ?? trailingMatch?.[1];
  if (explicit) {
    difficulty = explicit.toLowerCase() as ClueCardDifficulty;
    difficultySource = 'row';
  } else if (anyDifficultyMatch) {
    validationErrors.push(`Invalid difficulty "${anyDifficultyMatch[1]}"`);
    difficulty = defaultDifficulty;
    difficultySource = 'default';
  } else {
    difficulty = defaultDifficulty;
    difficultySource = 'default';
    warnings.push('difficulty_defaulted');
  }

  if (clues.length < 3) {
    validationErrors.push(`Expected 3 clues, found ${clues.length}`);
  }
  if (clues.length > 3) {
    validationErrors.push(`Expected 3 clues, found ${clues.length} — extra clues ignored`);
  }

  const clue1 = clues[0] ?? '';
  const clue2 = clues[1] ?? '';
  const clue3 = clues[2] ?? '';

  validateClue(clue1, answerName, validationErrors, 1);
  validateClue(clue2, answerName, validationErrors, 2);
  validateClue(clue3, answerName, validationErrors, 3);

  if (clue1 && clue2 && clue1.toLowerCase() === clue2.toLowerCase()) {
    validationErrors.push('Clue 1 and Clue 2 are identical');
  }
  if (clue2 && clue3 && clue2.toLowerCase() === clue3.toLowerCase()) {
    validationErrors.push('Clue 2 and Clue 3 are identical');
  }
  if (clue1 && clue3 && clue1.toLowerCase() === clue3.toLowerCase()) {
    validationErrors.push('Clue 1 and Clue 3 are identical');
  }

  return {
    rowIndex: 0,
    sourcePlayerNumber,
    answerName,
    difficulty,
    difficultySource,
    clue1,
    clue2,
    clue3,
    warnings,
    validationErrors,
    factRiskFlags,
    originalText: blockText,
  };
}

function validateClue(
  clue: string,
  answerName: string,
  validationErrors: string[],
  clueNum: number
): void {
  if (!clue || clue.trim().length === 0) {
    validationErrors.push(`Clue ${clueNum} is empty`);
    return;
  }

  const trimmed = clue.trim();
  if (trimmed.length < MIN_CLUE_LENGTH) {
    validationErrors.push(`Clue ${clueNum} is too short (${trimmed.length} chars, min ${MIN_CLUE_LENGTH})`);
  }
  if (trimmed.length > MAX_CLUE_LENGTH) {
    validationErrors.push(`Clue ${clueNum} is too long (${trimmed.length} chars, max ${MAX_CLUE_LENGTH})`);
  }

  // Only flag a genuine leak: the FULL answer name appearing in a clue.
  // Common football terms (record, World Cup, final, …) are expected content,
  // not risks, so we no longer flag them.
  const clueLower = clue.toLowerCase();
  const answerLower = answerName.toLowerCase().trim();
  if (answerLower.length >= 4 && clueLower.includes(answerLower)) {
    validationErrors.push(`Clue ${clueNum} contains the answer name`);
  }
}
