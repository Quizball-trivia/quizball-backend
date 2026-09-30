import { boundedLevenshtein, footballGridOrthographicKey, footballGridTypoDistanceLimit, normalizeFootballGridAnswer } from '../football-grid/football-grid.answer-resolver.js';
import type { SquadSpinAliasRow } from './squad-spin.types.js';

interface AnswerCandidate {
  playerId: string;
  text: string;
}

/**
 * Name forms a player is reasonably called by: the full normalised name plus
 * every token suffix ("ramiro funes mori" → "funes mori" → "mori"). The alias
 * release feeding Squad Spin is missing surname forms for ~40% of players and
 * compound surnames ("Funes Mori") never got one at all, so names are matched
 * directly instead of trusting alias coverage.
 */
function nameForms(playerId: string, name: string): AnswerCandidate[] {
  const normalized = normalizeFootballGridAnswer(name);
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  const forms: AnswerCandidate[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const text = tokens.slice(i).join(' ');
    if (text.length >= 2) forms.push({ playerId, text });
  }
  return forms;
}

/**
 * Resolves typed text against the combo's VALID answers only — their aliases
 * and their name forms — so any match is a correct answer. Because every
 * candidate names a valid player, typo tolerance (the same length-scaled
 * distance limit the live Grid uses) is safe against all of them: a near-miss
 * can only credit an answer that was right anyway. Several valid players
 * sharing a surname resolve to the nearest one — all of them are right.
 */
export function resolveSquadSpinAnswer(
  submittedText: string,
  aliases: SquadSpinAliasRow[],
  players: Array<{ id: string; name_en: string; name_ka?: string | null }>,
): { playerId: string | null; normalizedInput: string } {
  const normalizedInput = normalizeFootballGridAnswer(submittedText);
  if (!normalizedInput) return { playerId: null, normalizedInput };

  const candidates: AnswerCandidate[] = [
    ...aliases.map((alias) => ({ playerId: alias.player_id, text: alias.normalized_alias })),
    ...players.flatMap((player) => [
      ...nameForms(player.id, player.name_en),
      ...(player.name_ka ? nameForms(player.id, player.name_ka) : []),
    ]),
  ];

  // Turkish dotless-ı and ß keyboard variants fold like the live Grid.
  const keyboardKey = footballGridOrthographicKey(normalizedInput);
  const exact = candidates.find((candidate) => footballGridOrthographicKey(candidate.text) === keyboardKey);
  if (exact) return { playerId: exact.playerId, normalizedInput };

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) return { playerId: null, normalizedInput };
  let best: { playerId: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = boundedLevenshtein(keyboardKey, footballGridOrthographicKey(candidate.text), limit);
    if (distance <= limit && (!best || distance < best.distance)) best = { playerId: candidate.playerId, distance };
  }
  return { playerId: best?.playerId ?? null, normalizedInput };
}
