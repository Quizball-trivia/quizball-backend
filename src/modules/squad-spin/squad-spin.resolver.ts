import { boundedLevenshtein, footballGridOrthographicKey, footballGridTypoDistanceLimit, nameSuffixForms, normalizeFootballGridAnswer } from '../football-grid/football-grid.answer-resolver.js';
import type { SquadSpinAliasRow } from './squad-spin.types.js';

interface AnswerCandidate {
  playerId: string;
  text: string;
}

/** Same rule as the live Grid: short forms ("mori") sit one edit from
 *  unrelated real players ("mari"), so only longer strings absorb typos. */
const TYPO_MIN_LENGTH = 5;

/**
 * Resolves typed text against the combo's VALID answers only — their aliases
 * and their name forms (full normalised name + every token suffix, en and ka,
 * shared with the Grid via nameSuffixForms so the two modes cannot drift).
 * The alias release is missing surname forms for ~40% of players and compound
 * surnames ("Funes Mori") never got one, so names are matched directly.
 * Typo tolerance (the Grid's length-scaled limit) runs against candidates of
 * length >= 5 when the input is >= 5: every candidate names a valid answer, so
 * a near-miss credits a correct player, and the length floor keeps one-edit
 * neighbours of short names ("kane"/"mane") from clearing a spin. Turkish
 * dotless-ı and ß keyboard variants fold like the live Grid. Several valid
 * players sharing a surname resolve to the nearest one — all of them are right.
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
      ...nameSuffixForms(player.name_en).map((text) => ({ playerId: player.id, text })),
      ...(player.name_ka ? nameSuffixForms(player.name_ka).map((text) => ({ playerId: player.id, text })) : []),
    ]),
  ];

  const keyboardKey = footballGridOrthographicKey(normalizedInput);
  const exact = candidates.find((candidate) => footballGridOrthographicKey(candidate.text) === keyboardKey);
  if (exact) return { playerId: exact.playerId, normalizedInput };

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0 || normalizedInput.length < TYPO_MIN_LENGTH) return { playerId: null, normalizedInput };
  let best: { playerId: string; distance: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.text.length < TYPO_MIN_LENGTH) continue;
    const distance = boundedLevenshtein(keyboardKey, footballGridOrthographicKey(candidate.text), limit);
    if (distance <= limit && (!best || distance < best.distance)) best = { playerId: candidate.playerId, distance };
  }
  return { playerId: best?.playerId ?? null, normalizedInput };
}
