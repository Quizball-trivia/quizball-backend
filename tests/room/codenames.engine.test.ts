import { describe, expect, it } from 'vitest';
import {
  afterOutage, applyCommand, AWAY_SCOUT_MS, BOT_CLUE_MS, CLUE_IDLE_MS, GUESS_IDLE_MS, MAX_IDLE_TURNS, seatsChanged, standings, startMatch, TEAMS_MS, tick, viewOf,
  type CodenamesCommand, type CodenamesState,
} from '../../src/modules/room/games/codenames/codenames.engine.js';
import {
  bestClue, clueProblem, codenamesPackSchema, dealBoard, fold, rng, type CardKey, type CodenamesCard, type CodenamesPack, type Term,
} from '../../src/modules/room/games/codenames/codenames.rules.js';

// INVENTED cards and names (public repo).
const L = (en: string) => ({ en, es: `${en} es`, tr: `${en} tr`, ru: `${en} ru`, ka: `${en} ka` });
const term = (id: string, aliases?: string[]): Term => ({ id, label: L(id.replace(/-/g, ' ')), ...(aliases ? { aliases } : {}) });

/** A board laid out by hand: t0 cards share "alpha" (and pairs share "beta…"), t1 cards share "gamma", the Own Goal says "omega". */
function pack(starting: 0 | 1 = 0): CodenamesPack {
  const own = starting === 0 ? 't0' : 't1';
  const rival = starting === 0 ? 't1' : 't0';
  const keys: CardKey[] = [...Array(8).fill(own), ...Array(7).fill(rival), ...Array(4).fill('neutral'), 'owngoal'];
  const cards = keys.map((key, i) => ({
    id: `card-${String(i).padStart(2, '0')}`,
    face: i % 4 === 0,
    key,
    terms: key === own ? [term('alpha-town'), term(`beta-${Math.floor(i / 2)}`)]
      : key === rival ? [term('gamma-city'), term(`rival-${i}`)]
        : key === 'owngoal' ? [term('omega-park'), term('alpha-town')]
          : [term(`plain-${i}`)],
  }));
  return codenamesPackSchema.parse({ starting, seed: 42, cards });
}

const NOW = 1_000_000;
const run = (s: CodenamesState, c: CodenamesPack, seat: number, cmd: CodenamesCommand, now = NOW) => applyCommand(s, c, seat, cmd, now);
const ok = (s: CodenamesState, c: CodenamesPack, seat: number, cmd: CodenamesCommand, now = NOW) => {
  const r = run(s, c, seat, cmd, now);
  expect(r.error).toBeUndefined();
  return r.state;
};
const idx = (c: CodenamesPack, key: CardKey) => c.cards.flatMap((card, i) => (card.key === key ? [i] : []));

/** Four seats: 0 Scout + 1 guesser on Home, 2 Scout + 3 guesser on Away, kicked off by the host (seat 0). */
function fourPlayers(c = pack()): CodenamesState {
  let s = startMatch(4, c, NOW, 0);
  s = ok(s, c, 0, { type: 'join', team: 0, scout: true });
  s = ok(s, c, 1, { type: 'join', team: 0, scout: false });
  s = ok(s, c, 2, { type: 'join', team: 1, scout: true });
  s = ok(s, c, 3, { type: 'join', team: 1, scout: false });
  return ok(s, c, 0, { type: 'kickoff' });
}

describe('codenames rules', () => {
  it('deals 8/7/4/1 with the starting team holding 8, deterministically per seed', () => {
    const cards: CodenamesCard[] = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, face: false, terms: [term(`t-${i}`)] }));
    const a = dealBoard(cards, rng(7), 9);
    expect(dealBoard(cards, rng(7), 9)).toEqual(a);
    expect(a.seed).toBe(9);
    expect(codenamesPackSchema.safeParse(a).success).toBe(true);
    const own = a.cards.filter((x) => x.key === (a.starting === 0 ? 't0' : 't1')).length;
    expect(own).toBe(8);
    const starts = new Set(Array.from({ length: 40 }, (_, seed) => dealBoard(cards, rng(seed), seed).starting));
    expect(starts).toEqual(new Set([0, 1]));
  });

  it('folds case, accents, Turkish dotted letters and spacing', () => {
    expect(fold('Fenerbahçe')).toBe(fold('FENERBAHCE'));
    expect(fold('İstanbul')).toBe(fold('istanbul'));
    expect(fold('Hand  of-God')).toBe(fold('handofgod'));
  });

  it('refuses empty, long, wordy, repeated and abusive clues', () => {
    const used = new Set([fold('Alpha Town')]);
    expect(clueProblem('   ', used)).toBe('empty');
    expect(clueProblem('x'.repeat(31), used)).toBe('long');
    expect(clueProblem('one two three four five', used)).toBe('words');
    expect(clueProblem('alpha  TOWN', used)).toBe('used');
    expect(clueProblem('retard', used)).toBe('blocked');
    expect(clueProblem('Beta Bay', used)).toBeNull();
  });

  it('bot clue covers most own cards and never points at the hidden Own Goal', () => {
    const c = pack();
    const none = c.cards.map(() => null);
    const clue = bestClue(c, none, 0, new Set());
    // "alpha-town" covers 8 but also the Own Goal: refused; a pair name is next best.
    expect(clue?.term.id).toMatch(/^beta-/);
    expect(clue?.count).toBe(2);
    // Once the Own Goal is revealed, alpha is fine.
    const revealed = c.cards.map((card) => (card.key === 'owngoal' ? 'owngoal' as const : null));
    expect(bestClue(c, revealed, 0, new Set())).toMatchObject({ term: { id: 'alpha-town' }, count: 8 });
  });

  it('bot clue skips any name said before, in any language or alias', () => {
    const c = pack();
    const used = new Set([fold('beta 0 tr'), fold('beta 1 ka')]);
    expect(bestClue(c, c.cards.map(() => null), 0, used)?.term.id).toMatch(/^beta-[23]$/);
    // Every safe name said: nothing left that avoids the Own Goal.
    used.add(fold('beta 2')).add(fold('beta 3 ru'));
    expect(bestClue(c, c.cards.map(() => null), 0, used)).toBeNull();
  });
});

describe('codenames teams', () => {
  it('starts on the teams screen with nobody seated and kicks off by itself after the wait', () => {
    const c = pack();
    const s = startMatch(3, c, NOW, 1);
    expect(s.phase).toBe('teams');
    expect(s.host).toBe(1);
    expect(tick(s, c, NOW + TEAMS_MS - 1)).toBe(s);
    const started = tick(s, c, NOW + TEAMS_MS);
    expect(started.phase).toBe('clue');
    // Three unseated players: 2 on Home, 1 on Away; nobody chose Scout, so both teams get the bot.
    expect(started.team).toEqual([0, 1, 0]);
    expect(started.botScout).toEqual([true, true]);
  });

  it('only the host shuffles and kicks off; a new Scout demotes the old one', () => {
    const c = pack();
    let s = startMatch(4, c, NOW, 0);
    expect(run(s, c, 1, { type: 'kickoff' }).error).toBe('not_host');
    expect(run(s, c, 1, { type: 'shuffle' }).error).toBe('not_host');
    s = ok(s, c, 1, { type: 'join', team: 0, scout: true });
    s = ok(s, c, 2, { type: 'join', team: 0, scout: true });
    expect(s.scout.slice(0, 3)).toEqual([false, false, true]);
    expect(viewOf(s, c, 1, 'en').shuffles).toBe(0);
    s = ok(s, c, 0, { type: 'shuffle', seen: 0 });
    expect(viewOf(s, c, 1, 'en').shuffles).toBe(1);
    expect(s.team.filter((t) => t === 0)).toHaveLength(2);
    expect(s.team.filter((t) => t === 1)).toHaveLength(2);
    expect(s.scout.filter(Boolean)).toHaveLength(2);
  });

  it('a lone player is a guesser with the bot Scout (two players play one against one)', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'join', team: 0, scout: true });
    s = ok(s, c, 0, { type: 'kickoff' });
    expect(s.team).toEqual([0, 1]);
    expect(s.scout).toEqual([false, false]);
    expect(s.botScout).toEqual([true, true]);
    expect(s.deadline).toBe(NOW + BOT_CLUE_MS);
  });

  it('a seat that leaves the teams screen loses its side; fewer than two cancels', () => {
    const c = pack();
    let s = startMatch(3, c, NOW, 0);
    s = ok(s, c, 2, { type: 'join', team: 1, scout: true });
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], NOW);
    expect(s.team[2]).toBeNull();
    expect(s.scout[2]).toBe(false);
    s = seatsChanged(s, [{ seat: 0, change: 'leave' }], NOW);
    expect(s.phase).toBe('cancelled');
  });

  it('the host role passes on when the host leaves', () => {
    const c = pack();
    const s = seatsChanged(startMatch(3, c, NOW, 0), [{ seat: 0, change: 'leave' }], NOW);
    expect(s.host).toBe(1);
    expect(run(s, c, 1, { type: 'kickoff' }).error).toBeUndefined();
  });
});

describe('codenames turns', () => {
  it('Scout clue, then guessers flip their cards up to count + 1', () => {
    const c = pack();
    let s = fourPlayers(c);
    expect(s.phase).toBe('clue');
    expect(s.deadline).toBe(NOW + CLUE_IDLE_MS);
    expect(run(s, c, 1, { type: 'clue', turn: 0, word: 'x', count: 1 }).error).toBe('not_scout');
    expect(run(s, c, 2, { type: 'clue', turn: 0, word: 'x', count: 1 }).error).toBe('not_your_turn');
    s = ok(s, c, 0, { type: 'clue', turn: 0, word: '  Beta   Bay ', count: 1 });
    expect(s.phase).toBe('guess');
    expect(s.clue?.word).toBe('Beta Bay');
    expect(s.guessesLeft).toBe(2);
    const mine = idx(c, 't0');
    expect(run(s, c, 0, { type: 'flip', turn: 0, card: mine[0] }).error).toBe('not_guesser');
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: mine[0] });
    expect(s.phase).toBe('guess');
    expect(run(s, c, 1, { type: 'flip', turn: 0, card: mine[0] }).error).toBe('revealed');
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: mine[1] });
    // count + 1 used up: Away's turn.
    expect(s.phase).toBe('clue');
    expect(s.turn).toBe(1);
    expect(s.turnNo).toBe(1);
    expect(run(s, c, 1, { type: 'flip', turn: 0, card: mine[2] }).error).toBe('stale');
  });

  it('a neutral or rival card ends the turn; the same clue cannot be said again', () => {
    const c = pack();
    let s = fourPlayers(c);
    s = ok(s, c, 0, { type: 'clue', turn: 0, word: 'Beta Bay', count: 3 });
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: idx(c, 'neutral')[0] });
    expect(s.turn).toBe(1);
    expect(run(s, c, 2, { type: 'clue', turn: 1, word: 'beta bay', count: 1 }).error).toBe('used');
    s = ok(s, c, 2, { type: 'clue', turn: 1, word: 'Gamma', count: 2 });
    s = ok(s, c, 3, { type: 'flip', turn: 1, card: idx(c, 't0')[0] });
    expect(s.turn).toBe(0);
    expect(s.revealed[idx(c, 't0')[0]]).toBe('t0');
  });

  it('end turn needs one flip first', () => {
    const c = pack();
    let s = ok(fourPlayers(c), c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    expect(run(s, c, 1, { type: 'endTurn', turn: 0 }).error).toBe('no_flip');
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: idx(c, 't0')[0] });
    s = ok(s, c, 1, { type: 'endTurn', turn: 0 });
    expect(s.turn).toBe(1);
  });

  it('the Own Goal loses at once', () => {
    const c = pack();
    let s = ok(fourPlayers(c), c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: idx(c, 'owngoal')[0] });
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
    expect(s.endedBy).toBe('owngoal');
    expect(standings(s).map((r) => r.place)).toEqual([2, 2, 1, 1]);
  });

  it('a team wins when its last card is revealed, even by the rivals', () => {
    const c = pack();
    let s = fourPlayers(c);
    const theirs = idx(c, 't1');
    // Reveal all but one Away card on Home's turns (each ends Home's turn), with Away passing in between.
    for (const [n, card] of theirs.slice(0, 6).entries()) {
      s = ok(s, c, 0, { type: 'clue', turn: s.turnNo, word: `home ${n}`, count: 1 });
      s = ok(s, c, 1, { type: 'flip', turn: s.turnNo, card });
      s = ok(s, c, 2, { type: 'clue', turn: s.turnNo, word: `away ${n}`, count: 1 });
      s = ok(s, c, 3, { type: 'flip', turn: s.turnNo, card: idx(c, 'neutral').find((i) => s.revealed[i] === null) ?? idx(c, 't0').find((i) => s.revealed[i] === null)! });
      if (s.phase === 'over') break;
    }
    expect(s.phase).not.toBe('over');
    s = ok(s, c, 0, { type: 'clue', turn: s.turnNo, word: 'last', count: 1 });
    s = ok(s, c, 1, { type: 'flip', turn: s.turnNo, card: theirs[6] });
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
    expect(s.endedBy).toBe('cleared');
  });

  it('the bot gives the clue for a bot team after a beat, and for an idle Scout after the long wait', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'kickoff' });
    expect(tick(s, c, NOW + BOT_CLUE_MS - 1)).toBe(s);
    s = tick(s, c, NOW + BOT_CLUE_MS);
    expect(s.phase).toBe('guess');
    expect(s.clue).toMatchObject({ bot: true, word: null });
    expect(s.clue?.term?.id).toMatch(/^beta-/);
    const human = fourPlayers(c);
    const idle = tick(human, c, NOW + CLUE_IDLE_MS);
    expect(idle.phase).toBe('guess');
    expect(idle.clue?.bot).toBe(true);
  });

  it('a Scout back before the bot spoke gets the whole wait again', () => {
    const c = pack();
    let s = fourPlayers(c);
    s = seatsChanged(s, [{ seat: 0, change: 'away' }], NOW + 1_000);
    expect(s.deadline).toBe(NOW + 1_000 + AWAY_SCOUT_MS);
    s = seatsChanged(s, [{ seat: 0, change: 'back' }], NOW + 2_000);
    expect(s.deadline).toBe(NOW + 2_000 + CLUE_IDLE_MS);
    expect(tick(s, c, NOW + 1_000 + AWAY_SCOUT_MS).phase).toBe('clue');
  });

  it('an idle guess turn ends after the wait; an away Scout gets the short wait', () => {
    const c = pack();
    let s = ok(fourPlayers(c), c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    s = tick(s, c, NOW + GUESS_IDLE_MS);
    expect(s.phase).toBe('clue');
    expect(s.turn).toBe(1);
    const away = seatsChanged(s, [{ seat: 2, change: 'away' }], NOW + GUESS_IDLE_MS + 10);
    expect(away.deadline).toBe(NOW + GUESS_IDLE_MS + 10 + AWAY_SCOUT_MS);
  });

  it('pointing is per seat, for guessers on turn, and cleared when the card flips', () => {
    const c = pack();
    let s = ok(fourPlayers(c), c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    const card = idx(c, 't0')[3];
    expect(run(s, c, 3, { type: 'point', turn: 0, card }).error).toBe('not_your_turn');
    s = ok(s, c, 1, { type: 'point', turn: 0, card });
    expect(viewOf(s, c, 0, 'en').cards[card].picks).toEqual([1]);
    // The rivals never see where Home points.
    expect(viewOf(s, c, 3, 'en').cards[card].picks).toEqual([]);
    s = ok(s, c, 1, { type: 'flip', turn: 0, card });
    expect(s.pointing[1]).toBeNull();
  });
});

describe('codenames seat changes', () => {
  it('a Scout who leaves hands over to a teammate, or to the bot when one is left', () => {
    const c = pack();
    let s = startMatch(5, c, NOW, 0);
    s = ok(s, c, 0, { type: 'join', team: 0, scout: true });
    s = ok(s, c, 1, { type: 'join', team: 0, scout: false });
    s = ok(s, c, 2, { type: 'join', team: 0, scout: false });
    s = ok(s, c, 3, { type: 'join', team: 1, scout: true });
    s = ok(s, c, 4, { type: 'join', team: 1, scout: false });
    s = ok(s, c, 0, { type: 'kickoff' });
    s = seatsChanged(s, [{ seat: 0, change: 'leave' }], NOW + 5);
    expect(s.scout[1]).toBe(true);
    expect(s.botScout[0]).toBe(false);
    expect(s.deadline).toBe(NOW + 5 + CLUE_IDLE_MS);
    s = seatsChanged(s, [{ seat: 3, change: 'leave' }], NOW + 6);
    expect(s.botScout[1]).toBe(true);
    expect(s.scout[4]).toBe(false);
    s = seatsChanged(s, [{ seat: 4, change: 'leave' }], NOW + 7);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(0);
    expect(s.endedBy).toBe('left');
  });

  it('a Scout who has seen the key never guesses: their last guesser leaving puts the team out', () => {
    const c = pack();
    const s = seatsChanged(fourPlayers(c), [{ seat: 1, change: 'leave' }], NOW + 1);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
    expect(s.endedBy).toBe('left');
  });

  it('a promoted Scout sees the key and stays out of guessing even after the team shrinks', () => {
    const c = pack();
    let s = startMatch(5, c, NOW, 0);
    for (const [seat, t, sc] of [[0, 0, true], [1, 0, false], [2, 0, false], [3, 1, true], [4, 1, false]] as const) s = ok(s, c, seat, { type: 'join', team: t, scout: sc });
    s = ok(s, c, 0, { type: 'kickoff' });
    s = seatsChanged(s, [{ seat: 0, change: 'leave' }], NOW + 1);
    expect(s.scout[1] && s.sawKey[1]).toBe(true);
    expect(viewOf(s, c, 1, 'en').cards.every((x) => x.key !== null)).toBe(true);
    s = seatsChanged(s, [{ seat: 2, change: 'leave' }], NOW + 2);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
  });

  it('a seat that has seen the key is refused as a guesser, whatever its role now', () => {
    const c = pack();
    let s = ok(fourPlayers(c), c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    s = { ...s, scout: s.scout.map((x, seat) => (seat === 0 ? false : x)), botScout: [true, s.botScout[1]] };
    expect(run(s, c, 0, { type: 'flip', turn: 0, card: idx(c, 't0')[0] }).error).toBe('not_guesser');
    expect(run(s, c, 0, { type: 'point', turn: 0, card: idx(c, 't0')[0] }).error).toBe('not_guesser');
  });

  it('both teams emptied by the same batch ends the game without a winner', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'kickoff' });
    s = seatsChanged(s, [{ seat: 0, change: 'leave' }, { seat: 1, change: 'leave' }], NOW + 1);
    expect(s.phase).toBe('cancelled');
    expect(s.winner).toBeNull();
  });

  it('a team out while nobody of the other team is here (every tab closed) ends without a winner', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'kickoff' });
    s = seatsChanged(s, [{ seat: 1, change: 'away' }], NOW + 1);
    s = seatsChanged(s, [{ seat: 0, change: 'leave' }], NOW + 2);
    expect(s.phase).toBe('cancelled');
    const here = seatsChanged(ok(startMatch(2, c, NOW, 0), c, 0, { type: 'kickoff' }), [{ seat: 0, change: 'leave' }], NOW + 2);
    expect(here).toMatchObject({ phase: 'over', winner: 1, endedBy: 'left' });
  });

  it('the bot passes when no safe, unsaid name is left', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    s = ok(s, c, 0, { type: 'kickoff' });
    s = { ...s, used: ['beta0', 'beta1', 'beta2', 'beta3'].flatMap((b) => [b, `${b}es`, `${b}tr`, `${b}ru`, `${b}ka`]) };
    s = tick(s, c, NOW + BOT_CLUE_MS);
    expect(s.history.at(-1)).toMatchObject({ team: 0, clue: null, flips: [] });
    expect(s.turn).toBe(1);
    expect(s.phase).toBe('clue');
  });

  it('turns in a row where nobody does anything end the game without a winner', () => {
    const c = pack();
    let s = fourPlayers(c);
    for (let i = 0; i < MAX_IDLE_TURNS; i += 1) {
      expect(s.phase).not.toBe('cancelled');
      s = tick(s, c, s.deadline);
      if (s.phase === 'guess') s = tick(s, c, s.deadline);
    }
    expect(s.phase).toBe('cancelled');
    expect(viewOf(s, c, 1, 'en').cancelReason).toBe('idle');
    expect(viewOf(s, c, 1, 'en').cards.every((x) => x.key !== null)).toBe(true);
  });

  it('afterOutage restarts the open wait', () => {
    const c = pack();
    const s = fourPlayers(c);
    expect(afterOutage(s, c, NOW + 99).deadline).toBe(NOW + 99 + CLUE_IDLE_MS);
  });
});

describe('codenames view', () => {
  it('keys go to the human Scouts only during play, to everyone at the end', () => {
    const c = pack();
    let s = fourPlayers(c);
    expect(viewOf(s, c, 0, 'en').cards.every((x) => x.key !== null)).toBe(true);
    expect(viewOf(s, c, 2, 'en').cards.every((x) => x.key !== null)).toBe(true);
    expect(viewOf(s, c, 1, 'en').cards.every((x) => x.key === null)).toBe(true);
    s = ok(s, c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 2 });
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: idx(c, 'owngoal')[0] });
    expect(viewOf(s, c, 1, 'en').cards.every((x) => x.key !== null)).toBe(true);
  });

  it('no keys on the teams screen, and the bot clue is shown in each reader\'s language without its cards', () => {
    const c = pack();
    let s = startMatch(2, c, NOW, 0);
    expect(viewOf(s, c, 0, 'en').cards.every((x) => x.key === null)).toBe(true);
    s = tick(ok(s, c, 0, { type: 'kickoff' }), c, NOW + BOT_CLUE_MS);
    const ru = viewOf(s, c, 1, 'ru');
    expect(ru.clue?.word).toMatch(/ ru$/);
    expect(JSON.stringify(ru)).not.toContain('terms');
    expect(JSON.stringify(ru)).not.toContain('beta-');
  });
});
