/**
 * Loader for the active bot_model_params row (PR8). The gameplay model reads the
 * ACTIVE params at match creation, validates them through the zod schema, and
 * pins both the version and a full copy into ranked_context. A malformed or
 * partial artifact throws here and aborts the persistent branch — a live bot is
 * never built on unvalidated params.
 */

import { sql } from '../../db/index.js';
import { parseBotModelParams, type BotModelParams } from './calibration/params-schema.js';

export interface ActiveBotModelParams {
  version: number;
  params: BotModelParams;
}

export const botModelParamsRepo = {
  /**
   * The single active params row (uq_bot_model_params_single_active guarantees
   * at most one). Returns null when no active row exists — the caller falls back
   * to the temporary bridge so matchmaking never fails on a missing calibration.
   */
  async getActive(): Promise<ActiveBotModelParams | null> {
    const [row] = await sql<Array<{ version: number; params: unknown }>>`
      SELECT version, params FROM bot_model_params WHERE active = true LIMIT 1
    `;
    if (!row) return null;
    return { version: row.version, params: parseBotModelParams(row.params) };
  },
};
