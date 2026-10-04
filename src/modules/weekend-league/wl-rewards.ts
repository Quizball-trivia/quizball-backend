/**
 * Weekend League reward delivery.
 *
 * Two steps, both idempotent and both safe to race (the orchestrator sweep and
 * the ops repair endpoint may run together):
 *
 *  1. FREEZE — once per completed tournament, in one transaction, every
 *     entitlement is written as a 'pending' receipt. Bands are decided here and
 *     never recomputed, so a retry cannot re-rank the field and promote a second
 *     player into a band that was already paid.
 *  2. PAY — each pending receipt is granted in its own short transaction: lock
 *     the receipt, lock and recheck the account, credit the wallet, add the
 *     items, write the ledger row, flip the receipt to 'granted'. An account
 *     that became ineligible since the freeze forfeits; nobody is promoted.
 *
 * This never runs inside tournament completion, so a reward failure cannot
 * roll back a final.
 */
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { storeRepo } from '../store/store.repo.js';
import { WL_FINAL_GAME_INDEX } from './wl-rules.js';
import {
  WL_PACK_ITEM_SLUGS,
  WL_REWARD_POLICY_VERSION,
  wlHighestReward,
  type WlRewardBand,
  type WlRewardFacts,
} from './wl-reward-policy.js';

export interface WlRewardItem {
  slug: string;
  avatarPartId: string;
  slot: string;
  alreadyOwned?: boolean;
}

export interface WlRewardReceiptRow {
  id: string;
  tournament_id: string;
  week_key: string | null;
  user_id: string;
  band: WlRewardBand;
  human_rank: number | null;
  coins: number;
  items: WlRewardItem[];
  status: 'pending' | 'granted' | 'forfeited';
  granted_at: string | null;
  seen_at: string | null;
}

interface FactsRow {
  user_id: string;
  sat_checked_in: boolean;
  sat_played: boolean;
  qualified: boolean;
  sun_checked_in: boolean;
  final_played: boolean;
  final_rank: number | null;
  human_rank: number | null;
}

export type WlFreezeOutcome =
  | { frozen: true; receipts: number }
  | { frozen: false; reason: 'not_found' | 'not_completed' | 'test_tournament' | 'no_week_key' | 'before_rollout' | 'already_frozen' };

type WlIneligibleReason = 'not_completed' | 'test_tournament' | 'no_week_key' | 'before_rollout';

interface TournamentGate {
  status: string;
  is_test: boolean;
  week_key: string | null;
  config: Record<string, unknown> | null;
}

/**
 * Whether this tournament may pay at all. Checked at the freeze AND again
 * before every payment pass, so a tournament frozen under one configuration
 * cannot keep paying after the rollout week or its opt-in changed.
 */
function ineligibleReason(t: TournamentGate): WlIneligibleReason | null {
  if (t.status !== 'completed') return 'not_completed';
  if (t.is_test) {
    // Opt-in rehearsal only, never in prod, and only the full Saturday+Sunday
    // shape: a single_game event plays its final as game 0, which the facts
    // query would read as a qualifier.
    const optedIn = config.NODE_ENV !== 'prod' && t.config?.['reward_payout'] === true;
    return optedIn && t.config?.['single_game'] !== true ? null : 'test_tournament';
  }
  if (!t.week_key) return 'no_week_key';
  const from = rolloutWeek();
  return !from || t.week_key < from ? 'before_rollout' : null;
}

export type WlGrantOutcome = 'granted' | 'forfeited' | 'skipped';

/** Accounts that may never hold a reward. Shared by the freeze and the pay-time recheck. */
const INELIGIBLE_ENTRY_STATES = ['disqualified', 'withdrawn', 'cancelled'];

function rolloutWeek(): string | null {
  const week = config.WL_REWARDS_FROM_WEEK;
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return null;
  // A real calendar date, not just the shape: '2026-02-30' would pass the
  // pattern and then make every sweep query fail on its ::date cast, which
  // would also stop opted-in rehearsals. Treated as unset instead.
  const parsed = new Date(`${week}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === week ? week : null;
}

async function loadFacts(tx: typeof sql, tournamentId: string): Promise<FactsRow[]> {
  // "Played" is an ACCEPTED answer on a run that counted. wl_answers also holds
  // voided_audit rows and synthetic money-drop awards, and idlers still get
  // participant and result rows, so none of those prove play.
  return tx<FactsRow[]>`
    WITH eligible AS (
      SELECT e.user_id, e.state, e.checked_in_at, e.final_checked_in_at
      FROM wl_entries e
      JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ${tournamentId}
        AND e.state <> ALL(${sql.array(INELIGIBLE_ENTRY_STATES)}::text[])
        AND u.is_ai = false AND u.is_seed = false
        AND u.is_deleted = false AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
        AND u.is_banned = false
    ),
    played AS (
      SELECT a.user_id,
             bool_or(a.game_index < ${WL_FINAL_GAME_INDEX}) AS qualifier,
             bool_or(a.game_index = ${WL_FINAL_GAME_INDEX}) AS final
      FROM wl_answers a
      JOIN wl_question_runs r ON r.attempt_id = a.attempt_id
      WHERE a.tournament_id = ${tournamentId}
        AND a.timing_source = 'redis_accept'
        AND r.status IN ('frozen', 'revealed')
      GROUP BY a.user_id
    ),
    facts AS (
      SELECT el.user_id,
             el.checked_in_at IS NOT NULL AS sat_checked_in,
             COALESCE(p.qualifier, false) AS sat_played,
             el.state IN ('finalist', 'champion', 'no_show') AS qualified,
             el.final_checked_in_at IS NOT NULL AS sun_checked_in,
             (t.final_played AND COALESCE(p.final, false) AND fr.rank IS NOT NULL) AS final_played,
             fr.rank AS final_rank
      FROM eligible el
      JOIN wl_tournaments t ON t.id = ${tournamentId}
      LEFT JOIN played p ON p.user_id = el.user_id
      LEFT JOIN wl_game_results fr
        ON fr.tournament_id = ${tournamentId}
       AND fr.game_index = ${WL_FINAL_GAME_INDEX}
       AND fr.user_id = el.user_id
    )
    SELECT f.user_id, f.sat_checked_in, f.sat_played, f.qualified, f.sun_checked_in,
           f.final_played, f.final_rank,
           CASE WHEN f.final_played
             THEN (ROW_NUMBER() OVER (PARTITION BY f.final_played ORDER BY f.final_rank ASC, f.user_id ASC))::int
           END AS human_rank
    FROM facts f
    ORDER BY f.user_id ASC
  `;
}

async function resolvePackItems(tx: TransactionSql): Promise<Record<number, WlRewardItem[]>> {
  const items: Record<number, WlRewardItem[]> = {};
  for (const [place, slugs] of Object.entries(WL_PACK_ITEM_SLUGS)) {
    items[Number(place)] = [];
    for (const slug of slugs) {
      const product = await storeRepo.getProductBySlugInTx(tx, slug, true);
      const metadata = (product?.metadata ?? {}) as { avatarPartId?: unknown; slot?: unknown };
      if (!product || product.type !== 'avatar'
        || typeof metadata.avatarPartId !== 'string' || typeof metadata.slot !== 'string') {
        throw new Error(`WL reward product missing or malformed: ${slug}`);
      }
      items[Number(place)].push({ slug, avatarPartId: metadata.avatarPartId, slot: metadata.slot });
    }
  }
  return items;
}

/** Lock waits in settlement fail fast and are retried on a later pass. */
const SETTLEMENT_LOCK_TIMEOUT = '3s';
const BOOKKEEPING_LOCK_TIMEOUT = '1s';

export async function freezeWlRewards(tournamentId: string): Promise<WlFreezeOutcome> {
  return sql.begin(async (tx): Promise<WlFreezeOutcome> => {
    const txSql = tx as unknown as typeof sql;
    await txSql`SELECT set_config('lock_timeout', ${SETTLEMENT_LOCK_TIMEOUT}, true)`;
    // FOR KEY SHARE, taken first: it only conflicts with deleting the row, so
    // it never holds up the orchestrator's cursor updates on this tournament
    // (those are non-key updates), and it fixes the lock order as
    // tournament -> settlement, the same order the rehearsal delete uses.
    // Freezes themselves serialize on the settlement row below.
    const [t] = await txSql<TournamentGate[]>`
      SELECT status, is_test, week_key::text, config FROM wl_tournaments
      WHERE id = ${tournamentId} FOR KEY SHARE
    `;
    if (!t) return { frozen: false, reason: 'not_found' };
    const blocked = ineligibleReason(t);
    if (blocked) return { frozen: false, reason: blocked };

    await txSql`
      INSERT INTO wl_reward_settlements (tournament_id) VALUES (${tournamentId})
      ON CONFLICT (tournament_id) DO NOTHING
    `;
    const [settlement] = await txSql<{ frozen_at: string | null }[]>`
      SELECT frozen_at::text FROM wl_reward_settlements
      WHERE tournament_id = ${tournamentId} FOR UPDATE
    `;
    if (settlement?.frozen_at) return { frozen: false, reason: 'already_frozen' };

    const facts = await loadFacts(txSql, tournamentId);
    const packItems = await resolvePackItems(tx);
    const rows = facts.flatMap((f) => {
      const policyFacts: WlRewardFacts = {
        saturdayCheckedIn: f.sat_checked_in,
        saturdayPlayed: f.sat_played,
        qualifiedForFinal: f.qualified,
        sundayCheckedIn: f.sun_checked_in,
        finalPlayed: f.final_played,
        humanRank: f.human_rank,
      };
      const reward = wlHighestReward(policyFacts);
      if (!reward) return [];
      return [{
        user_id: f.user_id,
        band: reward.band,
        human_rank: reward.band === 'participant' || reward.band === 'finalist' ? null : f.human_rank,
        coins: reward.coins,
        items: reward.packPlace ? packItems[reward.packPlace] : [],
        facts: { ...policyFacts, finalRank: f.final_rank },
      }];
    });

    if (rows.length > 0) {
      // Targeted arbiter on purpose: a (week_key, user_id) clash means another
      // tournament already holds this weekend for the player. That must fail
      // the freeze loudly, not read as "already settled".
      await txSql`
        INSERT INTO wl_reward_receipts (
          tournament_id, week_key, user_id, policy_version, band, human_rank, coins, items, facts
        )
        SELECT ${tournamentId}, ${t.week_key}::date, r.user_id, ${WL_REWARD_POLICY_VERSION},
               r.band, r.human_rank, r.coins, r.items, r.facts
        FROM jsonb_to_recordset(${sql.json(rows as unknown as Json)}::jsonb) AS r(
          user_id uuid, band text, human_rank int, coins int, items jsonb, facts jsonb
        )
        ON CONFLICT (tournament_id, user_id) DO NOTHING
      `;
    }
    // A manual correction of the tournament (weekend, opt-in) that landed
    // while the facts were being read would freeze a mix of old and new.
    // FOR SHARE here waits for a correction still in flight, then sees it, and
    // holds off any new one until this commits a moment later — the share
    // lock exists only for that last instant, not for the whole freeze.
    // On a mismatch nothing is committed and the next pass starts clean.
    const [after] = await txSql<TournamentGate[]>`
      SELECT status, is_test, week_key::text, config FROM wl_tournaments
      WHERE id = ${tournamentId} FOR SHARE
    `;
    if (!after || JSON.stringify(after) !== JSON.stringify(t)) {
      throw new Error(`WL tournament ${tournamentId} changed during the reward freeze`);
    }
    await txSql`UPDATE wl_reward_settlements SET frozen_at = NOW() WHERE tournament_id = ${tournamentId}`;
    return { frozen: true, receipts: rows.length };
  });
}

/** Thrown to roll a grant back when its tournament stopped being eligible. */
class WlTournamentNoLongerEligible extends Error {}

export async function grantWlReward(receiptId: string): Promise<WlGrantOutcome> {
  try {
    return await grantWlRewardTx(receiptId);
  } catch (error) {
    if (error instanceof WlTournamentNoLongerEligible) return 'skipped';
    throw error;
  }
}

async function grantWlRewardTx(receiptId: string): Promise<WlGrantOutcome> {
  return sql.begin(async (tx): Promise<WlGrantOutcome> => {
    const txSql = tx as unknown as typeof sql;
    await txSql`SELECT set_config('lock_timeout', ${SETTLEMENT_LOCK_TIMEOUT}, true)`;
    // Tournament before receipt, the order the rehearsal delete uses. KEY SHARE
    // only conflicts with deleting the row, so cursor updates are unaffected.
    await txSql`
      SELECT 1 FROM wl_tournaments
      WHERE id = (SELECT tournament_id FROM wl_reward_receipts WHERE id = ${receiptId})
      FOR KEY SHARE
    `;
    // SKIP LOCKED: another worker already has this receipt; it is theirs.
    const [receipt] = await txSql<Array<{
      id: string; tournament_id: string; week_key: string | null; user_id: string;
      band: WlRewardBand; coins: number; items: WlRewardItem[]; policy_version: number;
    }>>`
      SELECT id, tournament_id, week_key::text, user_id, band, coins, items, policy_version
      FROM wl_reward_receipts
      WHERE id = ${receiptId} AND status = 'pending'
      FOR UPDATE SKIP LOCKED
    `;
    if (!receipt) return 'skipped';

    // The tournament may have been corrected since the freeze (opt-out,
    // relabel before the rollout week): leave the receipt pending rather than
    // pay on a decision that no longer holds. This early read saves the work;
    // the binding check is the locked one just before the commit.
    const [tournament] = await txSql<TournamentGate[]>`
      SELECT status, is_test, week_key::text, config FROM wl_tournaments WHERE id = ${receipt.tournament_id}
    `;
    if (!tournament || ineligibleReason(tournament)) return 'skipped';

    // Same row lock account deletion takes, so the recheck sees a settled truth.
    const [account] = await txSql<Array<{ ok: boolean }>>`
      SELECT (is_ai = false AND is_seed = false AND is_deleted = false
              AND deleted_at IS NULL AND pending_deletion_at IS NULL
              AND is_banned = false) AS ok
      FROM users WHERE id = ${receipt.user_id} FOR UPDATE
    `;
    // The entry is rechecked too: a disqualification recorded after the freeze
    // must still stop the payment.
    // Locked, so a disqualification still in flight is waited for and then
    // seen, rather than slipping in between this read and the payment.
    const [entry] = await txSql<Array<{ state: string }>>`
      SELECT state FROM wl_entries
      WHERE tournament_id = ${receipt.tournament_id} AND user_id = ${receipt.user_id}
      FOR SHARE
    `;
    const forfeitReason = !account?.ok
      ? 'account_ineligible_at_payment'
      : !entry || INELIGIBLE_ENTRY_STATES.includes(entry.state)
        ? 'entry_ineligible_at_payment'
        : null;
    if (forfeitReason) {
      await txSql`
        UPDATE wl_reward_receipts
        SET status = 'forfeited', forfeit_reason = ${forfeitReason}
        WHERE id = ${receipt.id}
      `;
      return 'forfeited';
    }

    if (receipt.coins > 0) {
      const wallet = await storeRepo.addCoinsInTx(tx, receipt.user_id, receipt.coins);
      if (!wallet) throw new Error(`WL reward wallet credit failed for receipt ${receipt.id}`);
    }

    const granted: WlRewardItem[] = [];
    const inventoryDelta: Record<string, number> = {};
    for (const item of receipt.items) {
      const product = await storeRepo.getProductBySlugInTx(tx, item.slug, true);
      if (!product) throw new Error(`WL reward product missing at payment: ${item.slug}`);
      // Not upsertInventoryInTx: that increments quantity, and a reward item is owned once.
      const inserted = await txSql<{ id: string }[]>`
        INSERT INTO user_inventory (user_id, product_id, quantity)
        VALUES (${receipt.user_id}, ${product.id}, 1)
        ON CONFLICT (user_id, product_id) DO NOTHING
        RETURNING id
      `;
      const alreadyOwned = inserted.length === 0;
      if (!alreadyOwned) inventoryDelta[item.slug] = 1;
      granted.push({ slug: item.slug, avatarPartId: item.avatarPartId, slot: item.slot, alreadyOwned });
    }

    await storeRepo.insertTransactionLogInTx(tx, {
      eventType: 'wl_reward',
      outcome: 'success',
      userId: receipt.user_id,
      coinsDelta: receipt.coins,
      inventoryDelta,
      reason: 'wl_reward',
      metadata: {
        receiptId: receipt.id,
        tournamentId: receipt.tournament_id,
        weekKey: receipt.week_key,
        band: receipt.band,
        policyVersion: receipt.policy_version,
      },
      idempotencyKey: `wl_reward:${receipt.tournament_id}:${receipt.user_id}`,
    });

    await txSql`
      UPDATE wl_reward_receipts
      SET status = 'granted', granted_at = NOW(), last_error = NULL,
          items = ${sql.json(granted as unknown as Json)}
      WHERE id = ${receipt.id}
    `;

    // Binding eligibility check, last thing before the commit. FOR SHARE waits
    // for a correction still being written and then sees it, and holds off a
    // new one for the instant until this commits. If the tournament no longer
    // qualifies, the whole grant rolls back and the receipt stays pending.
    const [current] = await txSql<TournamentGate[]>`
      SELECT status, is_test, week_key::text, config FROM wl_tournaments
      WHERE id = ${receipt.tournament_id} FOR SHARE
    `;
    if (!current || ineligibleReason(current)) throw new WlTournamentNoLongerEligible();
    return 'granted';
  });
}

export interface WlSettleResult {
  freeze: WlFreezeOutcome;
  granted: number;
  forfeited: number;
  failed: number;
  remaining: number;
  settled: boolean;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Retry bookkeeping. Best effort and bounded: it runs right after failures,
 * often while the row it wants is still locked by whoever caused the failure,
 * so it waits at most a second and then gives up loudly.
 *
 * `error` set → remember the failure. `cleared` → this pass made progress with
 * no failure, so the backoff may lift. Otherwise the stored error is left
 * alone: a pass that merely found everything locked by another worker must not
 * erase the failure that worker is about to record.
 */
async function recordSettlementAttempt(
  tournamentId: string,
  outcome: { error: string | null; cleared: boolean }
): Promise<{ recorded: boolean; settled: boolean }> {
  try {
    return await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      await txSql`SELECT set_config('lock_timeout', ${BOOKKEEPING_LOCK_TIMEOUT}, true)`;
      await txSql`
        INSERT INTO wl_reward_settlements (tournament_id, attempted_at, attempts, last_error)
        VALUES (${tournamentId}, NOW(), 1, ${outcome.error})
        ON CONFLICT (tournament_id) DO UPDATE
          SET attempted_at = NOW(),
              attempts = wl_reward_settlements.attempts + 1,
              last_error = CASE
                WHEN ${outcome.error}::text IS NOT NULL THEN ${outcome.error}::text
                WHEN ${outcome.cleared} THEN NULL
                ELSE wl_reward_settlements.last_error
              END
      `;
      // Settled exactly when it is frozen and nothing is pending. Receipts are
      // only ever created by the freeze, so none can appear after this check.
      const settled = await txSql<{ tournament_id: string }[]>`
        UPDATE wl_reward_settlements s
        SET settled_at = COALESCE(s.settled_at, NOW())
        WHERE s.tournament_id = ${tournamentId} AND s.frozen_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM wl_reward_receipts r
            WHERE r.tournament_id = s.tournament_id AND r.status = 'pending'
          )
        RETURNING s.tournament_id
      `;
      return { recorded: true, settled: settled.length > 0 };
    });
  } catch (error) {
    logger.warn({ err: error, tournamentId }, 'WL reward settlement bookkeeping skipped');
    // The durable retry state could not be written (its row is locked), so
    // keep this tournament out of this process's next few sweeps instead.
    deferLocally(tournamentId);
    return { recorded: false, settled: false };
  }
}

async function recordReceiptFailure(receiptId: string, message: string): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      await txSql`SELECT set_config('lock_timeout', ${BOOKKEEPING_LOCK_TIMEOUT}, true)`;
      await txSql`
        UPDATE wl_reward_receipts
        SET attempts = attempts + 1, last_attempt_at = NOW(), last_error = ${message}
        WHERE id = ${receiptId} AND status = 'pending'
      `;
    });
  } catch (error) {
    logger.warn({ err: error, receiptId }, 'WL reward receipt bookkeeping skipped');
  }
}

/**
 * Freeze (if needed) and pay up to `limit` pending receipts within `budgetMs`.
 * Safe to call repeatedly and concurrently: every decision that moves money
 * is made under a row lock in Postgres.
 */
export async function settleWlRewards(
  tournamentId: string,
  opts: { limit?: number; budgetMs?: number; shouldStop?: () => boolean } = {}
): Promise<WlSettleResult> {
  const deadline = opts.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + opts.budgetMs;
  const result: WlSettleResult = {
    freeze: { frozen: false, reason: 'not_found' }, granted: 0, forfeited: 0, failed: 0, remaining: 0, settled: false,
  };
  try {
    result.freeze = await freezeWlRewards(tournamentId);
  } catch (error) {
    await recordSettlementAttempt(tournamentId, { error: errorText(error), cleared: false });
    throw error;
  }
  if (!result.freeze.frozen && result.freeze.reason !== 'already_frozen') return result;

  // Least recently tried first: a receipt that keeps failing goes to the back
  // instead of blocking every receipt behind it.
  const pending = await sql<{ id: string }[]>`
    SELECT id FROM wl_reward_receipts
    WHERE tournament_id = ${tournamentId} AND status = 'pending'
    ORDER BY last_attempt_at ASC NULLS FIRST, user_id ASC
    LIMIT ${opts.limit ?? 200}
  `;
  let lastError: string | null = null;
  for (const { id } of pending) {
    if (Date.now() >= deadline || opts.shouldStop?.()) break;
    try {
      const outcome = await grantWlReward(id);
      if (outcome === 'granted') result.granted += 1;
      if (outcome === 'forfeited') result.forfeited += 1;
    } catch (error) {
      result.failed += 1;
      lastError = errorText(error);
      logger.error({ err: error, tournamentId, receiptId: id }, 'WL reward grant failed');
      await recordReceiptFailure(id, lastError);
    }
  }

  const [left] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM wl_reward_receipts
    WHERE tournament_id = ${tournamentId} AND status = 'pending'
  `;
  result.remaining = left?.n ?? 0;
  const bookkeeping = await recordSettlementAttempt(tournamentId, {
    error: lastError,
    cleared: result.failed === 0 && (result.remaining === 0 || result.granted + result.forfeited > 0),
  });
  result.settled = bookkeeping.settled;
  if (result.granted + result.forfeited + result.failed > 0 || result.freeze.frozen) {
    logger.info({ tournamentId, ...result }, 'WL rewards settlement pass');
  }
  return result;
}

let warnedMissingRolloutWeek = false;

/** Process-local fallback for when the durable retry state cannot be written. */
const LOCAL_DEFER_MS = 60_000;
const locallyDeferred = new Map<string, number>();
function deferLocally(tournamentId: string): void {
  locallyDeferred.set(tournamentId, Date.now() + LOCAL_DEFER_MS);
}

/** A tournament whose last pass failed is retried at most this often. */
const SWEEP_RETRY_BACKOFF_SECONDS = 60;
/** Wall-clock cap on one sweep. */
const SWEEP_BUDGET_MS = 8_000;

/**
 * One payout pass over completed tournaments that still owe rewards — real
 * ones from the rollout week on, plus (outside prod) test events that opted
 * in. Least recently attempted first, so no tournament can crowd out another;
 * that order and the failure backoff live in the database, so they hold
 * across replicas and restarts.
 */
export async function wlRewardsSweep(shouldStop: () => boolean = () => false): Promise<void> {
  if (!config.WL_REWARDS_ENABLED) return;
  const from = rolloutWeek();
  if (!from && !warnedMissingRolloutWeek) {
    warnedMissingRolloutWeek = true;
    logger.warn('WL rewards enabled without a valid WL_REWARDS_FROM_WEEK; real tournaments will not settle');
  }
  const includeTests = config.NODE_ENV !== 'prod';
  const now = Date.now();
  for (const [id, until] of locallyDeferred) {
    if (until <= now) locallyDeferred.delete(id);
  }
  const owed = await sql<{ id: string }[]>`
    SELECT t.id
    FROM wl_tournaments t
    LEFT JOIN wl_reward_settlements s ON s.tournament_id = t.id
    WHERE t.status = 'completed' AND s.settled_at IS NULL
      AND t.id <> ALL(${sql.array([...locallyDeferred.keys()])}::uuid[])
      AND (
        (t.is_test = false AND t.week_key IS NOT NULL AND t.week_key >= ${from ?? '9999-12-31'}::date)
        -- JSON booleans exactly, the same test ineligibleReason() applies.
        OR (${includeTests} AND t.is_test = true
            AND t.config->'reward_payout' = 'true'::jsonb
            AND COALESCE(t.config->'single_game', 'false'::jsonb) <> 'true'::jsonb)
      )
      AND (s.last_error IS NULL
           OR s.attempted_at < NOW() - make_interval(secs => ${SWEEP_RETRY_BACKOFF_SECONDS}))
    ORDER BY s.attempted_at ASC NULLS FIRST, t.created_at DESC
    LIMIT 5
  `;
  const passDeadline = now + SWEEP_BUDGET_MS;
  for (const { id } of owed) {
    const budgetMs = passDeadline - Date.now();
    if (budgetMs <= 0 || shouldStop()) return;
    try {
      const result = await settleWlRewards(id, { budgetMs, shouldStop });
      if (!result.freeze.frozen && result.freeze.reason !== 'already_frozen') {
        // Selected by the query but refused by the gate: record it, so it goes
        // to the back of the queue and backs off instead of taking a slot forever.
        await recordSettlementAttempt(id, { error: `ineligible:${result.freeze.reason}`, cleared: false });
      }
    } catch (error) {
      logger.error({ err: error, tournamentId: id }, 'WL rewards settlement failed');
    }
  }
}

const WORKER_INTERVAL_MS = 10_000;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerPass: Promise<void> | null = null;
let workerStopping = false;

/**
 * Payouts run on their own timer, NOT inside the orchestrator tick: they take
 * wallet locks, and neither the orchestrator's lease nor live question
 * delivery may ever wait on a wallet. Every replica may run this; Postgres row
 * locks decide who pays what.
 */
/** One timer tick: starts a sweep unless one is running or shutdown began. */
export function wlRewardsWorkerTick(): void {
  if (workerPass || workerStopping) return;
  workerPass = wlRewardsSweep(() => workerStopping)
    .catch((error) => logger.error({ err: error }, 'WL rewards sweep failed'))
    .finally(() => { workerPass = null; });
}

export function startWlRewardsWorker(): void {
  if (workerTimer || !config.WL_REWARDS_ENABLED) return;
  workerStopping = false;
  workerTimer = setInterval(wlRewardsWorkerTick, WORKER_INTERVAL_MS);
  workerTimer.unref?.();
  logger.info('WL rewards worker started');
}

/**
 * Stops the timer and waits for the pass in flight. The pass stops starting
 * new grants at once; the one it is in commits or rolls back as a whole, so
 * shutdown never closes the database under half a payout.
 */
export async function stopWlRewardsWorker(): Promise<void> {
  workerStopping = true;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await workerPass;
}

export const wlRewardsRepo = {
  /** Granted receipts only; pending and forfeited rows are never shown to the player. */
  async listForUser(userId: string): Promise<WlRewardReceiptRow[]> {
    return sql<WlRewardReceiptRow[]>`
      SELECT id, tournament_id, week_key::text, user_id, band, human_rank, coins, items,
             status, granted_at::text, seen_at::text
      FROM wl_reward_receipts
      WHERE user_id = ${userId} AND status = 'granted'
      ORDER BY granted_at DESC
      LIMIT 50
    `;
  },

  async markSeen(userId: string, receiptId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
      UPDATE wl_reward_receipts SET seen_at = NOW()
      WHERE id = ${receiptId} AND user_id = ${userId} AND status = 'granted' AND seen_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  },
};
