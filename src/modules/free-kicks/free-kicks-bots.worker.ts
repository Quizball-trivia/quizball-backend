import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { freeKicksRepo } from './free-kicks.repo.js';
import { freeKicksService } from './free-kicks.service.js';
import { isWithinScheduleWindow } from '../synthetic-bots/activity-window.js';
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
 *   - activity schedules respected (fewer bots at 4am Tbilisi), plus an
 *     hour-of-day concurrency curve on top
 *
 * The worker peeks the round row for the correct option (server-side code may;
 * clients cannot) purely to IMPLEMENT the skill roll — the outcome still flows
 * through the normal answer endpoint logic, deadlines included.
 */

const TICK_MS = 20_000;
const SESSION_HARD_CAP_MS = 4 * 60_000;
const TOPUP_THRESHOLD = 200;
const TOPUP_AMOUNT = 2_000;

/** Concurrency multiplier per Tbilisi hour (0-23) — quiet nights, busy evenings. */
const HOUR_CURVE = [
  0.25, 0.15, 0.1, 0.1, 0.1, 0.15, 0.25, 0.4, 0.55, 0.65, 0.7, 0.75,
  0.8, 0.8, 0.85, 0.9, 0.95, 1, 1, 1, 0.95, 0.85, 0.65, 0.4,
];

function tbilisiHour(): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Tbilisi' })
      .format(new Date())
  ) % 24;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BotProfile {
  user_id: string;
  base_skill: number;
  consistency: number;
  personality_seed: number;
  schedule: unknown;
  coins: number;
}

const activeSessions = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let stopping = false;

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

  while (!stopping && Date.now() < deadline && state.status === 'active') {
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

async function tick(): Promise<void> {
  const target = Math.round(config.FREE_KICKS_BOTS_TARGET * HOUR_CURVE[tbilisiHour()]);
  const deficit = target - activeSessions.size;
  if (deficit <= 0) return;

  const candidates = await freeKicksRepo.pickIdleBots(deficit * 2);
  const eligible = candidates
    .filter((bot) => isWithinScheduleWindow(bot.schedule))
    .slice(0, deficit);

  // NOTE: activeSessions is per-process. With multiple replicas two workers
  // can pick the same bot; the unique active-round index makes the second
  // startRound fail (409) and that session aborts — the only waste is a
  // possible duplicate house-side top-up, which is bounded and audited.
  for (const bot of eligible) {
    if (activeSessions.has(bot.user_id)) continue;
    activeSessions.add(bot.user_id);
    // Stagger session starts so arrivals look organic, not batchy.
    const startDelay = Math.random() * TICK_MS;
    void sleep(startDelay)
      .then(() => runBotSession(bot))
      .catch((error) => {
        logger.debug({ botId: bot.user_id, error }, 'free-kicks bot session ended with error');
      })
      .finally(() => {
        activeSessions.delete(bot.user_id);
      });
  }
}

export function startFreeKicksBots(): void {
  // Bots are an amplifier for the mode, never a bypass of its kill switch:
  // both flags must be on, so FREE_KICKS_ENABLED=false always means "no new
  // rounds from anyone", bots included.
  if (timer || !config.FREE_KICKS_BOTS_ENABLED) return;
  if (!config.FREE_KICKS_ENABLED) {
    logger.warn('FREE_KICKS_BOTS_ENABLED is set without FREE_KICKS_ENABLED — bots stay off');
    return;
  }
  stopping = false;
  timer = setInterval(() => {
    void tick().catch((error) => logger.error({ error }, 'free-kicks bots tick failed'));
  }, TICK_MS);
  timer.unref?.();
  logger.info({ target: config.FREE_KICKS_BOTS_TARGET }, 'free-kicks bot worker started');
}

export function stopFreeKicksBots(): void {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
