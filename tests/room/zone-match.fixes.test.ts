import { describe, expect, it } from 'vitest';
import {
  IDLE_FORFEIT_MS, afterOutage, applyCommand, engineContent, startMatch, tick, viewOf, zoneMatchPackSchema,
  type ZoneMatchContent, type ZoneMatchState,
} from '../../src/modules/room/games/zone-match/zone-match.engine.js';
import {
  IDLE, MCQ_MS, SHOOTOUT_MAX_KICKS, reducer, type MatchState,
} from '../../src/modules/room/games/zone-match/engine/zoneMatch.machine.js';
import { seatView } from '../../src/modules/room/games/zone-match/engine/zoneMatch.view.js';
import { withRandom } from '../../src/modules/room/games/zone-match/engine/zoneMatch.random.js';

// Invented content only (the repo is public): made-up categories, questions and numbers.
const text = (t: string) => ({ en: t });
const categories = Array.from({ length: 12 }, (_, i) => ({ id: `cat${i}`, name: text(`Category ${i}`), imageUrl: null, icon: null }));
const mcqs = categories.flatMap((c) =>
  Array.from({ length: 10 }, (_, n) => ({ id: `${c.id}-q${n}`, categoryId: c.id, prompt: text(`Question ${n} of ${c.id}`), options: [text('a'), text('b'), text('c'), text('d')], correctIndex: n % 4 })),
);
const content: ZoneMatchContent = zoneMatchPackSchema.parse({
  seed: 777,
  categories,
  mcqs,
  fallback: mcqs.slice(0, 20).map((q) => q.id),
  numerics: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, prompt: text(`Invented number ${i}?`), unit: text('units'), value: 10 + i * 7, step: 1, precision: 0 })),
  rules: { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' },
});

const machineContent = engineContent(content);
const engineCategories = categories.map((c) => ({ id: c.id, name: c.name.en, imageUrl: null, icon: null }));

/** Ticks the clock boundary to boundary, acting through `act` at each view. */
function run(s0: ZoneMatchState, act: (s: ZoneMatchState, now: number) => ZoneMatchState | null, limitMs: number): ZoneMatchState {
  let s = s0;
  let now = 0;
  while (now < limitMs && s.phase !== 'over' && s.phase !== 'cancelled') {
    const acted = act(s, now);
    if (acted) { s = acted; continue; }
    now = Math.max(now + 1, s.deadline);
    s = tick(s, content, now);
  }
  return s;
}

describe('idle forfeit (connected seats cannot hold a match open)', () => {
  it('cancels when both seats go silent after the loadout', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    const end = run(s, () => null, 60 * 60 * 1000);
    expect(end.phase).toBe('cancelled');
  });

  it('forfeits the one silent seat while the other keeps playing', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    const end = run(s, (st, now) => {
      const v = viewOf(st, content, 0, 'en');
      const m = v.match;
      if (m.stage === 'play' && m.battleStep === 'category' && m.possession.attacker === 'player') {
        const open = m.categories.player.find((c) => !m.usedCategories.player.includes(c.id));
        const r = open ? applyCommand(st, content, 0, { type: 'category', round: m.round, categoryId: open.id }, now) : null;
        return r && !r.error ? r.state : null;
      }
      if ((m.stage === 'play' || m.stage === 'shootout') && m.battleStep === 'mcq' && m.mcq && m.mcq.answers.player === null) {
        const r = applyCommand(st, content, 0, { type: 'answer', key: m.mcq.key, index: 0 }, now + 100);
        return r.error ? null : r.state;
      }
      return null;
    }, 60 * 60 * 1000);
    expect(end.phase).toBe('over');
    expect(end.end).toEqual({ reason: 'left', loser: 1 });
  });

  it('does not charge an outage to the idle clock', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    const resumed = afterOutage({ ...s, phase: 'match' }, IDLE_FORFEIT_MS + 60_000);
    expect(Math.min(...resumed.lastMoveAt)).toBeGreaterThan(0);
  });
});

describe('penalty sudden death is bounded', () => {
  it('a shootout nobody answers still ends, within the kick cap', () => {
    let m = withRandom(9, () => reducer(IDLE, { type: 'LAB_SHOOTOUT', categoryPool: engineCategories, opener: 'player', now: 0 }));
    let step = 1;
    while (m.stage !== 'fulltime' && step < 1000) {
      const now = m.advanceAt ?? step;
      m = withRandom(9 + step, () => reducer(m, { type: 'ADVANCE', content: machineContent, now }));
      step += 1;
    }
    expect(m.stage).toBe('fulltime');
    expect(m.shootout!.kicks.length).toBeLessThanOrEqual(SHOOTOUT_MAX_KICKS);
    expect(m.shootout!.winner).not.toBeNull();
  });
});

describe('content exhaustion never replays a revealed answer', () => {
  const dueled = (state: Partial<MatchState>): MatchState => ({
    ...IDLE,
    stage: 'play',
    battleStep: 'category',
    categoryPool: engineCategories,
    categories: { player: engineCategories.slice(0, 5), opponent: engineCategories.slice(5, 10) },
    possession: { attacker: 'player', zone: 'centre' },
    ...state,
  });

  it('an exhausted category and fallback fall through to any unused question', () => {
    const catIds = new Set(['cat0', ...machineContent.fallbackMcqs.map((q) => q.id)]);
    const used = [...machineContent.mcqByCategory.cat0.map((q) => q.id), ...machineContent.fallbackMcqs.map((q) => q.id)];
    const s = dueled({ usedQuestionIds: used });
    const next = withRandom(4, () => reducer(s, { type: 'PICK_CATEGORY', side: 'player', categoryId: 'cat0', content: machineContent, now: 0 }));
    expect(next.mcq).not.toBeNull();
    expect(catIds.has(next.mcq!.question.id)).toBe(false);
    expect(used.includes(next.mcq!.question.id)).toBe(false);
  });

  it('with every number question used, the duel is settled by lot, not by a repeat', () => {
    const noNumerics = { ...machineContent, numerics: [] };
    let s = dueled({});
    s = withRandom(5, () => reducer(s, { type: 'PICK_CATEGORY', side: 'player', categoryId: 'cat0', content: noNumerics, now: 0 }));
    const correct = machineContent.mcqByCategory.cat0.find((q) => q.id === s.mcq!.question.id)!.correctIndex;
    s = withRandom(6, () => reducer(s, { type: 'ANSWER', side: 'player', index: correct, now: 100 }));
    s = withRandom(7, () => reducer(s, { type: 'ANSWER', side: 'opponent', index: correct, now: 200 }));
    s = withRandom(8, () => reducer(s, { type: 'ADVANCE', content: noNumerics, now: s.advanceAt! }));
    expect(s.battleStep).toBe('mcqReveal');
    s = withRandom(9, () => reducer(s, { type: 'ADVANCE', content: noNumerics, now: s.advanceAt! }));
    expect(s.numeric).toBeNull();
    expect(s.battleStep).toBe('outcome');
    expect(s.outcomeNote).toBe('Out of number questions — luck decides');
  });
});

describe('cards obey the answer clock', () => {
  it('a live card after the deadline is rejected', () => {
    let s: MatchState = {
      ...IDLE,
      stage: 'play',
      battleStep: 'category',
      categoryPool: engineCategories,
      categories: { player: engineCategories.slice(0, 5), opponent: engineCategories.slice(5, 10) },
      possession: { attacker: 'player', zone: 'centre' },
      deck: { player: ['substitution'], opponent: [] },
      windowMode: 'question',
    };
    s = withRandom(3, () => reducer(s, { type: 'PICK_CATEGORY', side: 'player', categoryId: 'cat0', content: machineContent, now: 0 }));
    // The card window: the player skips the blind pick, then the question opens.
    while (s.battleStep !== 'mcq') {
      s = withRandom(30, () => reducer(s, s.battleStep === 'cards' ? { type: 'CHOOSE_CARD', side: 'player', card: null, now: s.advanceAt! } : { type: 'ADVANCE', content: machineContent, now: s.advanceAt! }));
    }
    const late = withRandom(31, () => reducer(s, { type: 'PLAY_LIVE', side: 'player', card: 'substitution', content: machineContent, now: s.mcq!.deadline + 1 }));
    expect(late).toBe(s);
    const inTime = withRandom(31, () => reducer(s, { type: 'PLAY_LIVE', side: 'player', card: 'substitution', content: machineContent, now: s.mcq!.deadline - 1000 }));
    expect(inTime.mcq!.key).not.toBe(s.mcq!.key);
  });
});

describe('a Second Ball miss stays the misser’s secret while the question is open', () => {
  const base: MatchState = {
    ...IDLE,
    stage: 'play',
    battleStep: 'mcq',
    duelNo: 3,
    advanceAt: 12_000,
    deck: { player: ['second-ball'], opponent: [] },
    played: { player: ['second-ball'], opponent: [] },
    mcq: {
      key: 7,
      question: { id: 'q', prompt: '', options: ['', '', '', ''], correctIndex: 1, categoryId: 'cat0' },
      categoryName: '',
      offCategory: false,
      answers: { player: null, opponent: null },
      answeredAt: { player: null, opponent: null },
      firstMiss: { player: null, opponent: null },
      startedAt: 0,
      deadline: 12_000,
      hidden: { player: [], opponent: [] },
      hiddenAt: { player: null, opponent: null },
    },
  };

  it('no card event is minted while the question is open; the reveal fires it for both', () => {
    // The miss: firstMiss set, no event — even the event sequence would tell the other side.
    const missed = withRandom(11, () => reducer(base, { type: 'ANSWER', side: 'player', index: 2, now: 1000 }));
    expect(missed.mcq!.firstMiss.player).toBe(2);
    expect(missed.cardEvents).toHaveLength(0);
    expect(seatView(missed, 'opponent').state.mcq!.firstMiss.opponent).toBeNull();
    // The reveal: the event appears for both seats.
    const revealed = withRandom(12, () => reducer(missed, { type: 'ADVANCE', content: machineContent, now: 12_000 }));
    expect(revealed.battleStep).toBe('mcqReveal');
    expect(revealed.cardEvents).toEqual([expect.objectContaining({ card: 'second-ball', side: 'player', phase: 'question' })]);
    expect(seatView(revealed, 'opponent').state.cardEvents).toHaveLength(1);
  });

  it('a correct retry still fires the event at reveal (the opponent learns a second ball was needed)', () => {
    const missed = withRandom(11, () => reducer(base, { type: 'ANSWER', side: 'player', index: 2, now: 1000 }));
    const retried = withRandom(13, () => reducer(missed, { type: 'ANSWER', side: 'player', index: 1, now: 2000 }));
    expect(retried.mcq!.answers.player).toBe(1);
    expect(retried.cardEvents).toHaveLength(0); // still nothing while the question is open
    const revealed = withRandom(12, () => reducer(retried, { type: 'ADVANCE', content: machineContent, now: 12_000 }));
    expect(revealed.cardEvents).toEqual([expect.objectContaining({ card: 'second-ball', side: 'player' })]);
  });

  it('the one-card-per-question rule makes the Second-Ball-then-Substitution leak impossible', () => {
    // Second Ball is a blind card: once played it sits in `played`, so the live Substitution is refused (one card
    // per question). The codex-flagged "Substitution loses the held miss" path therefore cannot occur in a match.
    const subBase: MatchState = { ...base, cardWindow: true, deck: { player: ['second-ball', 'substitution'], opponent: [] } };
    const missed = withRandom(11, () => reducer(subBase, { type: 'ANSWER', side: 'player', index: 2, now: 1000 }));
    expect(missed.mcq!.firstMiss.player).toBe(2);
    const swapped = withRandom(14, () => reducer(missed, { type: 'PLAY_LIVE', side: 'player', card: 'substitution', content: machineContent, now: 3000 }));
    // Rejected: the state is untouched, the question is the same, nothing to leak.
    expect(swapped).toBe(missed);
    expect(swapped.mcq!.key).toBe(missed.mcq!.key);
  });
});

describe('outage recovery after a Substitution', () => {
  it('restores the question window, not an oversized one', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    // A substituted question keeps the first question's startedAt but a fresh deadline.
    const substituted: ZoneMatchState = {
      ...s,
      match: {
        ...s.match,
        stage: 'play',
        battleStep: 'mcq',
        mcq: {
          key: 2,
          question: { id: 'q', prompt: '', options: ['', '', '', ''], correctIndex: 0, categoryId: 'cat0' },
          categoryName: '',
          offCategory: false,
          answers: { player: null, opponent: null },
          answeredAt: { player: null, opponent: null },
          firstMiss: { player: null, opponent: null },
          startedAt: 0,
          deadline: 4_000 + MCQ_MS,
          hidden: { player: [], opponent: [] },
          hiddenAt: { player: null, opponent: null },
        },
      },
    };
    const resumed = afterOutage(substituted, 60_000);
    expect(resumed.match.mcq!.deadline - 60_000).toBe(MCQ_MS);
  });
});

describe('the view never names the private pool', () => {
  it('masks the number question id and keeps used ids on the server', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    const numeric: ZoneMatchState = {
      ...s,
      match: {
        ...s.match,
        stage: 'play',
        battleStep: 'numeric',
        usedNumericIds: ['n1', 'n2'],
        numeric: {
          key: 5,
          question: { id: 'n2', prompt: { en: 'Invented?' }, unit: { en: 'u' }, value: 42, step: 1, precision: 0 },
          guesses: { player: { value: null, lockedAtMs: null }, opponent: { value: null, lockedAtMs: null } },
          startedAt: 0,
          deadline: 15_000,
          result: null,
        },
      },
    };
    for (const seat of [0, 1]) {
      const v = viewOf(numeric, content, seat, 'en');
      expect(v.match.numeric!.question.id).toBe('n5');
      expect(v.match.numeric!.question.value).toBe(0);
      expect(v.match.usedNumericIds).toEqual([]);
      expect(v.match.usedQuestionIds).toEqual([]);
    }
  });
});
