export const COIN_MINOR_SCALE = 100;

export interface CoinAmountParts {
  coins: number;
  coinFractionMinor: number;
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer`);
  }
}

export function wholeCoinsToMinor(coins: number): number {
  assertSafeInteger(coins, 'coins');
  const minor = coins * COIN_MINOR_SCALE;
  assertSafeInteger(minor, 'coins in minor units');
  return minor;
}

export function coinPartsToMinor(coins: number, coinFractionMinor: number): number {
  assertSafeInteger(coins, 'coins');
  assertSafeInteger(coinFractionMinor, 'coinFractionMinor');
  if (coinFractionMinor < 0 || coinFractionMinor >= COIN_MINOR_SCALE) {
    throw new RangeError(`coinFractionMinor must be between 0 and ${COIN_MINOR_SCALE - 1}`);
  }

  const totalMinor = wholeCoinsToMinor(coins) + coinFractionMinor;
  assertSafeInteger(totalMinor, 'total coin balance in minor units');
  return totalMinor;
}

export function splitCoinMinor(totalMinor: number): CoinAmountParts {
  assertSafeInteger(totalMinor, 'totalMinor');
  if (totalMinor < 0) {
    throw new RangeError('totalMinor must be nonnegative');
  }

  return {
    coins: Math.floor(totalMinor / COIN_MINOR_SCALE),
    coinFractionMinor: totalMinor % COIN_MINOR_SCALE,
  };
}

export function minorToWholeCoinsTruncated(totalMinor: number): number {
  assertSafeInteger(totalMinor, 'totalMinor');
  return Math.trunc(totalMinor / COIN_MINOR_SCALE);
}

/** Convert exact integer storage parts to the decimal value exposed by the API. */
export function coinPartsToDisplay(coins: number, coinFractionMinor: number): number {
  return coinPartsToMinor(coins, coinFractionMinor) / COIN_MINOR_SCALE;
}
