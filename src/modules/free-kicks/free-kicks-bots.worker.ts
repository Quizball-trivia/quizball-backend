import { config } from '../../core/config.js';
import { freeKicksRepo } from './free-kicks.repo.js';
import { freeKicksService } from './free-kicks.service.js';
import { deriveDailySessions, mulberry32 } from '../synthetic-bots/activity-model.js';
import { createMiniGameBotWorker, type MiniGameBotProfile } from '../synthetic-bots/mini-game-bots.js';
import { FREE_KICKS_POT_CAP, MAX_OPEN, openZones } from './free-kicks.constants.js';

/**
 * Roster bots playing Free Kicks FOR REAL — through the exact same service
 * layer as humans: real stakes, real wallet movements, real ledger rows, real
 * fairness events. The social layer (playing-now count, recent wins, top runs)
 * therefore needs zero fabrication: it reads genuine rounds.
 *
 * Behavior is derived from each bot's calibrated profile:
 *   - answer accuracy from base_skill (+ per-session jitter, consistency)
 *   - stake size, target open-zones, and ride-vs-cash greed from the
 *     personality seed, so a given bot plays a recognizable style
 *   - human pacing: 1–5s thinking pauses, occasional question timeouts
 *   - arrivals follow the shared activity model (measured hour curve, daily
 *     jitter, Poisson), see synthetic-bots/activity-model.ts
 *
 * The worker peeks the round row for the correct option (server-side code may;
 * clients cannot) purely to IMPLEMENT the skill roll — the outcome still flows
 * through the normal answer endpoint logic, deadlines included.
 */

const SESSION_HARD_CAP_MS = 4 * 60_000;
const TOPUP_THRESHOLD = 200;
const TOPUP_AMOUNT = 2_000;


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type BotProfile = MiniGameBotProfile;


async function runBotSession(bot: BotProfile): Promise<void> {
  const rng = mulberry32((Number(bot.personality_seed) % 0xffffffff) ^ Date.now());
  // Calibrated skill → answer accuracy; consistency narrows the jitter.
  const jitter = (rng() - 0.5) * (1 - Math.min(1, Math.max(0, bot.consistency))) * 0.16;
  const accuracy = Math.min(0.93, Math.max(0.45, 0.68 + bot.base_skill * 0.09 + jitter));
  const stakeOptions = [5, 10, 10, 20, 20, 50, 100];
  const stake = stakeOptions[Math.floor(rng() * stakeOptions.length)];
  const targetOpen = 2 + Math.floor(rng() * 5); // 2..6
  const greed = 0.3 + rng() * 0.45;
  const deadline = Date.now() + SESSION_HARD_CAP_MS;

  if (bot.coins < TOPUP_THRESHOLD + stake) {
    await freeKicksRepo.topUpBotWallet(bot.user_id, TOPUP_AMOUNT);
  }

  let state = await freeKicksService.startRound(bot.user_id, stake, `bot-${Math.floor(rng() * 1e9)}`);

  while (!worker.stopping && Date.now() < deadline && state.status === 'active') {
    await sleep(800 + rng() * 2500);

    if (state.phase === 'deciding') {
      const wantsQuestion = state.open_count < Math.min(targetOpen, MAX_OPEN) && !state.answer_locked && rng() < 0.92;
      if (wantsQuestion) {
        state = await freeKicksService.dealQuestion(bot.user_id, state.state_version);
        continue;
      }
      const zones = openZones(state.open_count);
      const zone = zones[Math.floor(rng() * zones.length)];
      const shot = await freeKicksService.shoot(bot.user_id, {
        zone,
        expectedVersion: state.state_version,
      });
      state = shot.state;
      continue;
    }

    if (state.phase === 'question' && state.question) {
      // Human thinking time; ~5% let the clock run out entirely.
      const thinkMs = rng() < 0.05 ? 8_500 : 1_200 + rng() * 3_800;
      await sleep(thinkMs);
      const row = await freeKicksRepo.getActiveRound(bot.user_id);
      if (!row || row.question_id !== state.question.question_id) {
        state = await freeKicksService.getCurrentState(bot.user_id).catch(() => state);
        continue;
      }
      const correctId = row.question_correct_option;
      const options = state.question.options.map((option) => option.id);
      const wrong = options.filter((id) => id !== correctId);
      const optionId = rng() < accuracy ? correctId! : wrong[Math.floor(rng() * wrong.length)];
      try {
        const result = await freeKicksService.answerQuestion(bot.user_id, {
          questionId: state.question.question_id,
          optionId,
          expectedVersion: row.state_version,
        });
        state = result.state;
      } catch {
        state = await freeKicksService.getCurrentState(bot.user_id);
      }
      continue;
    }

    if (state.phase === 'post_goal') {
      const ride = rng() < greed && state.pot_coins < FREE_KICKS_POT_CAP / 4;
      if (ride) {
        state = await freeKicksService.nextAttack(bot.user_id, {
          expectedVersion: state.state_version,
          clientNonce: `bot-${Math.floor(rng() * 1e9)}`,
        });
      } else {
        state = await freeKicksService.cashout(bot.user_id, state.state_version);
      }
      continue;
    }

    break;
  }
}

/** FREE_KICKS_BOTS_DAILY_SESSIONS wins when set; otherwise derive from the audience size. */
function dailySessions(): number {
  return config.FREE_KICKS_BOTS_DAILY_SESSIONS > 0
    ? config.FREE_KICKS_BOTS_DAILY_SESSIONS
    : deriveDailySessions(config.SYNTHETIC_ACTIVITY_DAU, 0.15, 3);
}

const worker = createMiniGameBotWorker<BotProfile>({
  name: 'free-kicks',
  botsEnabled: () => config.FREE_KICKS_BOTS_ENABLED,
  modeEnabled: () => config.FREE_KICKS_ENABLED,
  dailySessions,
  pickIdleBots: (limit) => freeKicksRepo.pickIdleBots(limit),
  runSession: runBotSession,
});

export const startFreeKicksBots = (): void => worker.start();
export const stopFreeKicksBots = (): void => worker.stop();
