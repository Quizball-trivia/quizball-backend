import { config } from '../../core/config.js';
import { triviaMinesRepo } from './trivia-mines.repo.js';
import { triviaMinesService } from './trivia-mines.service.js';
import { deriveDailySessions, mulberry32 } from '../synthetic-bots/activity-model.js';
import { createMiniGameBotWorker, type MiniGameBotProfile } from '../synthetic-bots/mini-game-bots.js';
import { BOARD_SIZE, TRIVIA_MINES_POT_CAP } from './trivia-mines.constants.js';

/**
 * Roster bots playing Trivia Mines FOR REAL through the same service as humans
 * (real stakes, wallet, ledger, fairness events), so "playing now" and the wins
 * ticker read genuine rounds. Arrivals follow the shared activity model
 * (measured hour curve × daily jitter × Poisson); behaviour comes from each
 * bot's profile: stake appetite, how many tiles it dares, how often it scouts,
 * and answer accuracy from base_skill.
 */
const SESSION_HARD_CAP_MS = 4 * 60_000;
const TOPUP_THRESHOLD = 400;
const TOPUP_AMOUNT = 3_000;
const MODE_SHARE = 0.12;
const SESSIONS_PER_PLAYER = 2.5;

type BotProfile = MiniGameBotProfile;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dailySessions(): number {
  return config.TRIVIA_MINES_BOTS_DAILY_SESSIONS > 0
    ? config.TRIVIA_MINES_BOTS_DAILY_SESSIONS
    : deriveDailySessions(config.SYNTHETIC_ACTIVITY_DAU, MODE_SHARE, SESSIONS_PER_PLAYER);
}

export async function runBotSession(bot: BotProfile): Promise<void> {
  const rng = mulberry32((Number(bot.personality_seed) % 0xffffffff) ^ Date.now());
  const jitter = (rng() - 0.5) * (1 - Math.min(1, Math.max(0, bot.consistency))) * 0.16;
  const accuracy = Math.min(0.93, Math.max(0.45, 0.68 + bot.base_skill * 0.09 + jitter));
  const stakeRoll = rng();
  const stake = stakeRoll < 0.45 ? 50 : stakeRoll < 0.75 ? 100 : stakeRoll < 0.9 ? 250 : 5 + Math.floor(rng() * 40);
  const targetPicks = 2 + Math.floor(rng() * 6); // 2..7 safe tiles before banking
  const scoutAppetite = rng(); // how eagerly the bot spends scouts
  const deadline = Date.now() + SESSION_HARD_CAP_MS;

  if (bot.coins < TOPUP_THRESHOLD + stake) await triviaMinesRepo.topUpBotWallet(bot.user_id, TOPUP_AMOUNT);

  let state = await triviaMinesService.startRound(bot.user_id, stake, `bot-${Math.floor(rng() * 1e9)}`);
  while (!worker.stopping && Date.now() < deadline && state.status === 'active') {
    await sleep(900 + rng() * 2600);

    if (state.phase === 'picking') {
      const picks = state.opened.length;
      if (picks >= targetPicks || (picks > 0 && state.pot_coins >= TRIVIA_MINES_POT_CAP / 4)) {
        state = await triviaMinesService.cashout(bot.user_id, state.state_version);
        continue;
      }
      // Scout early in the run when the profile likes it; never when everything is flagged.
      if (state.scouts_left > 0 && state.flagged.length < state.defender_count && rng() < scoutAppetite * 0.6) {
        state = await triviaMinesService.dealQuestion(bot.user_id, state.state_version);
        continue;
      }
      const candidates = Array.from({ length: BOARD_SIZE }, (_, i) => i).filter((t) => !state.opened.includes(t) && !state.flagged.includes(t));
      const tile = candidates[Math.floor(rng() * candidates.length)];
      const result = await triviaMinesService.pick(bot.user_id, { tile, expectedVersion: state.state_version });
      state = result.state;
      continue;
    }

    if (state.phase === 'question' && state.question) {
      const thinkMs = rng() < 0.05 ? 13_000 : 1_500 + rng() * 5_000;
      await sleep(thinkMs);
      const row = await triviaMinesRepo.getActiveRound(bot.user_id);
      if (!row || row.question_id !== state.question.question_id) {
        state = await triviaMinesService.getCurrentState(bot.user_id).catch(() => state);
        continue;
      }
      const correctId = row.question_correct_option;
      const options = state.question.options.map((o) => o.id);
      const wrong = options.filter((id) => id !== correctId);
      const optionId = rng() < accuracy ? correctId! : wrong[Math.floor(rng() * wrong.length)];
      try {
        const result = await triviaMinesService.answerQuestion(bot.user_id, { questionId: state.question.question_id, optionId, expectedVersion: row.state_version });
        state = result.state;
      } catch {
        state = await triviaMinesService.getCurrentState(bot.user_id);
      }
      continue;
    }
    break;
  }
}

const worker = createMiniGameBotWorker<BotProfile>({
  name: 'trivia-mines',
  botsEnabled: () => config.TRIVIA_MINES_BOTS_ENABLED,
  modeEnabled: () => config.TRIVIA_MINES_ENABLED,
  dailySessions,
  pickIdleBots: (limit) => triviaMinesRepo.pickIdleBots(limit),
  runSession: runBotSession,
});

export const startTriviaMinesBots = (): void => worker.start();
export const stopTriviaMinesBots = (): void => worker.stop();
