import { describe, expect, it } from 'vitest';
import {
  applyCommand, AWAY_SCOUT_MS, BOT_CLUE_MS, CLUE_IDLE_MS, GUESS_IDLE_MS, seatsChanged, startMatch, tick, viewOf,
  type CodenamesCommand, type CodenamesState,
} from '../../src/modules/room/games/codenames/codenames.engine.js';
import { CODENAMES_TIMER_VERSION, codenamesRoomEngine } from '../../src/modules/room/games/codenames/codenames.room.js';
import { codenamesPackSchema, type CardKey, type CodenamesPack, type Term } from '../../src/modules/room/games/codenames/codenames.rules.js';
import { clientCanPlay, roomEngineFor } from '../../src/modules/room/room.registry.js';
import { declaresRoomOptions, roomOptionsToken, roomOptionsVersion } from '../../src/realtime/client-games.js';

// INVENTED cards and names (public repo).
const L = (en: string) => ({ en, es: `${en} es`, tr: `${en} tr`, ru: `${en} ru`, ka: `${en} ka` });
const term = (id: string): Term => ({ id, label: L(id.replace(/-/g, ' ')) });

/** Home starts; Home cards share "alpha-town", Away cards "gamma-city"; the Own Goal says "omega-park". */
function pack(timer?: 60 | 90 | 120): CodenamesPack {
  const keys: CardKey[] = [...Array(8).fill('t0'), ...Array(7).fill('t1'), ...Array(4).fill('neutral'), 'owngoal'];
  const cards = keys.map((key, i) => ({
    id: `card-${String(i).padStart(2, '0')}`,
    face: false,
    key,
    terms: key === 't0' ? [term('alpha-town')] : key === 't1' ? [term('gamma-city')] : key === 'owngoal' ? [term('omega-park')] : [term(`plain-${i}`)],
  }));
  return codenamesPackSchema.parse({ starting: 0, seed: 42, cards, ...(timer ? { timer } : {}) });
}

const NOW = 1_000_000;
const ok = (s: CodenamesState, c: CodenamesPack, seat: number, cmd: CodenamesCommand, now = NOW) => {
  const r = applyCommand(s, c, seat, cmd, now);
  expect(r.error).toBeUndefined();
  return r.state;
};
const idx = (c: CodenamesPack, key: CardKey) => c.cards.flatMap((card, i) => (card.key === key ? [i] : []));

/** Seat 0 Scout + 1 guesser on Home, 2 Scout + 3 guesser on Away. */
function fourPlayers(c: CodenamesPack): CodenamesState {
  let s = startMatch(4, c, NOW, 0);
  s = ok(s, c, 0, { type: 'join', team: 0, scout: true });
  s = ok(s, c, 1, { type: 'join', team: 0, scout: false });
  s = ok(s, c, 2, { type: 'join', team: 1, scout: true });
  s = ok(s, c, 3, { type: 'join', team: 1, scout: false });
  return ok(s, c, 0, { type: 'kickoff' });
}

describe('codenames room options', () => {
  const parse = (raw: unknown) => codenamesRoomEngine.parseOptions(raw);

  it('reads a board, a timer, both or nothing', () => {
    expect(parse(null)).toBeNull();
    expect(parse({})).toBeNull();
    expect(parse({ timer: 90 })).toEqual({ timer: 90 });
    expect(parse({ board: 'words', lang: 'es' })).toEqual({ board: 'words', lang: 'es' });
    expect(parse({ board: 'words', lang: 'es', timer: 60 })).toEqual({ board: 'words', lang: 'es', timer: 60 });
  });

  it('refuses a timer it does not offer, a word board without its language and unknown keys', () => {
    expect(parse({ timer: 30 })).toBeUndefined();
    expect(parse({ timer: '60' })).toBeUndefined();
    expect(parse({ board: 'words' })).toBeUndefined();
    expect(parse({ lang: 'es' })).toBeUndefined();
    expect(parse({ timer: 60, speed: 'fast' })).toBeUndefined();
  });

  it('stores a timed match as version 3 (either board), run by this build and drawn only by a tab listing codenames@3', () => {
    expect(codenamesRoomEngine.versionFor?.({ timer: 60 })).toBe(CODENAMES_TIMER_VERSION);
    expect(codenamesRoomEngine.versionFor?.({ board: 'words', lang: 'en', timer: 120 })).toBe(CODENAMES_TIMER_VERSION);
    expect(roomEngineFor('codenames', CODENAMES_TIMER_VERSION)).toBe(codenamesRoomEngine);
    expect(clientCanPlay('codenames', ['codenames', 'codenames@2'], 3)).toBe(false);
    expect(clientCanPlay('codenames', ['codenames', 'codenames@2', 'codenames@3'], 3)).toBe(true);
  });

  it('asks a lobby tab for codenames@3 once the host sets a timer', () => {
    const timed = { room_game: 'codenames', room_options: { timer: 60 } };
    const words = { room_game: 'codenames', room_options: { board: 'words', lang: 'en' } };
    expect(roomOptionsToken(timed)).toBe('codenames@3');
    expect(roomOptionsVersion(timed)).toBe(3);
    expect(roomOptionsVersion(words)).toBe(2);
    expect(roomOptionsVersion({ room_game: 'codenames', room_options: null })).toBeNull();
    expect(declaresRoomOptions({ games: ['codenames', 'codenames@2'] }, timed)).toBe(false);
    expect(declaresRoomOptions({ games: ['codenames', 'codenames@2', 'codenames@3'] }, timed)).toBe(true);
  });

  it('deals the timer into the board, never into an untimed one', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `card-${i}`, payload: { id: `card-${i}`, face: i < 6, terms: [term(`t-${i}`)] } }));
    const pick = async (wanted: Record<string, number>, tag?: string) => (tag === 'face' ? items.slice(0, wanted.easy) : items.slice(6, 6 + wanted.easy)) as never;
    const timed = await codenamesRoomEngine.deal(pick, { timer: 90 }, 4);
    expect((timed!.content as { timer?: number }).timer).toBe(90);
    expect(codenamesPackSchema.safeParse(timed!.content).success).toBe(true);
    const plain = await codenamesRoomEngine.deal(pick, null, 4);
    expect('timer' in (plain!.content as object)).toBe(false);
  });
});

describe('codenames turn timer', () => {
  it('gives the Scout the timer for the clue and the team the timer for its guesses', () => {
    const c = pack(60);
    const s = fourPlayers(c);
    expect(s.deadline).toBe(NOW + 60_000);
    const guess = ok(s, c, 0, { type: 'clue', turn: 0, word: 'Alpha Town', count: 2 }, NOW + 5_000);
    expect(guess.deadline).toBe(NOW + 65_000);
    // A right flip keeps the same clock (it is for the whole guessing, not per card).
    const after = ok(guess, c, 1, { type: 'flip', turn: 0, card: idx(c, 't0')[0] }, NOW + 20_000);
    expect(after.phase).toBe('guess');
    expect(after.deadline).toBe(NOW + 65_000);
    // Out of time: the turn goes to the other team.
    const out = tick(after, c, NOW + 65_000);
    expect(out.turn).toBe(1);
    expect(out.phase).toBe('clue');
    expect(out.deadline).toBe(NOW + 65_000 + 60_000);
  });

  it('passes the turn when the Scout who is here runs out of time, without a bot clue', () => {
    const c = pack(90);
    const s = fourPlayers(c);
    const out = tick(s, c, NOW + 90_000);
    expect(out.turn).toBe(1);
    expect(out.history).toEqual([{ team: 0, clue: null, flips: [], timeout: true }]);
    expect(viewOf(out, c, 1, 'en').history[0]).toMatchObject({ clue: null, timeout: true });
  });

  it('still lets the bot speak for a Scout who is away', () => {
    const c = pack(60);
    let s = fourPlayers(c);
    s = seatsChanged(s, [{ seat: 0, change: 'away' }], NOW + 1_000);
    expect(s.deadline).toBe(NOW + 1_000 + AWAY_SCOUT_MS);
    const spoke = tick(s, c, s.deadline);
    expect(spoke.phase).toBe('guess');
    expect(spoke.history.at(-1)?.clue?.bot).toBe(true);
  });

  it('never gives a returning Scout more than what was left of the clue timer', () => {
    const c = pack(60);
    let s = fourPlayers(c);
    s = seatsChanged(s, [{ seat: 0, change: 'away' }], NOW + 50_000);
    expect(s.deadline).toBe(NOW + 60_000);
    s = seatsChanged(s, [{ seat: 0, change: 'back' }], NOW + 50_100);
    expect(s.deadline).toBe(NOW + 60_000);
    // Away early and back: the Scout's own time again, not a fresh minute.
    let t = fourPlayers(c);
    t = seatsChanged(t, [{ seat: 0, change: 'away' }], NOW + 5_000);
    expect(t.deadline).toBe(NOW + 5_000 + AWAY_SCOUT_MS);
    t = seatsChanged(t, [{ seat: 0, change: 'back' }], NOW + 10_000);
    expect(t.deadline).toBe(NOW + 60_000);
  });

  it('keeps the long idle waits without a timer (a match from before timers has no timer field)', () => {
    const c = pack();
    const s = fourPlayers(c);
    expect(s.deadline).toBe(NOW + CLUE_IDLE_MS);
    const legacy: CodenamesState = { ...s };
    delete legacy.timer;
    const guess = ok(legacy, c, 0, { type: 'clue', turn: 0, word: 'Alpha Town', count: 2 });
    expect(guess.deadline).toBe(NOW + GUESS_IDLE_MS);
    expect(viewOf(guess, c, 1, 'en')).toMatchObject({ timer: null, clockEndsAt: null });
    // The Scout who ran out with no timer gets the bot's clue, as before.
    expect(tick(s, c, NOW + CLUE_IDLE_MS).history.at(-1)?.clue?.bot).toBe(true);
  });

  it('shows the clock only while the timer runs: a human Scout thinking, then the guessing', () => {
    const c = pack(60);
    const s = fourPlayers(c);
    expect(viewOf(s, c, 1, 'en')).toMatchObject({ timer: 60, clockEndsAt: NOW + 60_000 });
    // A bot Scout (Away has only one player here) speaks at once: no clock for its clue.
    let duo = startMatch(2, c, NOW, 0);
    duo = ok(duo, c, 0, { type: 'join', team: 0, scout: false });
    duo = ok(duo, c, 1, { type: 'join', team: 1, scout: false });
    duo = ok(duo, c, 0, { type: 'kickoff' });
    expect(duo.deadline).toBe(NOW + BOT_CLUE_MS);
    expect(viewOf(duo, c, 0, 'en').clockEndsAt).toBeNull();
  });
});

describe('codenames clue marks', () => {
  it('keeps what a Scout marked secret until the game is over', () => {
    const c = pack();
    const [a, b] = idx(c, 't0');
    let s = fourPlayers(c);
    s = ok(s, c, 0, { type: 'clue', turn: 0, word: 'Alpha Town', count: 2, cards: [a, b] });
    expect(s.history[0].meant).toEqual([a, b]);
    for (const seat of [0, 1, 2, 3]) expect('meant' in viewOf(s, c, seat, 'en').history[0]).toBe(false);
    s = ok(s, c, 1, { type: 'flip', turn: 0, card: idx(c, 'owngoal')[0] });
    expect(s.phase).toBe('over');
    expect(viewOf(s, c, 3, 'en').history[0]).toMatchObject({ meant: [a, b] });
  });

  it("refuses marks that are not the Scout's own hidden cards, repeat a card or miss the number", () => {
    const c = pack();
    const own = idx(c, 't0');
    const s = fourPlayers(c);
    const clue = (cards: number[], count = cards.length) => applyCommand(s, c, 0, { type: 'clue', turn: 0, word: 'Alpha Town', count, cards }, NOW).error;
    expect(clue([idx(c, 't1')[0]])).toBe('bad_cards');
    expect(clue([idx(c, 'owngoal')[0]])).toBe('bad_cards');
    expect(clue([own[0], own[0]])).toBe('bad_cards');
    expect(clue([own[0], own[1]], 3)).toBe('bad_cards');
    // A card already revealed cannot be meant by a later clue.
    let t = ok(ok(s, c, 0, { type: 'clue', turn: 0, word: 'Beta', count: 1 }), c, 1, { type: 'flip', turn: 0, card: own[0] });
    t = ok(t, c, 1, { type: 'endTurn', turn: 0 });
    t = ok(ok(t, c, 2, { type: 'clue', turn: 1, word: 'Gamma', count: 1 }), c, 3, { type: 'flip', turn: 1, card: idx(c, 'neutral')[0] });
    expect(t.turn).toBe(0);
    expect(applyCommand(t, c, 0, { type: 'clue', turn: 2, word: 'Delta', count: 1, cards: [own[0]] }, NOW).error).toBe('bad_cards');
    expect(applyCommand(t, c, 0, { type: 'clue', turn: 2, word: 'Delta', count: 1, cards: [own[1]] }, NOW).error).toBeUndefined();
  });

  it("records what the bot meant: its clue's own cards still hidden", () => {
    const c = pack();
    let duo = startMatch(2, c, NOW, 0);
    duo = ok(duo, c, 0, { type: 'join', team: 0, scout: false });
    duo = ok(duo, c, 1, { type: 'join', team: 1, scout: false });
    duo = ok(duo, c, 0, { type: 'kickoff' });
    const spoke = tick(duo, c, NOW + BOT_CLUE_MS);
    expect(spoke.history[0].clue?.bot).toBe(true);
    expect(spoke.history[0].meant).toEqual(idx(c, 't0'));
    expect(spoke.history[0].meant).toHaveLength(spoke.history[0].clue!.count);
  });
});
