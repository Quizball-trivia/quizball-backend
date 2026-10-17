import { sql } from '../../db/index.js';
import type { DailyPlayer } from '../daily/daily.repo.js';
import type { GameFeedbackBody } from './game-feedback.schemas.js';

export const gameFeedbackRepo = {
  /** One answer per player per game: sending again replaces it. */
  async save(game: string, player: DailyPlayer, body: GameFeedbackBody): Promise<void> {
    const userId = player.kind === 'member' ? player.userId : null;
    const guestId = player.kind === 'guest' ? player.guestId : null;
    const values = sql`${game}, ${body.mode}, ${userId}, ${guestId}, ${body.rating}, ${body.wantsOnline}, ${body.comment ?? null}, ${body.locale}`;
    const update = sql`DO UPDATE SET mode = EXCLUDED.mode, rating = EXCLUDED.rating, wants_online = EXCLUDED.wants_online,
      comment = EXCLUDED.comment, locale = EXCLUDED.locale, updated_at = now()`;
    if (userId !== null) {
      await sql`
        INSERT INTO game_feedback (game, mode, user_id, guest_id, rating, wants_online, comment, locale) VALUES (${values})
        ON CONFLICT (game, user_id) WHERE user_id IS NOT NULL ${update}
      `;
    } else {
      await sql`
        INSERT INTO game_feedback (game, mode, user_id, guest_id, rating, wants_online, comment, locale) VALUES (${values})
        ON CONFLICT (game, guest_id) WHERE guest_id IS NOT NULL ${update}
      `;
    }
  },
};
