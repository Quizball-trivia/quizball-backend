import { randomUUID } from 'crypto';
import { config } from '../../core/config.js';
import { sql } from '../../db/index.js';
import { roadToGoalRepo } from './road-to-goal.repo.js';
import { roadToGoalService } from './road-to-goal.service.js';
import { deriveDailySessions, mulberry32 } from '../synthetic-bots/activity-model.js';
import { createMiniGameBotWorker, type MiniGameBotProfile } from '../synthetic-bots/mini-game-bots.js';
import { ROAD_TO_GOAL_STAKES } from './road-to-goal.constants.js';
import type { RoadToGoalQuestionSnapshot } from './road-to-goal.types.js';

/**
 * Roster bots playing Road to Goal through the real commitment → run → answer
 * → continue/cash-out flow. Calibration already excludes bot accounts
 * (road-to-goal.repo: player.is_ai = false), so bot answers never move the
 * question difficulty model. Arrivals follow the shared activity model.
 */
const SESSION_HARD_CAP_MS = 6 * 60_000;
const TOPUP_THRESHOLD = 200;
const TOPUP_AMOUNT = 1_500;
const MODE_SHARE = 0.1;
const SESSIONS_PER_PLAYER = 2;

type BotProfile = MiniGameBotProfile;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dailySessions(): number {
  return config.ROAD_TO_GOAL_BOTS_DAILY_SESSIONS > 0
    ? config.ROAD_TO_GOAL_BOTS_DAILY_SESSIONS
    : deriveDailySessions(config.SYNTHETIC_ACTIVITY_DAU, MODE_SHARE, SESSIONS_PER_PLAYER);
}

async function correctOptionFor(roundId: string, questionId: string): Promise<string | null> {
  const [row] = await sql<Array<{ run_questions: RoadToGoalQuestionSnapshot[] | string }>>`
    SELECT run_questions FROM road_to_goal_rounds WHERE id = ${roundId}
  `;
  const questions = typeof row?.run_questions === 'string' ? (JSON.parse(row.run_questions) as RoadToGoalQuestionSnapshot[]) : row?.run_questions ?? [];
  return questions.find((q) => q.question_id === questionId)?.correct_option_id ?? null;
}

export async function runBotSession(bot: BotProfile): Promise<void> {
  const rng = mulberry32((Number(bot.personality_seed) % 0xffffffff) ^ Date.now());
  const jitter = (rng() - 0.5) * (1 - Math.min(1, Math.max(0, bot.consistency))) * 0.16;
  const accuracy = Math.min(0.93, Math.max(0.45, 0.68 + bot.base_skill * 0.09 + jitter));
  const stake = ROAD_TO_GOAL_STAKES[Math.floor(rng() * ROAD_TO_GOAL_STAKES.length)];
  const targetZones = 2 + Math.floor(rng() * 5); // bank after 2..6 cleared zones
  const deadline = Date.now() + SESSION_HARD_CAP_MS;

  if (bot.coins < TOPUP_THRESHOLD + stake) await roadToGoalRepo.topUpBotWallet(bot.user_id, TOPUP_AMOUNT);

  const commitment = await roadToGoalService.prepareCommitment(bot.user_id, { stakeCoins: stake, requestNonce: randomUUID(), autoCashoutZone: null });
  let state = await roadToGoalService.startRound(bot.user_id, { commitmentId: commitment.commitment_id, clientNonce: randomUUID(), clientSeed: `bot-${Math.floor(rng() * 1e9)}` });

  while (!worker.stopping && Date.now() < deadline && state.status === 'active') {
    if (state.phase === 'question' && state.question) {
      await sleep(rng() < 0.05 ? 16_000 : 2_000 + rng() * 6_000);
      const correctId = await correctOptionFor(state.round_id, state.question.question_id);
      const options = state.question.options.map((o) => o.id);
      const wrong = options.filter((id) => id !== correctId);
      const optionId = correctId && rng() < accuracy ? correctId : wrong[Math.floor(rng() * wrong.length)];
      try {
        const result = await roadToGoalService.answerQuestion(bot.user_id, { roundId: state.round_id, questionId: state.question.question_id, optionId, expectedVersion: state.state_version, requestNonce: randomUUID() });
        state = result.state;
      } catch {
        state = await roadToGoalService.getCurrentState(bot.user_id).catch(() => state);
        if (state.status !== 'active') break;
      }
      continue;
    }
    if (state.phase === 'decision') {
      await sleep(1_000 + rng() * 3_000);
      const input = { roundId: state.round_id, expectedVersion: state.state_version, requestNonce: randomUUID() };
      state = state.cleared_zones >= targetZones
        ? await roadToGoalService.cashout(bot.user_id, input)
        : await roadToGoalService.continueRound(bot.user_id, input);
      continue;
    }
    break;
  }
}

const worker = createMiniGameBotWorker<BotProfile>({
  name: 'road-to-goal',
  botsEnabled: () => config.ROAD_TO_GOAL_BOTS_ENABLED,
  modeEnabled: () => config.ROAD_TO_GOAL_ENABLED,
  dailySessions,
  pickIdleBots: (limit) => roadToGoalRepo.pickIdleBots(limit),
  runSession: runBotSession,
});

export const startRoadToGoalBots = (): void => worker.start();
export const stopRoadToGoalBots = (): void => worker.stop();
