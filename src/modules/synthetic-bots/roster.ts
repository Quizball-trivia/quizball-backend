import { sql } from '../../db/index.js';
import { storeRepo } from '../store/store.repo.js';
import type { MiniGameBotProfile } from './mini-game-bots.js';

/**
 * Roster access shared by every mini-game bot worker.
 *
 * Only bots created by the persistent-roster script may play: those carry
 * `schedule.batch` (e.g. roster-staging-20260728). Harness fixtures from chaos
 * and regression runs share the profile table but have no batch and machine
 * names like `eq_res_17_1785306809356`; they must never reach a public
 * "recent wins" ticker. The name check is a second guard for hand-made rows.
 */
const HARNESS_NAME = String.raw`(\d{6,}|^(eq_|order-|edit-|chaos|load|test|bot_|synthetic))`;

/**
 * Each roster bot has a favourite mini game (personality_seed mod 4), so the
 * four boards are not topped by the same handful of names: a game draws from
 * its own fans first and only tops up from the rest when they are all busy.
 */
export const MINI_GAME_INDEX = { 'free-kicks': 0, 'road-to-goal': 1, 'trivia-mines': 2, 'squad-spin': 3 } as const;
export type MiniGameName = keyof typeof MINI_GAME_INDEX;

/** Idle roster bots for `activeRoundsTable`: active profile, not frozen, not reserved for a match, no active round in that game. */
export async function pickIdleRosterBots(activeRoundsTable: string, limit: number, game?: MiniGameName): Promise<MiniGameBotProfile[]> {
  const fans = game === undefined ? [] : await pickIdle(activeRoundsTable, limit, MINI_GAME_INDEX[game]);
  if (fans.length >= limit) return fans;
  const others = await pickIdle(activeRoundsTable, limit - fans.length, null);
  const seen = new Set(fans.map((b) => b.user_id));
  return [...fans, ...others.filter((b) => !seen.has(b.user_id))];
}

async function pickIdle(activeRoundsTable: string, limit: number, gameIndex: number | null): Promise<MiniGameBotProfile[]> {
  return sql<MiniGameBotProfile[]>`
    SELECT p.user_id, p.base_skill, p.consistency, p.personality_seed, p.schedule, u.coins
    FROM synthetic_player_profiles p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN synthetic_bot_reservations res ON res.bot_user_id = p.user_id
    LEFT JOIN ${sql(activeRoundsTable)} r ON r.user_id = p.user_id AND r.status = 'active'
    WHERE p.status = 'active' AND NOT p.selection_frozen
      AND p.schedule->>'batch' IS NOT NULL
      AND u.is_ai = true AND u.is_banned = false AND u.is_deleted = false
      AND u.nickname !~ ${HARNESS_NAME}
      AND res.bot_user_id IS NULL AND r.id IS NULL
      AND (${gameIndex}::int IS NULL OR (p.personality_seed::bigint % 4) = ${gameIndex}::int)
    ORDER BY random()
    LIMIT ${limit}
  `;
}

/** House-side top-up through the wallet primitive with an audited ledger row. */
export async function topUpRosterBotWallet(userId: string, amount: number, reason: string): Promise<void> {
  await sql.begin(async (tx) => {
    const wallet = await storeRepo.adjustWalletInTx(tx, userId, amount, 0);
    if (!wallet) throw new Error('Bot wallet top-up failed');
    await storeRepo.insertTransactionLogInTx(tx, { eventType: 'manual_adjustment_succeeded', outcome: 'success', userId, coinsDelta: amount, reason });
  });
}
