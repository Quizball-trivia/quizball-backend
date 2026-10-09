import { sql } from '../../db/index.js';

export interface WordgameReport {
  game: 'shared_player' | 'name_chain';
  source: 'daily' | 'room';
  /** The daily run or the room match the reporter played. */
  contextId: string;
  round: number;
  releaseId: string;
  subject: string | null;
  typed: string;
  norm: string;
  resolvedPid: string | null;
  reporter: { userId: string } | { guestId: string };
}

export const wordgameReportsRepo = {
  /**
   * Stores a report unless the reporter already made it or has used the day's budget; one statement either way.
   * True when a row was written.
   */
  async file(report: WordgameReport, dailyBudget: number): Promise<boolean> {
    const userId = 'userId' in report.reporter ? report.reporter.userId : null;
    const guestId = 'guestId' in report.reporter ? report.reporter.guestId : null;
    const rows = await sql`
      INSERT INTO wordgame_reports (game, source, context_id, round, release_id, subject, typed, norm, resolved_pid, user_id, guest_id)
      SELECT ${report.game}, ${report.source}, ${report.contextId}, ${report.round}, ${report.releaseId}, ${report.subject}, ${report.typed},
             ${report.norm}, ${report.resolvedPid}, ${userId}, ${guestId}
      WHERE (
        SELECT count(*) FROM wordgame_reports r
        WHERE ${userId === null ? sql`r.guest_id = ${guestId}` : sql`r.user_id = ${userId}`}
          AND r.created_at > statement_timestamp() - interval '1 day'
      ) < ${dailyBudget}
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  },

  /** Retention: reports older than `days`, a batch at a time. */
  async purge(days: number, batch: number): Promise<number> {
    const gone = await sql`
      DELETE FROM wordgame_reports WHERE id IN (
        SELECT id FROM wordgame_reports WHERE created_at < statement_timestamp() - make_interval(days => ${days}) ORDER BY created_at LIMIT ${batch}
      )
    `;
    return gone.count;
  },
};
