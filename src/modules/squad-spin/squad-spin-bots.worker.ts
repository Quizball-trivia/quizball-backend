import { config } from '../../core/config.js';
import { squadSpinRepo } from './squad-spin.repo.js';
import { squadSpinService } from './squad-spin.service.js';
import { deriveDailySessions, mulberry32 } from '../synthetic-bots/activity-model.js';
import { createMiniGameBotWorker, type MiniGameBotProfile } from '../synthetic-bots/mini-game-bots.js';
import { SQUAD_SPIN_POT_CAP, TIER_PRIOR_ACCURACY_BP } from './squad-spin.constants.js';

/**
 * Roster bots playing Squad Spin FOR REAL through the same service as humans
 * (real stakes, wallet, ledger, fairness events). A bot "knows" the answer with
 * the tier's prior accuracy nudged by its skill; calibration ignores bots anyway
 * (users.is_ai), so their play never moves the multipliers.
 */
const SESSION_HARD_CAP_MS = 4 * 60_000;
const TOPUP_THRESHOLD = 400;
const TOPUP_AMOUNT = 3_000;
const MODE_SHARE = 0.1;
const SESSIONS_PER_PLAYER = 2.5;
const WRONG_GUESSES = ['Rooney', 'Del Piero', 'Zidane', 'Kaka', 'Robben', 'Buffon', 'Puyol', 'Nedved'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dailySessions(): number {
  return config.SQUAD_SPIN_BOTS_DAILY_SESSIONS > 0
    ? config.SQUAD_SPIN_BOTS_DAILY_SESSIONS
    : deriveDailySessions(config.SYNTHETIC_ACTIVITY_DAU, MODE_SHARE, SESSIONS_PER_PLAYER);
}

export async function runBotSession(bot: MiniGameBotProfile): Promise<void> {
  const rng = mulberry32((Number(bot.personality_seed) % 0xffffffff) ^ Date.now());
  const skill = Math.max(-0.15, Math.min(0.15, bot.base_skill * 0.05 + (rng() - 0.5) * 0.06));
  const stakeRoll = rng();
  const stake = stakeRoll < 0.45 ? 50 : stakeRoll < 0.75 ? 100 : stakeRoll < 0.9 ? 250 : 5 + Math.floor(rng() * 40);
  const reelsRoll = rng();
  const reels = reelsRoll < 0.65 ? 3 : reelsRoll < 0.9 ? 4 : 5;
  const targetSpins = 1 + Math.floor(rng() * 4);
  const deadline = Date.now() + SESSION_HARD_CAP_MS;

  if (bot.coins < TOPUP_THRESHOLD + stake) await squadSpinRepo.topUpBotWallet(bot.user_id, TOPUP_AMOUNT);

  let state = await squadSpinService.startRound(bot.user_id, { stakeCoins: stake, reels, clientNonce: `bot-${Math.floor(rng() * 1e9)}` });
  while (!worker.stopping && Date.now() < deadline && state.status === 'active') {
    if (state.phase === 'question' && state.spin) {
      await sleep(2_500 + rng() * 8_000);
      const accuracy = TIER_PRIOR_ACCURACY_BP[state.spin.tier] / 10_000 + skill;
      let text = WRONG_GUESSES[Math.floor(rng() * WRONG_GUESSES.length)];
      if (rng() < accuracy) {
        const row = await squadSpinRepo.getActiveRound(bot.user_id);
        const combo = row?.combo_id ? await squadSpinRepo.getComboById(row.combo_id) : null;
        const answers = combo ? await squadSpinRepo.getPlayersByIds(combo.answer_ids) : [];
        if (answers.length) text = answers[Math.floor(rng() * answers.length)].name_en;
      }
      try {
        state = (await squadSpinService.answer(bot.user_id, { roundId: state.round_id, text, expectedVersion: state.state_version })).state;
      } catch {
        state = await squadSpinService.getCurrentState(bot.user_id).catch(() => state);
      }
      continue;
    }
    if (state.phase === 'decision') {
      await sleep(1_200 + rng() * 3_000);
      const bank = state.spins_cleared >= targetSpins || state.pot_coins >= SQUAD_SPIN_POT_CAP / 4;
      try {
        state = bank
          ? await squadSpinService.cashout(bot.user_id, { roundId: state.round_id, expectedVersion: state.state_version })
          : await squadSpinService.continueRound(bot.user_id, { roundId: state.round_id, expectedVersion: state.state_version });
      } catch {
        state = await squadSpinService.getCurrentState(bot.user_id).catch(() => state);
      }
      continue;
    }
    break;
  }
}

const worker = createMiniGameBotWorker<MiniGameBotProfile>({
  name: 'squad-spin',
  botsEnabled: () => config.SQUAD_SPIN_BOTS_ENABLED,
  modeEnabled: () => config.SQUAD_SPIN_ENABLED,
  dailySessions,
  pickIdleBots: (limit) => squadSpinRepo.pickIdleBots(limit),
  runSession: runBotSession,
});

export const startSquadSpinBots = (): void => worker.start();
export const stopSquadSpinBots = (): void => worker.stop();
