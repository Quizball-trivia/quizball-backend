import { describe, expect, it } from 'vitest';
import {
  coinPartsToDisplay,
  coinPartsToMinor,
  minorToWholeCoinsTruncated,
  splitCoinMinor,
  wholeCoinsToMinor,
} from '../../src/modules/store/coin-amount.js';
import { storeWalletResponseSchema } from '../../src/modules/store/store.schemas.js';
import { toStoreWalletResponse } from '../../src/modules/store/ticket-refill.service.js';

describe('coin amount helpers', () => {
  it('converts whole coins to exact minor units', () => {
    expect(wholeCoinsToMinor(25)).toBe(2_500);
    expect(wholeCoinsToMinor(-25)).toBe(-2_500);
  });

  it('combines and splits stored wallet parts without losing a cent', () => {
    expect(coinPartsToMinor(25, 75)).toBe(2_575);
    expect(splitCoinMinor(2_575)).toEqual({ coins: 25, coinFractionMinor: 75 });
    expect(coinPartsToDisplay(25, 75)).toBe(25.75);
  });

  it('derives the compatible whole-coin ledger value by truncating toward zero', () => {
    expect(minorToWholeCoinsTruncated(2_575)).toBe(25);
    expect(minorToWholeCoinsTruncated(-2_575)).toBe(-25);
  });

  it('rejects invalid integer storage values', () => {
    expect(() => wholeCoinsToMinor(1.5)).toThrow(RangeError);
    expect(() => coinPartsToMinor(1, 100)).toThrow(RangeError);
    expect(() => splitCoinMinor(-1)).toThrow(RangeError);
    expect(() => splitCoinMinor(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe('fractional wallet responses', () => {
  it('combines whole coins and the stored remainder for public responses', () => {
    const response = toStoreWalletResponse({
      coins: 25,
      coin_fraction_minor: 75,
      tickets: 3,
    });

    expect(response.coins).toBe(25.75);
    expect(storeWalletResponseSchema.parse(response).coins).toBe(25.75);
  });
});
