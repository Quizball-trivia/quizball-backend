import { describe, expect, it } from 'vitest';
import { redactedIssues, showPackHash, showPackLayout, showPackSchema, showPackSlots } from '../../src/modules/weekend-league/show-packs/show-pack.js';
import { wlNextSlot, wlSlotSequence } from '../../src/modules/weekend-league/wl-live-engine.js';
import { wlShowLayoutOf } from '../../src/modules/weekend-league/wl-config.js';

const opts = (...ids: string[]) => ids.map((id) => ({ id, text: { ka: `ვარიანტი ${id}` } }));

const pack = {
  slug: 'orshabatoba',
  eventDate: '2026-11-23',
  rounds: [
    { kind: 'true_false', questions: [
      { prompt: { ka: 'კითხვა 1' }, correct: 'false' },
      { prompt: { ka: 'კითხვა 2' }, correct: 'true' },
    ] },
    { kind: 'zoom_out', title: { ka: 'გადიდებული' }, questions: [
      { prompt: { ka: 'კითხვა 3' }, image: '/assets/orshabatoba/packs/x.webp', focus: { x: 0.3, y: 0.4 }, options: opts('a', 'b', 'c', 'd'), correct: 'b' },
    ] },
    { kind: 'evolution', questions: [
      { prompt: { ka: 'კითხვა 4' }, eras: [{ year: 1960, image: 'https://example.com/1.png' }, { year: 2000, image: 'https://example.com/2.png' }], options: opts('a', 'b', 'c'), correct: 'c' },
    ] },
    { kind: 'fake_fact', questions: [
      { prompt: { ka: 'კითხვა 5' }, subject: { name: { ka: 'მოთამაშე' } }, options: opts('a', 'b', 'c', 'd'), correct: 'd' },
    ] },
  ],
};

describe('show packs', () => {
  it('validates a well-formed pack', () => {
    expect(() => showPackSchema.parse(pack)).not.toThrow();
  });

  it('rejects a correct id that is not an option, true_false options, and image-less zoom_out', () => {
    const bad = structuredClone(pack) as any;
    bad.rounds[1].questions[0].correct = 'z';
    bad.rounds[0].questions[0].options = opts('a', 'b');
    delete bad.rounds[1].questions[0].image;
    const r = showPackSchema.safeParse(bad);
    expect(r.success).toBe(false);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message).join(' | ');
    expect(msgs).toContain('correct is not one of the option ids');
    expect(msgs).toContain('true_false takes no options');
    expect(msgs).toContain('zoom_out needs an image');
  });

  it('only accepts a Monday and a known show, and never echoes a rejected answer', () => {
    expect(showPackSchema.safeParse({ ...pack, eventDate: '2026-11-24' }).success).toBe(false);
    expect(showPackSchema.safeParse({ ...pack, eventDate: '2026-02-30' }).success).toBe(false);
    expect(showPackSchema.safeParse({ ...pack, slug: 'orshabatoaba' }).success).toBe(false);
    const leaky = structuredClone(pack) as any;
    leaky.rounds[1].questions[0].correct = 'SECRET-ANSWER-TEXT';
    const r = showPackSchema.safeParse(leaky);
    expect(r.success).toBe(false);
    const lines = r.success ? [] : redactedIssues(r.error.issues);
    expect(lines.join(' ')).toContain('correct is not one of the option ids');
    expect(lines.join(' ')).not.toContain('SECRET-ANSWER-TEXT');
  });

  it('turns rounds into game-0 slots scored as mcq / true_false', () => {
    const slots = showPackSlots(showPackSchema.parse(pack));
    expect(slots.map((s) => [s.roundIndex, s.questionIndex, s.kind])).toEqual([
      [0, 0, 'true_false'], [0, 1, 'true_false'], [1, 0, 'mcq'], [2, 0, 'mcq'], [3, 0, 'mcq'],
    ]);
    expect(slots.every((s) => s.gameIndex === 0 && s.reserveOrdinal === 0 && s.sourceQuestionId === null)).toBe(true);
    const zoom = slots[2]!;
    expect(zoom.evaluation).toEqual({ correct_id: 'b' });
    expect(zoom.payload['show']).toMatchObject({ kind: 'zoom_out', focus: { x: 0.3, y: 0.4 }, round_title: { ka: 'გადიდებული', en: 'გადიდებული' } });
    expect(zoom.payload['image']).toEqual({ url: '/assets/orshabatoba/packs/x.webp' });
    expect(slots[0]!.payload['options']).toBeUndefined();
    expect((slots[3]!.payload['show'] as any).eras[1]).toEqual({ year: 2000, image: { url: 'https://example.com/2.png' } });
  });

  it('layout + hash', () => {
    const parsed = showPackSchema.parse(pack);
    expect(showPackLayout(parsed)).toEqual([
      { kind: 'true_false', count: 2 }, { kind: 'zoom_out', count: 1 }, { kind: 'evolution', count: 1 }, { kind: 'fake_fact', count: 1 },
    ]);
    const changed = structuredClone(parsed); changed.rounds[0]!.questions[0]!.correct = 'true';
    expect(showPackHash(parsed)).not.toBe(showPackHash(changed));
  });
});

describe('slot sequence with a show layout', () => {
  it('follows the layout instead of the WL round order', () => {
    const layout = wlShowLayoutOf({ show_rounds: [{ kind: 'true_false', count: 2 }, { kind: 'mcq', count: 1 }, { kind: 'zoom_out', count: 3 }] });
    expect(layout).toEqual([2, 1, 3]);
    const seq = wlSlotSequence(0, layout);
    expect(seq.map((s) => `${s.roundIndex}.${s.questionIndex}`)).toEqual(['0.0', '0.1', '1.0', '2.0', '2.1', '2.2']);
    expect(wlNextSlot({ gameIndex: 0, roundIndex: 0, questionIndex: 1 }, layout)).toEqual({ gameIndex: 0, roundIndex: 1, questionIndex: 0 });
    expect(wlNextSlot({ gameIndex: 0, roundIndex: 2, questionIndex: 2 }, layout)).toBeNull();
  });

  it('falls back to the WL layout without one', () => {
    expect(wlShowLayoutOf({})).toBeNull();
    expect(wlShowLayoutOf({ show_rounds: [{ kind: 'mcq', count: 0 }] })).toBeNull();
    expect(wlSlotSequence(0, null)).toHaveLength(21);
  });
});
