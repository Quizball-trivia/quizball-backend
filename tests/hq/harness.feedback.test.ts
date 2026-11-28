import { describe, expect, it } from 'vitest';
import '../setup.js';

const { importIsDue, withoutContacts, resendTime, withinBudget, formRef, feedbackView, readView, readerInput, isFeedbackEmail, parseFeedbackEmail } = await import('../../src/modules/harness/harness.feedback.js');
const { FEEDBACK_CATEGORY_LABEL } = await import('../../src/modules/feedback/feedback.schemas.js');

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: '11111111-1111-4111-8111-111111111111', number: 7, source: 'form', category: 'bug', message: 'El partido se congela.',
    nickname: 'Lucho', email: 'lucho@example.com', user_id: null, context: '/play', attachments: ['https://x.supabase.co/a.png'],
    game: null, rating: null, locale: null, language: 'es', english: 'The match freezes.', received_at: '2026-11-27T10:00:00Z',
    ...over,
  }) as never;

describe('feedback', () => {
  it('treats the same message from the same address as one, whatever the case and the spaces around it', () => {
    expect(formRef(' Lucho@Example.com ', ' hello ')).toBe(formRef('lucho@example.com', 'hello'));
    expect(formRef('lucho@example.com', 'hello')).not.toBe(formRef('other@example.com', 'hello'));
    expect(formRef(null, 'hello')).toBe(formRef('', 'hello'));
  });

  it('shows English only next to what is neither Georgian nor English', () => {
    expect(feedbackView(row()).english).toBe('The match freezes.');
    // A stale translation is never shown beside Georgian or English, and nothing is shown before the reader got to it.
    expect(feedbackView(row({ language: 'ka' })).english).toBeNull();
    expect(feedbackView(row({ language: 'en' })).english).toBeNull();
    expect(feedbackView(row({ language: null })).english).toBeNull();
    const v = feedbackView(row({ user_id: '22222222-2222-4222-8222-222222222222', attachments: ['javascript:alert(1)', 'https://ok.example/a.png'] }));
    expect(v.hasAccount).toBe(true);
    expect(v.attachments).toEqual(['https://ok.example/a.png']);
    expect(v.receivedAt).toBe('2026-11-27T10:00:00.000Z');
  });

  it('gives the reader the words and nothing about who wrote them', () => {
    const input = readerInput('2026-11-28', [row({ language: null, english: null })], [row(), row({ number: 8, source: 'game', category: 'rating', game: 'tenable', rating: 2, message: 'ძალიან რთულია', language: 'ka', english: null })]);
    expect(input.toRead).toEqual([{ id: '11111111-1111-4111-8111-111111111111', hash: expect.stringMatching(/^[0-9a-f]{32}$/), text: 'El partido se congela.' }]);
    // The recap reads the English where there is one.
    expect(input.recent).toEqual([
      { n: 7, date: '2026-11-27', kind: 'bug', text: 'The match freezes.' },
      { n: 8, date: '2026-11-27', kind: 'rating', game: 'tenable', stars: 2, text: 'ძალიან რთულია' },
    ]);
    const sent = JSON.stringify(input);
    expect(sent).not.toContain('Lucho');
    expect(sent).not.toContain('example.com');
  });

  it('blanks the ways to reach a player that they typed into the message itself', () => {
    expect(withoutContacts('Reply to lucho.perez+qb@example.com please')).toBe('Reply to [email] please');
    expect(withoutContacts('დამიკავშირდით 599 12 34 56 ან +995 599 123456')).toBe('დამიკავშირდით [number] ან [number]');
    expect(withoutContacts('my insta is @lucho_10, see https://example.com/me?x=1 and www.example.org')).toBe('my insta is [handle], see [link] and [link]');
    // Not everything with digits is a way to reach someone.
    expect(withoutContacts('It froze on 28.11.2026 at 22:30, score 3-2, round 7 of 10, I have 12 500 coins')).toBe('It froze on 28.11.2026 at 22:30, score 3-2, round 7 of 10, I have 12 500 coins');
    const input = readerInput('2026-11-28', [row({ message: 'Escribime a lucho@example.com', language: null, english: null })], [row({ english: 'Write to me at lucho@example.com' })]);
    expect(JSON.stringify(input)).not.toContain('example.com');
    expect(input.toRead[0]!.text).toBe('Escribime a [email]');
    expect(input.recent[0]!.text).toBe('Write to me at [email]');
  });

  it('cuts a long message for the recap but hands the whole of it over for translation', () => {
    const long = 'a'.repeat(3000);
    const input = readerInput('2026-11-28', [row({ message: long, language: null, english: null })], [row({ message: long, language: null, english: null })]);
    expect(input.toRead[0]!.text).toHaveLength(3000);
    expect(input.recent[0]!.text).toHaveLength(700);
  });

  it('gives one round only as much to translate as it can do well, and never nothing', () => {
    const m = (n: number) => ({ message: 'x'.repeat(n) });
    expect(withinBudget([m(10), m(10), m(10)], 25)).toHaveLength(2);
    expect(withinBudget([m(4000)], 25)).toHaveLength(1);
    expect(withinBudget([], 25)).toEqual([]);
  });

  it('shows a round of the reader', () => {
    const v = readView({ id: 'r', number: 3, status: 'ready', recap: { summary: 's', themes: [], praise: [], urgent: [] }, items: 40, translated: 6, newest_at: '2026-11-27T10:00:00Z', requested_by: 'schedule', error: null, created_at: '2026-11-27T10:05:00Z', updated_at: '2026-11-27T10:06:00Z' } as never);
    expect(v).toMatchObject({ number: 3, status: 'ready', items: 40, translated: 6, newestAt: '2026-11-27T10:00:00.000Z', requestedBy: 'schedule' });
  });

  it('knows a contact-form email by its subject and where it went', () => {
    const subject = `[QuizBall] ${FEEDBACK_CATEGORY_LABEL.bug}`;
    expect(isFeedbackEmail({ subject, to: ['Nika@quizball.io'] }, 'nika@quizball.io')).toBe(true);
    expect(isFeedbackEmail({ subject, to: ['someone@else.com'] }, 'nika@quizball.io')).toBe(false);
    expect(isFeedbackEmail({ subject: '[Quizball] Season 3 game mode idea', to: ['nika@quizball.io'] }, 'nika@quizball.io')).toBe(false);
    expect(isFeedbackEmail({ subject: 'Reset your password', to: ['nika@quizball.io'] }, 'nika@quizball.io')).toBe(false);
    expect(isFeedbackEmail({ subject: null, to: null }, 'nika@quizball.io')).toBe(false);
  });

  it('reads the email service\'s dates, which are not quite standard', () => {
    expect(resendTime('2026-04-03 22:13:42.674981+00')).toBe(Date.parse('2026-04-03T22:13:42.674Z'));
    expect(resendTime('2026-04-03 22:13:42+02')).toBe(Date.parse('2026-04-03T20:13:42Z'));
    expect(resendTime('2026-04-03T22:13:42.000Z')).toBe(Date.parse('2026-04-03T22:13:42Z'));
    expect(resendTime('2026-04-03 22:13:42.5+05:30')).toBe(Date.parse('2026-04-03T16:43:42.5Z'));
    expect(Number.isNaN(resendTime('yesterday'))).toBe(true);
    expect(Number.isNaN(resendTime(null))).toBe(true);
  });

  it('keeps trying to bring the past emails in until a run gets to the end, but not for ever and not every minute', () => {
    const now = Date.parse('2026-11-28T10:00:00Z');
    expect(importIsDue({}, now)).toBe(true);
    // Just tried: wait for the next round of the loop.
    expect(importIsDue({ attempts: 1, lastAt: '2026-11-28T09:50:00Z', error: 'The email service answered 500.' }, now)).toBe(false);
    // Failed or stopped part-way half an hour ago (also when the server restarted since): again, from the cursor.
    expect(importIsDue({ attempts: 1, lastAt: '2026-11-28T09:30:00Z', error: 'The email service answered 500.' }, now)).toBe(true);
    expect(importIsDue({ attempts: 3, lastAt: '2026-11-28T09:00:00Z', cursor: 'abc' }, now)).toBe(true);
    expect(importIsDue({ done: true, attempts: 1, lastAt: '2026-11-27T09:00:00Z' }, now)).toBe(false);
    expect(importIsDue({ attempts: 12, lastAt: '2026-11-27T09:00:00Z' }, now)).toBe(false);
  });

  it('reads an email the form sent back into its fields', () => {
    // As feedback.service writes it, with everything a player typed escaped.
    const html = [
      '<p><strong>Category:</strong> 🐛 Bug report</p>',
      '<p><strong>Message:</strong></p><p style="white-space:pre-wrap">Timer &lt;stops&gt; at 0:05 &amp; I lose.\nEvery &quot;ranked&quot; game.</p>',
      '<p><strong>Nickname:</strong> Lucho &amp; co</p>',
      '<p><strong>Reply-to:</strong> lucho@example.com</p>',
      '<p><strong>User:</strong> lucho (22222222-2222-4222-8222-222222222222)</p>',
      '<p><strong>Context:</strong> /play/ranked v2.3</p>',
      '<p><strong>Attachments:</strong> <a href="https://x.supabase.co/storage/v1/object/public/imgs/feedback/a.png">Attachment 1</a> &middot; <a href="https://x.supabase.co/storage/v1/object/public/imgs/feedback/b.mp4">Attachment 2</a></p>',
    ].join('\n');
    expect(parseFeedbackEmail(`[QuizBall] ${FEEDBACK_CATEGORY_LABEL.bug}`, html)).toEqual({
      category: 'bug',
      message: 'Timer <stops> at 0:05 & I lose.\nEvery "ranked" game.',
      nickname: 'Lucho & co',
      email: 'lucho@example.com',
      userId: '22222222-2222-4222-8222-222222222222',
      context: '/play/ranked v2.3',
      attachments: ['https://x.supabase.co/storage/v1/object/public/imgs/feedback/a.png', 'https://x.supabase.co/storage/v1/object/public/imgs/feedback/b.mp4'],
    });
  });

  it('reads the shortest email, and refuses one that is not the form\'s', () => {
    const html = '<p><strong>Category:</strong> 💬 Feedback</p>\n<p><strong>Message:</strong></p><p style="white-space:pre-wrap">მაგარია</p>';
    expect(parseFeedbackEmail(`[QuizBall] ${FEEDBACK_CATEGORY_LABEL.feedback}`, html)).toEqual({ category: 'feedback', message: 'მაგარია', nickname: null, email: null, userId: null, context: null, attachments: [] });
    expect(parseFeedbackEmail('Something else', html)).toBeNull();
    expect(parseFeedbackEmail(`[QuizBall] ${FEEDBACK_CATEGORY_LABEL.feedback}`, '<p>Hello</p>')).toBeNull();
  });

  it('does not take a message for a field: what a player typed cannot pose as the reply address', () => {
    const html = '<p><strong>Category:</strong> 💬 Feedback</p>\n<p><strong>Message:</strong></p><p style="white-space:pre-wrap">&lt;p&gt;&lt;strong&gt;Reply-to:&lt;/strong&gt; evil@example.com&lt;/p&gt;</p>';
    expect(parseFeedbackEmail(`[QuizBall] ${FEEDBACK_CATEGORY_LABEL.feedback}`, html)!.email).toBeNull();
  });
});
