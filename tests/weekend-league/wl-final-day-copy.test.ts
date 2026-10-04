import { describe, expect, it } from 'vitest';
import { finalReminder30mContent, qualifiedContent } from '../../src/modules/weekend-league/wl-notifications.js';

const TEN_MIN = 10 * 60_000;
// Sunday 2026-10-11 22:00 Georgia time (UTC+4).
const FINAL_22_GE = Date.parse('2026-10-11T18:00:00Z');

describe('Weekend League final-day copy', () => {
  it('carries the final start and the second check-in window from the tournament row', () => {
    const copy = qualifiedContent(FINAL_22_GE, TEN_MIN);

    expect(copy.titleEn).toBe('You made the final! Check in again Sunday 21:50–22:00 Georgia time');
    expect(copy.bodyEn).toContain('starts Sunday at 22:00 Georgia time (GMT+4)');
    expect(copy.bodyEn).toContain('between 21:50 and 22:00');
    expect(copy.titleKa).toBe('ფინალში გახვედი! ჩექინი კვირას 21:50–22:00');
    expect(copy.bodyKa).toContain('22:00-ზეა');
    expect(copy.bodyKa).toContain('21:50-დან 22:00-მდე');
  });

  it('follows a moved final and a different check-in window, never a fixed hour', () => {
    const copy = qualifiedContent(Date.parse('2026-10-11T10:00:00Z'), 30 * 60_000);

    expect(copy.titleEn).toContain('13:30–14:00');
    expect(copy.bodyKa).toContain('13:30-დან 14:00-მდე');
    expect(JSON.stringify(copy)).not.toContain('22:00');
  });

  it('names the Georgia weekday of the final, not a fixed Sunday', () => {
    // 2026-10-11T20:05Z is Monday 00:05 Georgia time; check-in opens Sunday 23:55.
    const overMidnight = qualifiedContent(Date.parse('2026-10-11T20:05:00Z'), TEN_MIN);
    expect(overMidnight.titleEn).toBe('You made the final! Check in again Sunday 23:55 – Monday 00:05 Georgia time');
    expect(overMidnight.bodyEn).toContain('starts Monday at 00:05 Georgia time');
    expect(overMidnight.titleKa).toBe('ფინალში გახვედი! ჩექინი კვირას 23:55 – ორშაბათს 00:05');

    // A midweek rehearsal final (Wednesday 2026-10-07 19:00 Georgia time).
    const rehearsal = qualifiedContent(Date.parse('2026-10-07T15:00:00Z'), TEN_MIN);
    expect(rehearsal.bodyEn).toContain('starts Wednesday at 19:00');
    expect(rehearsal.bodyKa).toContain('ფინალი ოთხშაბათს 19:00-ზეა');
    expect(JSON.stringify(rehearsal)).not.toMatch(/Sunday|კვირას/);
  });

  it('a compressed rehearsal off whole minutes prints seconds instead of an empty window', () => {
    const copy = qualifiedContent(Date.parse('2026-10-11T18:00:30Z'), 10_000);
    expect(copy.titleEn).toContain('22:00:20–22:00:30');
    expect(finalReminder30mContent(Date.parse('2026-10-11T18:00:30Z'), 10_000).bodyEn).toContain('opens at 22:00:20');
  });

  it('states no day or time at all when the row has no final start', () => {
    const copy = qualifiedContent(Number.NaN, TEN_MIN);

    expect(JSON.stringify(copy)).not.toMatch(/\d{2}:\d{2}|Sunday|კვირას/);
    expect(copy.bodyEn).toContain('check in AGAIN');
  });

  it('the 30-minute reminder gives the absolute start and check-in opening, without "today"', () => {
    const copy = finalReminder30mContent(FINAL_22_GE, TEN_MIN);

    expect(copy.titleEn).toBe('The final starts at 22:00 Georgia time!');
    expect(copy.bodyEn).toContain('Check-in opens at 21:50 Georgia time');
    expect(copy.titleKa).toBe('ფინალი 22:00-ზე იწყება!');
    expect(copy.bodyKa).toContain('21:50-ზე');
    expect(JSON.stringify(copy)).not.toMatch(/today|დღეს/);
  });
});

describe('Weekend League notifications in every app language', () => {
  it('the finalist notices name the day and window in Spanish and Turkish too', () => {
    const copy = qualifiedContent(FINAL_22_GE, TEN_MIN);
    expect(copy.titleEs).toBe('¡Estás en la final! Confirma tu asistencia de nuevo el domingo 21:50–22:00, hora de Georgia');
    expect(copy.bodyEs).toContain('La final empieza el domingo a las 22:00, hora de Georgia (GMT+4)');
    expect(copy.bodyEs).toContain('entre las 21:50 y las 22:00');
    expect(copy.titleTr).toBe('Finaldesin! Gürcistan saatiyle Pazar 21:50–22:00 arasında yeniden giriş yap');
    expect(copy.bodyTr).toContain('Final Pazar günü Gürcistan saatiyle 22:00 itibarıyla başlıyor');

    const overMidnight = qualifiedContent(Date.parse('2026-10-11T20:05:00Z'), TEN_MIN);
    expect(overMidnight.titleEs).toContain('el domingo 23:55 – el lunes 00:05');
    expect(overMidnight.titleTr).toContain('Pazar 23:55 – Pazartesi 00:05');

    const reminder = finalReminder30mContent(FINAL_22_GE, TEN_MIN);
    expect(reminder.titleEs).toBe('¡La final empieza a las 22:00, hora de Georgia!');
    expect(reminder.bodyTr).toContain('Gürcistan saatiyle 21:50 itibarıyla açılıyor');
  });

  it('every wave stores all four languages, so Spanish and Turkish players never fall back to English', async () => {
    const waves = await import('../../src/modules/weekend-league/wl-notifications.js');
    const contents = [
      waves.ENTRY_OPEN_CONTENT, waves.REMINDER_1H_CONTENT, waves.REMINDER_30M_CONTENT, waves.CHECKIN_OPEN_CONTENT,
      waves.FINAL_CHECKIN_CONTENT, qualifiedContent(FINAL_22_GE, TEN_MIN), qualifiedContent(Number.NaN, TEN_MIN),
      finalReminder30mContent(FINAL_22_GE, TEN_MIN),
    ];
    for (const content of contents) {
      const { title, body } = waves.wlLocalized(content);
      for (const field of [title, body]) {
        expect(Object.keys(field).sort()).toEqual(['en', 'es', 'ka', 'tr']);
        for (const text of Object.values(field)) expect(text.trim().length).toBeGreaterThan(5);
        expect(field.es).not.toBe(field.en);
        expect(field.tr).not.toBe(field.en);
      }
    }
  });
});
