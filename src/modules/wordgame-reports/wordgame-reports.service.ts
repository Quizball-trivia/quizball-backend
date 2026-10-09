import { logger } from '../../core/logger.js';
import { normalizeName } from '../footballers/footballers.text.js';
import type { Refusal } from './wordgame-reports.rules.js';
import { wordgameReportsRepo, type WordgameReport } from './wordgame-reports.repo.js';

/** Reports one player may file in a day, across both games. */
export const REPORT_DAILY_BUDGET = 20;
export const REPORT_RETENTION_DAYS = 90;
export const REPORT_MAX_LENGTH = 60;

const cleaned = (text: string): string => text.trim().replace(/\s+/g, ' ').slice(0, REPORT_MAX_LENGTH);

export const wordgameReportsService = {
  /** Never throws: a report is a favour from the player, and losing one must not disturb a game. */
  async file(report: Omit<WordgameReport, 'typed' | 'norm' | 'releaseId' | 'subject' | 'resolvedPid'>, refusal: Refusal, text: string): Promise<void> {
    const typed = cleaned(text);
    const norm = normalizeName(typed).slice(0, REPORT_MAX_LENGTH);
    if (!typed || !norm) return;
    try {
      await wordgameReportsRepo.file({ ...report, typed, norm, releaseId: refusal.release, subject: refusal.subject, resolvedPid: refusal.resolvedPid }, REPORT_DAILY_BUDGET);
    } catch (error) {
      logger.warn({ err: error, game: report.game, source: report.source }, 'Word game report not stored');
    }
  },

  purge: (): Promise<number> => wordgameReportsRepo.purge(REPORT_RETENTION_DAYS, 5_000),
};
