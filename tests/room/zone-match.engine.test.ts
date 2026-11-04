import { describe, expect, it } from 'vitest';
import {
  afterOutage, applyCommand, seatsChanged, standings, startMatch, tick, viewOf, zoneMatchPackSchema,
  type ZoneMatchContent, type ZoneMatchState,
} from '../../src/modules/room/games/zone-match/zone-match.engine.js';

// Invented content only (the repo is public): made-up categories, questions and numbers.
const text = (t: string) => ({ en: t, es: t });
const categories = Array.from({ length: 12 }, (_, i) => ({ id: `cat${i}`, name: text(`Category ${i}`), imageUrl: null, icon: null }));
const mcqs = categories.flatMap((c) =>
  Array.from({ length: 10 }, (_, n) => ({ id: `${c.id}-q${n}`, categoryId: c.id, prompt: text(`Question ${n} of ${c.id}`), options: [text('a'), text('b'), text('c'), text('d')], correctIndex: n % 4 })),
);
const content: ZoneMatchContent = zoneMatchPackSchema.parse({
  seed: 12345,
  categories,
  mcqs,
  fallback: mcqs.slice(0, 20).map((q) => q.id),
  numerics: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, prompt: text(`Invented number ${i}?`), unit: text('units'), value: 10 + i * 7, step: 1, precision: 0 })),
  rules: { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' },
});

/** Both seats act on their own views (as clients would), the clock ticks between. */
function play(s0: ZoneMatchState, answers: (seat: number, correct: boolean) => boolean, limit = 3000): ZoneMatchState {
  let s = s0;
  let now = 0;
  for (let i = 0; i < limit && s.phase !== 'over' && s.phase !== 'cancelled'; i += 1) {
    let acted = false;
    for (const seat of [0, 1]) {
      const v = viewOf(s, content, seat, 'en');
      const m = v.match;
      if (v.phase === 'loadout' && !v.loadoutIn.you) {
        s = applyCommand(s, content, seat, { type: 'loadout', cards: [] }, now).state;
        acted = true;
      } else if (m.stage === 'play' && m.battleStep === 'category' && m.possession.attacker === 'player') {
        const open = m.categories.player.find((c) => !m.usedCategories.player.includes(c.id));
        if (open) {
          const r = applyCommand(s, content, seat, { type: 'category', round: m.round, categoryId: open.id }, now);
          if (!r.error) { s = r.state; acted = true; }
        }
      } else if (m.stage === 'play' && m.battleStep === 'cards' && m.choice.player === undefined) {
        const r = applyCommand(s, content, seat, { type: 'card', duel: m.duelNo, card: null }, now);
        if (!r.error) { s = r.state; acted = true; }
      } else if ((m.stage === 'play' || m.stage === 'shootout') && m.battleStep === 'mcq' && m.mcq && m.mcq.answers.player === null) {
        // The view hides the right answer: a seat that "knows" uses the pack (as a test oracle only).
        const q = content.mcqs.find((x) => x.id === s.match.mcq!.question.id)!;
        const index = answers(seat, true) ? q.correctIndex : (q.correctIndex + 1) % 4;
        const r = applyCommand(s, content, seat, { type: 'answer', key: m.mcq.key, index }, now + 200 + seat * 100);
        if (!r.error) { s = r.state; acted = true; }
      } else if (m.numeric && !m.numeric.result && m.numeric.guesses.player.value === null) {
        const r = applyCommand(s, content, seat, { type: 'guess', key: m.numeric.key, value: 20 + seat }, now);
        if (!r.error) { s = r.state; acted = true; }
      }
    }
    if (!acted) {
      now = Math.max(now + 1, s.deadline);
      s = tick(s, content, now);
    }
  }
  return s;
}

describe('zone match room engine', () => {
  it('plays a match from the loadout pick to the end', () => {
    const end = play(startMatch(2, content, 0), (seat) => seat === 0);
    expect(end.phase).toBe('over');
    const st = standings(end);
    expect(st.find((x) => x.seat === 0)!.place).toBe(1);
    expect(st.find((x) => x.seat === 1)!.place).toBe(2);
  });

  it('plays the same match twice from the same seed and commands', () => {
    const a = play(startMatch(2, content, 0), (seat) => seat === 0);
    const b = play(startMatch(2, content, 0), (seat) => seat === 0);
    expect(b.match.score).toEqual(a.match.score);
    expect(b.match.feed).toEqual(a.match.feed);
  });

  it('never shows a seat the right answer or the other answer before the reveal', () => {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    let now = 0;
    for (let i = 0; i < 200 && !(s.match.stage === 'play' && s.match.battleStep === 'mcq'); i += 1) {
      const v = viewOf(s, content, s.match.possession.attacker === 'player' ? 0 : 1, 'en');
      if (v.match.battleStep === 'category') {
        const open = v.match.categories.player.find((c) => !v.match.usedCategories.player.includes(c.id))!;
        const seat = s.match.possession.attacker === 'player' ? 0 : 1;
        s = applyCommand(s, content, seat, { type: 'category', round: s.match.round, categoryId: open.id }, now).state;
        continue;
      }
      now = Math.max(now + 1, s.deadline);
      s = tick(s, content, now);
    }
    expect(s.match.battleStep).toBe('mcq');
    s = applyCommand(s, content, 1, { type: 'answer', key: s.match.mcq!.key, index: 2 }, now + 100).state;
    for (const seat of [0, 1]) {
      const v = viewOf(s, content, seat, 'en');
      expect(v.match.mcq!.question.correctIndex).toBe(-1);
      expect(v.match.mcq!.answers.opponent).toBeNull();
      expect(JSON.stringify(v)).not.toContain('"correctIndex":' + s.match.mcq!.question.correctIndex + ',"categoryId"');
      expect(v.question!.prompt).toContain('Question');
      // The real id never leaves the server (the questions API answers by id).
      expect(JSON.stringify(v)).not.toContain(s.match.mcq!.question.id);
    }
    expect(viewOf(s, content, 0, 'en').opponentAnswered).toBe(true);
    expect(viewOf(s, content, 1, 'en').match.mcq!.answers.player).toBe(2);
  });

  it('rejects a stale answer for an earlier question', () => {
    const s = play(startMatch(2, content, 0), () => true, 40);
    const r = applyCommand(s, content, 0, { type: 'answer', key: 999999, index: 0 }, 0);
    expect(r.error === 'stale' || r.error === 'not_open').toBe(true);
  });

  it('a seat that leaves loses', () => {
    let s = startMatch(2, content, 0);
    s = seatsChanged(s, [{ seat: 1, change: 'leave' }]);
    expect(s.phase).toBe('over');
    expect(standings(s).find((x) => x.seat === 0)!.place).toBe(1);
  });
});

describe('zone match room engine: review fixes', () => {
  /** Plays up to the first open question. */
  function toFirstQuestion(): { s: ZoneMatchState; now: number } {
    let s = startMatch(2, content, 0);
    s = applyCommand(s, content, 0, { type: 'loadout', cards: [] }, 0).state;
    s = applyCommand(s, content, 1, { type: 'loadout', cards: [] }, 0).state;
    let now = 0;
    for (let i = 0; i < 200 && !(s.match.stage === 'play' && s.match.battleStep === 'mcq'); i += 1) {
      if (s.match.battleStep === 'category' && s.match.stage === 'play') {
        const seat = s.match.possession.attacker === 'player' ? 0 : 1;
        const v = viewOf(s, content, seat, 'en');
        const open = v.match.categories.player.find((c) => !v.match.usedCategories.player.includes(c.id))!;
        s = applyCommand(s, content, seat, { type: 'category', round: s.match.round, categoryId: open.id }, now).state;
        continue;
      }
      now = Math.max(now + 1, s.deadline);
      s = tick(s, content, now);
    }
    return { s, now };
  }

  it('an outage restarts the open question without changing a time already locked in', () => {
    const { s: open, now } = toFirstQuestion();
    const answered = applyCommand(open, content, 0, { type: 'answer', key: open.match.mcq!.key, index: 0 }, open.match.mcq!.startedAt + 4000).state;
    const elapsed = answered.match.mcq!.answeredAt.player! - answered.match.mcq!.startedAt;
    const later = now + 60_000;
    const recovered = afterOutage(answered, later);
    expect(recovered.match.mcq!.startedAt).toBe(later);
    expect(recovered.match.mcq!.answeredAt.player! - recovered.match.mcq!.startedAt).toBe(elapsed);
    expect(recovered.match.mcq!.deadline - later).toBe(open.match.mcq!.deadline - open.match.mcq!.startedAt);
  });

  it('a live card for an earlier question (before a Substitution) is stale', () => {
    const { s } = toFirstQuestion();
    const r = applyCommand(s, content, 0, { type: 'live', duel: s.match.duelNo, key: s.match.mcq!.key + 1, card: 'fifty-fifty' }, s.match.mcq!.startedAt + 100);
    expect(r.error).toBe('stale');
  });

  it("keeps the other seat's blind card hidden after the state was stored as JSON", () => {
    let s = toFirstQuestion().s;
    // Next duel's card window, both sides through JSON as the runtime stores them.
    s = JSON.parse(JSON.stringify({ ...s, match: { ...s.match, battleStep: 'cards', choice: { player: 'fog', opponent: undefined } } }));
    // Seat 1 learns only that they have picked (null), never the card.
    const v = viewOf(s, content, 1, 'en');
    expect(v.match.choice.opponent).toBeNull();
    expect(JSON.stringify(v.match.choice)).not.toContain('fog');
    expect(viewOf(s, content, 0, 'en').match.choice.player).toBe('fog');
  });
});
