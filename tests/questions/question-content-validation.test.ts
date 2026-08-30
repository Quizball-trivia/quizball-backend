import { describe, expect, it } from 'vitest';

import {
  validateQuestionContent,
  blockingIssues,
  type QuestionContentIssue,
} from '../../src/modules/questions/question-content-validation.js';

const prompt = (en: string, ka = 'ქართული ტექსტი') => ({ en, ka });

const codes = (issues: QuestionContentIssue[]) => issues.map((issue) => issue.code);

function orderItem(labelEn: string, labelKa: string, sortValue: number) {
  return {
    id: `item-${sortValue}`,
    label: { en: labelEn, ka: labelKa },
    details: null,
    emoji: null,
    sort_value: sortValue,
  };
}

describe('validateQuestionContent', () => {
  describe('corruption and locales', () => {
    it('blocks [object Object] anywhere in the payload', () => {
      const issues = validateQuestionContent({
        type: 'career_path',
        prompt: prompt('Whose career path is this?'),
        payload: {
          type: 'career_path',
          clubs: [{ en: 'Monaco', ka: '[object Object]' }, { en: 'Juventus', ka: 'იუვენტუსი' }],
          display_answer: { en: 'Paul Pogba', ka: 'პოლ პოგბა' },
          accepted_answers: ['Paul Pogba', 'Pogba', 'პოლ პოგბა'],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('corrupted-string');
    });

    it('blocks a prompt with missing Georgian', () => {
      const issues = validateQuestionContent({
        type: 'mcq_single',
        prompt: { en: 'Who won?', ka: '' },
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'A', text: { en: 'Brazil', ka: 'ბრაზილია' }, is_correct: true },
            { id: 'B', text: { en: 'Italy', ka: 'იტალია' }, is_correct: false },
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('missing-locale');
    });
  });

  describe('put_in_order', () => {
    it('blocks the self-solving year pattern (visible years match answer order)', () => {
      const issues = validateQuestionContent({
        type: 'put_in_order',
        prompt: prompt('Order these Liverpool CL victories by year, earliest first.'),
        payload: {
          type: 'put_in_order',
          direction: 'asc',
          prompt: prompt('Order these Liverpool CL victories by year, earliest first.'),
          items: [
            orderItem('1977 (Rome)', '1977 (რომი)', 1),
            orderItem('1984 (Rome)', '1984 (რომი)', 2),
            orderItem('2005 (Istanbul)', '2005 (სტამბული)', 3),
            orderItem('2019 (Madrid)', '2019 (მადრიდი)', 4),
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('ordering-value-leak');
    });

    it('allows years as context when they do not sort in answer order', () => {
      const issues = validateQuestionContent({
        type: 'put_in_order',
        prompt: prompt('Order these England players by goals at a single World Cup, fewest to most.'),
        payload: {
          type: 'put_in_order',
          direction: 'asc',
          prompt: prompt('Order these England players by goals, fewest to most.'),
          items: [
            orderItem('Jermain Defoe 2010', 'ჯერმეინ დეფო 2010', 1),
            orderItem('Michael Owen 1998', 'მაიკლ ოუენი 1998', 2),
            orderItem('Geoff Hurst 1966', 'ჯეფ ჰერსტი 1966', 3),
            orderItem('Harry Kane 2018', 'ჰარი კეინი 2018', 4),
          ],
        },
      });
      expect(codes(blockingIssues(issues))).not.toContain('ordering-value-leak');
    });

    it('flags a descending leak too', () => {
      const issues = validateQuestionContent({
        type: 'put_in_order',
        prompt: prompt('Order these transfers, most recent first.'),
        payload: {
          type: 'put_in_order',
          direction: 'desc',
          prompt: prompt('Order these transfers, most recent first.'),
          items: [
            orderItem('Rice (2023)', 'რაისი (2023)', 1),
            orderItem('Pepe (2019)', 'პეპე (2019)', 2),
            orderItem('Aubameyang (2018)', 'ობამეიანგი (2018)', 3),
            orderItem('Ozil (2013)', 'ოზილი (2013)', 4),
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('ordering-value-leak');
    });

    it('downgrades a 3-item leak to review (monotonic-by-chance rate too high)', () => {
      const issues = validateQuestionContent({
        type: 'put_in_order',
        prompt: prompt('Order these transfers, most recent first.'),
        payload: {
          type: 'put_in_order',
          direction: 'desc',
          prompt: prompt('Order these transfers, most recent first.'),
          items: [
            orderItem('Rice (2023)', 'რაისი (2023)', 1),
            orderItem('Pepe (2019)', 'პეპე (2019)', 2),
            orderItem('Aubameyang (2018)', 'ობამეიანგი (2018)', 3),
          ],
        },
      });
      const leak = issues.find((issue) => issue.code === 'ordering-value-leak');
      expect(leak?.severity).toBe('review');
      expect(codes(blockingIssues(issues))).not.toContain('ordering-value-leak');
    });

    it('blocks tied sort values', () => {
      const issues = validateQuestionContent({
        type: 'put_in_order',
        prompt: prompt('Order these.'),
        payload: {
          type: 'put_in_order',
          direction: 'asc',
          prompt: prompt('Order these.'),
          items: [
            orderItem('One', 'ერთი', 1),
            orderItem('Two', 'ორი', 1),
            orderItem('Three', 'სამი', 2),
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('tied-sort-values');
    });
  });

  describe('typed-answer coverage', () => {
    const baseClue = {
      type: 'clue_chain',
      display_answer: { en: 'Kyle Walker', ka: 'კაილ უოკერი' },
      clues: [{ type: 'text', content: { en: 'Clue one', ka: 'მინიშნება ერთი' } }],
    };

    it('blocks when the Georgian display answer is not accepted', () => {
      const issues = validateQuestionContent({
        type: 'clue_chain',
        prompt: prompt('Who am I?'),
        payload: { ...baseClue, accepted_answers: ['Kyle Walker', 'Walker'] },
      });
      const blockers = blockingIssues(issues);
      expect(codes(blockers)).toContain('display-answer-not-accepted');
      expect(blockers.find((b) => b.code === 'display-answer-not-accepted')?.path).toBe(
        'payload.display_answer.ka'
      );
    });

    it('passes when both display answers are accepted', () => {
      const issues = validateQuestionContent({
        type: 'clue_chain',
        prompt: prompt('Who am I?'),
        payload: { ...baseClue, accepted_answers: ['Kyle Walker', 'Walker', 'კაილ უოკერი'] },
      });
      expect(blockingIssues(issues)).toEqual([]);
    });

    it('blocks empty accepted answers', () => {
      const issues = validateQuestionContent({
        type: 'career_path',
        prompt: prompt('Whose career path is this?'),
        payload: {
          type: 'career_path',
          clubs: [{ en: 'Monaco', ka: 'მონაკო' }, { en: 'Juventus', ka: 'იუვენტუსი' }],
          display_answer: { en: 'Paul Pogba', ka: 'პოლ პოგბა' },
          accepted_answers: [],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('no-accepted-answers');
    });

    it('marks thin alias coverage as review, not block', () => {
      const issues = validateQuestionContent({
        type: 'clue_chain',
        prompt: prompt('Who am I?'),
        payload: { ...baseClue, accepted_answers: ['Kyle Walker', 'კაილ უოკერი'] },
      });
      const thin = issues.find((issue) => issue.code === 'thin-aliases');
      expect(thin?.severity).toBe('review');
      expect(codes(blockingIssues(issues))).not.toContain('thin-aliases');
    });
  });

  describe('countdown', () => {
    it('blocks a group whose display value is not accepted', () => {
      const issues = validateQuestionContent({
        type: 'countdown_list',
        prompt: prompt('Name every scorer.'),
        payload: {
          type: 'countdown_list',
          prompt: prompt('Name every scorer.'),
          answer_groups: [
            {
              id: 'g1',
              display: { en: 'Kyle Walker', ka: 'კაილ უოკერი' },
              accepted_answers: ['Walker'],
            },
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('display-answer-not-accepted');
    });
  });

  describe('high_low and options', () => {
    it('blocks tied matchup values', () => {
      const issues = validateQuestionContent({
        type: 'high_low',
        prompt: prompt('Who has more titles?'),
        payload: {
          type: 'high_low',
          stat_label: prompt('Titles'),
          matchups: [
            {
              id: 'm1',
              left_name: { en: 'Milan', ka: 'მილანი' },
              left_value: 7,
              right_name: { en: 'Inter', ka: 'ინტერი' },
              right_value: 7,
            },
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('tied-matchup');
    });

    it('blocks duplicate option texts', () => {
      const issues = validateQuestionContent({
        type: 'mcq_single',
        prompt: prompt('Who scored?'),
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'A', text: { en: 'Pelé', ka: 'პელე' }, is_correct: true },
            { id: 'B', text: { en: 'Pele', ka: 'პელე' }, is_correct: false },
          ],
        },
      });
      expect(codes(blockingIssues(issues))).toContain('duplicate-options');
    });
  });

  describe('review signals', () => {
    it('flags colour prompts for review without blocking', () => {
      const issues = validateQuestionContent({
        type: 'mcq_single',
        prompt: prompt('What colour shirts did Italy wear in 1938?'),
        payload: {
          type: 'mcq_single',
          options: [
            { id: 'A', text: { en: 'Blue', ka: 'ლურჯი' }, is_correct: false },
            { id: 'B', text: { en: 'Black', ka: 'შავი' }, is_correct: true },
          ],
        },
      });
      const flag = issues.find((issue) => issue.code === 'observable-answer-prompt');
      expect(flag?.severity).toBe('review');
      expect(blockingIssues(issues)).toEqual([]);
    });
  });
});
