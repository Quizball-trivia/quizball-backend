import { describe, expect, it, vi } from 'vitest';
import { chargeSeat, type ChargeWallet } from '../../src/modules/room/room.charge.js';
import { chargeOf, startMatch, zoneMatchPackSchema } from '../../src/modules/room/games/zone-match/zone-match.engine.js';
import type { TransactionSql } from '../../src/db/index.js';

const tx = {} as TransactionSql;
const price = { coins: 150, item: 'helpline_fog' };

function fakeWallet(balance: number) {
  let coins = balance;
  const wallet = {
    adjustWalletInTx: vi.fn(async (_tx: unknown, _user: string, delta: number) => {
      if (coins + delta < 0) return null;
      coins += delta;
      return { coins, coin_fraction_minor: 0, tickets: 0 };
    }),
    insertTransactionLogInTx: vi.fn(async () => ({})),
  };
  return { wallet: wallet as unknown as ChargeWallet & typeof wallet, balance: () => coins };
}

const input = (isAi = false, charge: () => typeof price | null = () => price) => ({
  engine: { charge },
  matchId: 'm1',
  game: 'zone_match',
  seat: { user_id: 'u1', seat: 0, is_ai: isAi },
  before: null,
  after: null,
  command: { type: 'live' },
});

describe('room paid moves (chargeSeat)', () => {
  it('debits the price and writes it to the store ledger', async () => {
    const { wallet, balance } = fakeWallet(500);
    await expect(chargeSeat(tx, input(), wallet)).resolves.toBe(true);
    expect(balance()).toBe(350);
    expect(wallet.insertTransactionLogInTx).toHaveBeenCalledWith(tx, expect.objectContaining({
      eventType: 'fulfillment_succeeded', outcome: 'success', userId: 'u1', coinsDelta: -150, reason: 'zone_match_helpline_fog',
    }));
  });

  it("refuses a seat that can't pay, without debiting or logging", async () => {
    const { wallet, balance } = fakeWallet(100);
    await expect(chargeSeat(tx, input(), wallet)).resolves.toBe(false);
    expect(balance()).toBe(100);
    expect(wallet.insertTransactionLogInTx).not.toHaveBeenCalled();
  });

  it('never charges a bot seat, nor a move with no price', async () => {
    const { wallet } = fakeWallet(0);
    await expect(chargeSeat(tx, input(true), wallet)).resolves.toBe(true);
    await expect(chargeSeat(tx, input(false, () => null), wallet)).resolves.toBe(true);
    expect(wallet.adjustWalletInTx).not.toHaveBeenCalled();
  });

  it('a zone match prices nothing but a helpline it accepted', () => {
    const text = (t: string) => ({ en: t });
    const categories = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: text(`C${i}`), imageUrl: null, icon: null }));
    const mcqs = categories.flatMap((c) => Array.from({ length: 2 }, (_, n) => ({ id: `${c.id}q${n}`, categoryId: c.id, prompt: text('q'), options: [text('a'), text('b'), text('c'), text('d')], correctIndex: 0 })));
    const content = zoneMatchPackSchema.parse({
      seed: 1, categories, mcqs, fallback: mcqs.slice(0, 10).map((q) => q.id),
      numerics: Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, prompt: text('n'), unit: text('u'), value: i, step: 1, precision: 0 })),
      rules: { counters: false, downsides: false, attackerWinsTies: false, energy: false, hiddenLoadouts: false, bicycle: 'comeback' },
    });
    const s = startMatch(2, content, 0);
    // The same state before and after: a refused (unspent) helpline costs nothing.
    expect(chargeOf(s, s, 0, { type: 'live', duel: 1, key: 1, card: 'fog' })).toBeNull();
  });
});

describe('zone match engine versions', () => {
  it('runs paid helplines as version 2, finishes version-1 matches free, and asks tabs for zone_match@2', async () => {
    const { roomEngineFor, clientCanPlay } = await import('../../src/modules/room/room.registry.js');
    expect(roomEngineFor('zone_match', 2)?.charge).toBeTypeOf('function');
    expect(roomEngineFor('zone_match', 1)).not.toBeNull();
    expect(roomEngineFor('zone_match', 1)?.charge).toBeUndefined();
    expect(clientCanPlay('zone_match', ['zone_match'], 2)).toBe(false);
    expect(clientCanPlay('zone_match', ['zone_match', 'zone_match@2'], 2)).toBe(true);
    expect(clientCanPlay('zone_match', ['zone_match'], 1)).toBe(true);
  });
});
