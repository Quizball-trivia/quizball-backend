import { boundedLevenshtein, footballGridOrthographicKey, footballGridTypoDistanceLimit, nameSuffixForms, normalizeFootballGridAnswer } from '../football-grid/football-grid.answer-resolver.js';
import { foldLatin } from '../../lib/latin-fold.js';
import { currentFootballerNames, namesSomeoneElse, type FootballerNames } from '../footballers/footballers.names.js';
import type { SquadSpinAliasRow } from './squad-spin.types.js';

interface AnswerCandidate {
  playerId: string;
  text: string;
  /** A form cut from a name (every token suffix but the full name), not a name the content lists. */
  derived: boolean;
}

/** Same rule as the live Grid: short forms ("mori") sit one edit from
 *  unrelated real players ("mari"), so only longer strings absorb typos. */
const TYPO_MIN_LENGTH = 5;

const keyOf = (normalized: string) => foldLatin(footballGridOrthographicKey(normalized));

const playerForms = (playerId: string, name: string | null | undefined): AnswerCandidate[] =>
  (name ? nameSuffixForms(name) : []).map((text, i) => ({ playerId, text, derived: i > 0 }));

/**
 * Resolves typed text against the combo's VALID answers only — their aliases
 * and their name forms (full normalised name + every token suffix, en and ka,
 * shared with the Grid via nameSuffixForms so the two modes cannot drift).
 * The alias release is missing surname forms for ~40% of players and compound
 * surnames ("Funes Mori") never got one, so names are matched directly; a text
 * that is, as typed, a valid answer's name in the footballer release counts too.
 * Typo tolerance (the Grid's length-scaled limit) runs against candidates of
 * length >= 5 when the input is >= 5: every candidate names a valid answer, so
 * a near-miss credits a correct player, and the length floor keeps one-edit
 * neighbours of short names ("kane"/"mane") from clearing a spin. Accents Unicode
 * cannot strip (ı, ß, ø, ł …) fold to plain letters. Several valid players
 * sharing a surname resolve to the nearest one — all of them are right. Neither a
 * typo nor a cut-down name of several words credits a text that is, as typed,
 * the name of a footballer who is not a valid answer.
 */
export function resolveSquadSpinAnswer(
  submittedText: string,
  aliases: SquadSpinAliasRow[],
  players: Array<{ id: string; name_en: string; name_ka?: string | null; name_ru?: string | null }>,
  names: FootballerNames | null = currentFootballerNames(),
): { playerId: string | null; normalizedInput: string } {
  const normalizedInput = normalizeFootballGridAnswer(submittedText);
  if (!normalizedInput) return { playerId: null, normalizedInput };

  const candidates: AnswerCandidate[] = [
    ...aliases.map((alias) => ({ playerId: alias.player_id, text: alias.normalized_alias, derived: false })),
    ...players.flatMap((player) => [
      ...playerForms(player.id, player.name_en),
      ...playerForms(player.id, player.name_ka),
      ...playerForms(player.id, player.name_ru),
    ]),
  ];
  const valid = new Set(players.map((player) => player.id));
  const someoneElse = () => namesSomeoneElse(names, submittedText, (pid) => valid.has(pid));

  const keyboardKey = keyOf(normalizedInput);
  const exact = candidates.filter((candidate) => keyOf(candidate.text) === keyboardKey);
  const listed = exact.find((candidate) => !candidate.derived);
  if (listed) return { playerId: listed.playerId, normalizedInput };
  if (exact.length > 0 && !(normalizedInput.includes(' ') && someoneElse())) return { playerId: exact[0].playerId, normalizedInput };

  // A name the release gives only valid answers (one it also gives somebody else may mean them).
  const holders = names?.holders(submittedText) ?? [];
  if (holders.length > 0 && holders.every((pid) => valid.has(pid))) return { playerId: holders[0], normalizedInput };

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  // Any holder at all means the text is somebody's own name: never a typo of a valid answer.
  if (limit === 0 || normalizedInput.length < TYPO_MIN_LENGTH || holders.length > 0) return { playerId: null, normalizedInput };
  let best: { playerId: string; distance: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.text.length < TYPO_MIN_LENGTH) continue;
    const distance = boundedLevenshtein(keyboardKey, keyOf(candidate.text), limit);
    if (distance <= limit && (!best || distance < best.distance)) best = { playerId: candidate.playerId, distance };
  }
  return { playerId: best?.playerId ?? null, normalizedInput };
}
