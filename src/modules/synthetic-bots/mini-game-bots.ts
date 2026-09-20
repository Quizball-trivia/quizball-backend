import { logger } from '../../core/logger.js';
import { isWithinScheduleWindow } from './activity-window.js';
import { expectedArrivals, poisson } from './activity-model.js';

/**
 * One bot worker for every house-banked mini game (Free Kicks, Road to Goal,
 * Trivia Mines). A game supplies only two things — how to pick idle roster
 * bots and how one bot plays one session through the real service layer —
 * and gets the shared arrival model, concurrency cap, staggered starts and
 * kill-switch handling for free.
 */
export interface MiniGameBotProfile {
  user_id: string;
  base_skill: number;
  consistency: number;
  personality_seed: number;
  schedule: unknown;
  coins: number;
}

export interface MiniGameBotWorkerOptions<TBot extends MiniGameBotProfile> {
  /** Log/jitter key, e.g. 'trivia-mines'. */
  name: string;
  /** Both the mode flag and the bots flag; a disabled mode never gets bot rounds. */
  botsEnabled: () => boolean;
  modeEnabled: () => boolean;
  /** Sessions per day the bots should generate (already derived from the audience size). */
  dailySessions: () => number;
  pickIdleBots: (limit: number) => Promise<TBot[]>;
  runSession: (bot: TBot) => Promise<void>;
  maxConcurrent?: number;
  tickMs?: number;
}

export function createMiniGameBotWorker<TBot extends MiniGameBotProfile>(options: MiniGameBotWorkerOptions<TBot>) {
  const tickMs = options.tickMs ?? 20_000;
  const maxConcurrent = options.maxConcurrent ?? 40;
  const active = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let stopping = false;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function tick(): Promise<void> {
    const arrivals = poisson(Math.random, expectedArrivals(options.dailySessions(), tickMs, options.name));
    const wanted = Math.min(arrivals, maxConcurrent - active.size);
    if (wanted <= 0) return;
    const candidates = await options.pickIdleBots(wanted * 2);
    const eligible = candidates.filter((bot) => isWithinScheduleWindow(bot.schedule)).slice(0, wanted);
    // NOTE: `active` is per process. With replicas two workers may pick the same
    // bot; the unique active-round index makes the second start fail (409) and
    // that session aborts — the only waste is a bounded, audited top-up.
    for (const bot of eligible) {
      if (active.has(bot.user_id)) continue;
      active.add(bot.user_id);
      void sleep(Math.random() * tickMs) // stagger arrivals so they look organic
        .then(() => (stopping ? undefined : options.runSession(bot)))
        .catch((error) => logger.debug({ bot: bot.user_id, error }, `${options.name} bot session ended with error`))
        .finally(() => active.delete(bot.user_id));
    }
  }

  return {
    start(): void {
      if (timer || !options.botsEnabled()) return;
      if (!options.modeEnabled()) {
        logger.warn(`${options.name}: bots flag set without the mode flag — bots stay off`);
        return;
      }
      stopping = false;
      timer = setInterval(() => { void tick().catch((error) => logger.error({ error }, `${options.name} bots tick failed`)); }, tickMs);
      timer.unref?.();
      logger.info({ dailySessions: options.dailySessions() }, `${options.name} bot worker started`);
    },
    stop(): void {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** For tests: run one tick now. */
    tick,
    get activeCount() { return active.size; },
    get stopping() { return stopping; },
  };
}
