import { describe, expect, it } from 'vitest';
import '../setup.js';

const { toShowQuestion, packUsage, sameQuestionKey, showState, SHOW_LAYOUT } = await import('../../src/modules/harness/harness.show.js');
const { showPackSchema } = await import('../../src/modules/weekend-league/show-packs/show-pack.js');

const t = (en: string) => ({ en, ka: `ქართ ${en}` });
const tf = { id: '11111111-1111-4111-8111-111111111111', prompt: t('Ronaldo scored 700 club goals at Real Madrid.'), payload: { options: [{ id: 'true', text: t('True'), is_correct: false }, { id: 'false', text: t('False'), is_correct: true }] } };
const mcq = {
  id: '22222222-2222-4222-8222-222222222222',
  prompt: t('In which minute was this save made?'),
  payload: { image: { url: 'https://cdn.example/q36.webp' }, options: [{ id: 'x1', text: t('118th'), is_correct: false }, { id: 'x2', text: t('123rd'), is_correct: true }, { id: 'x3', text: t('120th'), is_correct: false }] },
};
const order = {
  id: '33333333-3333-4333-8333-333333333333',
  prompt: t('Order by clean sheets'),
  payload: { instruction: null, items: [{ id: 'b', label: t('Cech'), sort_value: 1 }, { id: 'a', label: t('James'), sort_value: 2 }, { id: 'c', label: t('De Gea'), sort_value: 3 }] },
};
const career = { id: '44444444-4444-4444-8444-444444444444', prompt: t('Who is this?'), payload: { clubs: [t('Boca'), t('Brighton'), t('Liverpool')], display_answer: t('Mac Allister'), accepted_answers: ['Mac Allister'] } };
const who = { id: '55555555-5555-4555-8555-555555555555', prompt: t('Who am I?'), payload: { clues: [1, 2, 3, 4, 5].map((n) => ({ type: 'text', content: t(`clue ${n}`) })), display_answer: t('Reyes'), accepted_answers: ['Reyes'] } };

describe('show pack questions from the bank', () => {
  it('turns a true/false question into a one-tap question with a readable answer', () => {
    const p = toShowQuestion('true_false', tf)!;
    expect(p.question).toEqual({ prompt: tf.prompt, correct: 'false' });
    expect(p.view.answer).toEqual({ ka: 'მცდარია', en: 'False' });
  });

  it('gives multiple choice short option ids and keeps the photo', () => {
    const p = toShowQuestion('mcq', mcq)!;
    expect(p.question.options!.map((o) => o.id)).toEqual(['a', 'b', 'c']);
    expect(p.question.correct).toBe('b');
    expect(p.question.image).toBe('https://cdn.example/q36.webp');
    expect(p.view.options.filter((o) => o.correct)).toEqual([{ text: t('123rd'), correct: true }]);
  });

  it('shows put in order in the right order, and the answer of career path and who am I', () => {
    expect(toShowQuestion('put_in_order', order)!.view.lines.map((l) => l.en)).toEqual(['Cech', 'James', 'De Gea']);
    expect(toShowQuestion('career_path', career)!.view).toMatchObject({ prompt: null, answer: t('Mac Allister') });
    expect(toShowQuestion('who_am_i', who)!.view.lines).toHaveLength(5);
  });

  it('refuses a question that cannot be played: no Georgian, no right answer, too few clues', () => {
    expect(toShowQuestion('true_false', { ...tf, prompt: { en: 'English only' } })).toBeNull();
    expect(toShowQuestion('mcq', { ...mcq, payload: { options: mcq.payload.options.map((o) => ({ ...o, is_correct: false })) } })).toBeNull();
    expect(toShowQuestion('who_am_i', { ...who, payload: { ...who.payload, clues: who.payload.clues.slice(0, 4) } })).toBeNull();
    expect(toShowQuestion('career_path', { ...career, payload: { ...career.payload, accepted_answers: [] } })).toBeNull();
  });

  it('builds a pack the show accepts from one question per slot', () => {
    const by = { true_false: tf, mcq, put_in_order: order, career_path: career, who_am_i: who };
    const rounds = SHOW_LAYOUT.map((s) => ({ kind: s.kind, title: s.title, ...(s.cut ? { cut: s.cut } : {}), questions: Array.from({ length: s.count }, () => toShowQuestion(s.kind, by[s.kind])!.question) }));
    const parsed = showPackSchema.safeParse({ slug: 'orshabatoba', eventDate: '2027-01-04', rounds });
    expect(parsed.success).toBe(true);
    expect(rounds.reduce((n, r) => n + r.questions.length, 0)).toBe(21);
  });
});

describe('show pack bookkeeping', () => {
  it('collects the source questions and Georgian prompts a stored pack used', () => {
    const used = { ids: new Set<string>(), prompts: new Set<string>() };
    packUsage({ rounds: [{ questions: [toShowQuestion('true_false', tf)!.question, toShowQuestion('career_path', career)!.question] }] }, used);
    expect([...used.ids]).toEqual([career.id]);
    expect([...used.prompts]).toEqual([tf.prompt.ka, `player:${career.payload.display_answer.ka}`]);
  });

  it('treats career path and who am I as the same question by player, not by their shared prompt', () => {
    const other = { ...who, id: '66666666-6666-4666-8666-666666666666', payload: { ...who.payload, display_answer: t('Banega') } };
    expect(sameQuestionKey('who_am_i', toShowQuestion('who_am_i', who)!.view)).not.toBe(sameQuestionKey('who_am_i', toShowQuestion('who_am_i', other)!.view));
    expect(sameQuestionKey('career_path', toShowQuestion('career_path', { ...career, payload: { ...career.payload, display_answer: t('Reyes') } })!.view)).toBe(sameQuestionKey('who_am_i', toShowQuestion('who_am_i', who)!.view));
    expect(sameQuestionKey('true_false', toShowQuestion('true_false', tf)!.view)).toBe(tf.prompt.ka);
  });

  it('describes the next show: counts, questions by round, and whether the stored pack is this one', () => {
    const pick = toShowQuestion('true_false', tf)!;
    const pack = showPackSchema.parse({ slug: 'orshabatoba', eventDate: '2027-01-04', rounds: [{ kind: 'true_false', title: { ka: 'ტური' }, questions: [pick.question, pick.question] }] });
    const questions = [
      { round: 0, question: 0, kind: 'true_false' as const, source_id: tf.id, check: 'ok' as const, note: '', view: pick.view },
      { round: 0, question: 1, kind: 'true_false' as const, source_id: tf.id, check: 'flagged' as const, note: 'Out of date', view: pick.view },
    ];
    const row = { id: 'p1', event_date: '2027-01-04', status: 'ready' as const, pack, questions, swap_rounds: 2, dropped: [{ id: 'old', key: 'k' }, { id: 'x1', key: 'k1', kind: 'true_false' as const, by: 'checker' as const, note: 'Record broken in 2026.', text: { ka: 'ძველი' }, at: '2026-11-26T09:00:00Z' }], approved_by: null, loaded_hash: null, updated_at: '2026-11-26T10:00:00Z' };
    const s = showState('2027-01-04', row, null);
    expect(s).toMatchObject({ episode: 307, loaded: false, loadedIsThisPack: false });
    expect(s.pack!.removed).toEqual([{ kind: 'true_false', by: 'checker', note: 'Record broken in 2026.', text: { ka: 'ძველი' }, at: '2026-11-26T09:00:00Z' }]);
    expect(s.pack!.counts).toEqual({ total: 2, ok: 1, flagged: 1, notChecked: 0, checking: 0 });
    expect(s.pack!.rounds[0]!.questions.map((q) => [q.index, q.check, q.note])).toEqual([[0, 'ok', ''], [1, 'flagged', 'Out of date']]);
    expect(showState('2027-01-04', null, pack)).toMatchObject({ loaded: true, loadedIsThisPack: false, pack: null });
  });
});
