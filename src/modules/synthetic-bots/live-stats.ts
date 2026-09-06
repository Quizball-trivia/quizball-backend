/**
 * Shared "social layer" numbers for house-banked modes: players with a live
 * heartbeat and the latest profitable runs. Reads genuine rounds (humans and
 * bots alike) with a short cache; a game may add extras (Free Kicks: top runs).
 */
export interface LiveWinRow { nickname: string; payout_coins: number; stake_coins: number; settled_at: string }
export interface LiveStats {
  playing_now: number;
  recent_wins: Array<{ nickname: string; amount: number; run_mult: number; settled_at: string }>;
}

export function createLiveStats<TExtra extends object = Record<never, never>>(loaders: {
  countPlayingNow: () => Promise<number>;
  getRecentWins: (limit: number) => Promise<LiveWinRow[]>;
  extras?: () => Promise<TExtra>;
  cacheMs?: number;
  winsLimit?: number;
}): () => Promise<LiveStats & TExtra> {
  let cache: { at: number; value: LiveStats & TExtra } | null = null;
  const cacheMs = loaders.cacheMs ?? 10_000;
  return async () => {
    if (cache && Date.now() - cache.at < cacheMs) return cache.value;
    const [playingNow, wins, extra] = await Promise.all([
      loaders.countPlayingNow(),
      loaders.getRecentWins(loaders.winsLimit ?? 6),
      loaders.extras ? loaders.extras() : Promise.resolve({} as TExtra),
    ]);
    const value = {
      playing_now: playingNow,
      recent_wins: wins.map((w) => ({ nickname: w.nickname, amount: w.payout_coins, run_mult: Math.round((w.payout_coins / w.stake_coins) * 100) / 100, settled_at: w.settled_at })),
      ...extra,
    } as LiveStats & TExtra;
    cache = { at: Date.now(), value };
    return value;
  };
}
