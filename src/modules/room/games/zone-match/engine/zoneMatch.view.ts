// COPY of the web's src/features/zone-match/zoneMatch.view.ts (one rules implementation; keep byte-identical apart from import paths).
/**
 * What one seat may see of a match. The engine's state is written from "player" and "opponent"; the server runs the
 * real match with seat 0 as "player" and seat 1 as "opponent", and each seat gets the state turned round so that it is
 * always "player" (the screens are drawn that way), with everything it must not know yet taken out:
 *  - the right answer and the other side's answer until the question's reveal;
 *  - the number question's value and the other side's guess until its result;
 *  - the other side's blind card until the cards are revealed, and a bluff's truth while it is still a bluff;
 *  - the other side's loadout beyond what they have shown, when loadouts are hidden;
 *  - the match log (written from one side's point of view).
 */

import { BLUFF_CARDS, type CardId } from './zoneMatch.cards.js';
import type { MatchState } from './zoneMatch.machine.js';
import type { ZoneSide as DuelSide } from './zoneMatch.rules.js';

/** Fields whose value is a side. */
const SIDE_FIELDS = new Set(['side', 'attacker', 'scorer', 'kickoff', 'winner', 'opener', 'shooter']);
const swap = (side: DuelSide): DuelSide => (side === 'player' ? 'opponent' : 'player');

/** The state with the sides turned round: every per-side record swapped, every side-valued field flipped. */
export function flipState<T>(value: T): T {
  return flip(value, null) as T;
}

function flip(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => flip(item, null));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    // A per-side record has only side keys — one may be missing (JSON drops an undefined pick), it still swaps.
    const keys = Object.keys(record);
    const perSide = keys.length > 0 && keys.every((k) => k === 'player' || k === 'opponent');
    for (const [k, v] of Object.entries(record)) {
      const target = perSide && (k === 'player' || k === 'opponent') ? swap(k) : k;
      out[target] = flip(v, k);
    }
    return out;
  }
  if (key && SIDE_FIELDS.has(key) && (value === 'player' || value === 'opponent')) return swap(value);
  return value;
}

/** A hidden right answer: no option index. */
export const HIDDEN_ANSWER = -1;

export interface SeatView {
  state: MatchState;
  /** The other side has answered the open question / locked a guess (their answer itself stays hidden). */
  opponentAnswered: boolean;
  opponentGuessed: boolean;
}

/** `seat`'s view of the match: turned round so the seat is "player", with what it can't know yet removed. */
export function seatView(full: MatchState, seat: DuelSide, hiddenLoadouts = false): SeatView {
  const s: MatchState = seat === 'player' ? structuredClone(full) : flipState(full);
  const opponentAnswered = !!s.mcq && s.mcq.answers.opponent !== null;
  const opponentGuessed = !!s.numeric && s.numeric.guesses.opponent.value !== null;

  // The question: their answer only from the reveal on. The right answer stays hidden while this seat can still
  // answer; once its answer is locked (no retry left) the seat may know it — instant right/wrong feedback, nothing
  // the opponent can see, and nothing this seat can still act on.
  if (s.mcq && s.battleStep === 'mcq') {
    const locked = s.mcq.answers.player !== null;
    s.mcq = {
      ...s.mcq,
      question: { ...s.mcq.question, correctIndex: locked ? s.mcq.question.correctIndex : HIDDEN_ANSWER },
      answers: { ...s.mcq.answers, opponent: null },
      answeredAt: { ...s.mcq.answeredAt, opponent: null },
      firstMiss: { ...s.mcq.firstMiss, opponent: null },
      // Their 50/50 would tell you two wrong options.
      hidden: { ...s.mcq.hidden, opponent: [] },
      hiddenAt: { ...s.mcq.hiddenAt, opponent: null },
    };
  }
  // The number question: its value and their guess only with the result.
  if (s.numeric && !s.numeric.result) {
    s.numeric = {
      ...s.numeric,
      question: { ...s.numeric.question, value: 0 },
      guesses: { ...s.numeric.guesses, opponent: { value: null, lockedAtMs: s.numeric.guesses.opponent.lockedAtMs } },
    };
  }
  // Their blind card: unknown while they choose (only whether they have chosen), a bluff shown as its fake.
  if (s.battleStep === 'cards') {
    s.choice = { ...s.choice, opponent: s.choice.opponent === undefined ? undefined : null };
    s.played = { ...s.played, opponent: [] };
  }
  const fake = s.dummyShownAs.opponent;
  const bluffing = s.battleStep === 'reveal' && !!s.choice.opponent && BLUFF_CARDS.includes(s.choice.opponent) && !s.cancelled.opponent;
  if (bluffing && fake) {
    const asFake = (id: CardId) => (BLUFF_CARDS.includes(id) ? fake : id);
    s.choice = { ...s.choice, opponent: fake };
    s.played = { ...s.played, opponent: s.played.opponent.map(asFake) };
    s.used = { ...s.used, opponent: s.used.opponent.map(asFake) };
  }
  // While cards are being picked or revealed, whether they have a fake on show would give a bluff away.
  if (s.battleStep === 'cards' || s.battleStep === 'reveal') s.dummyShownAs = { ...s.dummyShownAs, opponent: null };
  if (hiddenLoadouts) s.deck = { ...s.deck, opponent: s.deck.opponent.filter((id) => s.used.opponent.includes(id)) };
  s.feed = [];
  return { state: s, opponentAnswered, opponentGuessed };
}
