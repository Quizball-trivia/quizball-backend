import type { TransactionSql } from '../../db/index.js';
import { storeRepo } from '../store/store.repo.js';
import type { AnyRoomEngine } from './room.engine.js';
import type { RoomSeatRow } from './room.repo.js';

/** The two wallet calls a charge makes (storeRepo's; a test passes its own). */
export type ChargeWallet = Pick<typeof storeRepo, 'adjustWalletInTx' | 'insertTransactionLogInTx'>;

export interface ChargeInput {
  engine: Pick<AnyRoomEngine, 'charge'>;
  matchId: string;
  game: string;
  seat: Pick<RoomSeatRow, 'user_id' | 'seat' | 'is_ai'>;
  /** The state before and after the accepted command. */
  before: unknown;
  after: unknown;
  command: unknown;
}

/**
 * Debits a paid move (a game's `charge`, e.g. a Ranked 2.0 helpline) in the command's own transaction and logs it in
 * the store ledger. True when nothing was owed or it was paid; false when the seat can't pay — the runtime then
 * refuses the command (`insufficient_coins`) and keeps the state it had. Bot seats (users.is_ai) play free.
 */
export async function chargeSeat(tx: TransactionSql, input: ChargeInput, wallet: ChargeWallet = storeRepo): Promise<boolean> {
  const { engine, seat } = input;
  const price = engine.charge?.(input.before as never, input.after as never, seat.seat!, input.command);
  if (!price || price.coins <= 0 || seat.is_ai) return true;
  // One conditional UPDATE: null when the balance would go below zero (nothing is debited then).
  const debited = await wallet.adjustWalletInTx(tx, seat.user_id, -price.coins, 0);
  if (!debited) return false;
  await wallet.insertTransactionLogInTx(tx, {
    eventType: 'fulfillment_succeeded',
    outcome: 'success',
    userId: seat.user_id,
    coinsDelta: -price.coins,
    reason: `${input.game}_${price.item}`,
    metadata: { matchId: input.matchId, game: input.game, item: price.item, seat: seat.seat },
  });
  return true;
}
