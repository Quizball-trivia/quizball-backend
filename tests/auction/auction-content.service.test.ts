import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/auction/auction-content.repo.js', () => ({
  auctionContentRepo: {
    getPublishedCardCount: vi.fn(),
    getPublishedCardAvailability: vi.fn(),
    getRandomPublishedAuctionCard: vi.fn(),
    getSeasonSnapshots: vi.fn(),
    claimScoutEncounter: vi.fn(async () => 0),
    getPublishedAuctionCardById: vi.fn(),
    getRecentlySeenFootballPlayerIds: vi.fn(),
    recordSeenClueCards: vi.fn(),
  },
  AUCTION_CARD_HISTORY_WINDOW_DAYS: 14,
}));

import { auctionContentRepo, type PublishedAuctionCardRow } from '../../src/modules/auction/auction-content.repo.js';
import { AuctionContentErrorCode } from '../../src/modules/auction/auction.errors.js';
import { auctionContentService } from '../../src/modules/auction/auction-content.service.js';

const CLUE_CARD_ID = '11111111-1111-1111-1111-111111111111';
const PLAYER_ID = '22222222-2222-2222-2222-222222222222';
const SEEN_PLAYER_ID = '33333333-3333-3333-3333-333333333333';

const basePublishedCard = {
  clue_card_id: CLUE_CARD_ID,
  football_player_id: PLAYER_ID,
  transfermarkt_id: 123,
  name: 'Erling Haaland',
  image_url: 'https://img.example/haaland.jpg',
  position_group: 'FWD',
  position_label_en: 'Forward',
  position_label_ka: 'ფორვარდი',
  current_club: 'Manchester City',
  nationality: 'Norway',
  current_value_eur: 180_000_000,
  peak_value_eur: 200_000_000,
  locale: 'en',
  clue_1: 'Scored heavily in his first Premier League campaign.',
  clue_2: 'Won the Champions League with a Manchester club.',
  clue_3: 'Represents Norway at international level.',
  difficulty: 'easy',
  status: 'published',
  source: 'generated',
  generation_provider: 'openrouter',
  generation_model: 'google/gemini-3-flash-preview',
  prompt_version: 'v2-openrouter-localgate',
  evidence: { local_quality_passed: true },
  review_notes: null,
  created_at: '2026-06-20T00:00:00.000Z',
  updated_at: '2026-06-20T00:00:00.000Z',
  auction_price_eur: 180_000_000,
  starting_price_eur: 30_000_000,
} satisfies PublishedAuctionCardRow;

/** Stats-only world: served cards carry ≥3 valued seasons. The invariant test
 *  overrides this to prove thin lookups get SKIPPED, never served as text. */
const DEFAULT_SEASON_ROWS = [
  { season_label: '2023/24', league_name: 'premier-league', age: 23, apps: 30, goals: 20, assists: 5, clean_sheets: null, goals_conceded: null, value_eur: 120_000_000 },
  { season_label: '2024/25', league_name: 'premier-league', age: 24, apps: 32, goals: 28, assists: 7, clean_sheets: null, goals_conceded: null, value_eur: 150_000_000 },
  { season_label: '2025/26', league_name: 'premier-league', age: 25, apps: 31, goals: 26, assists: 6, clean_sheets: null, goals_conceded: null, value_eur: 180_000_000 },
];

describe('auctionContentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue(DEFAULT_SEASON_ROWS);
  });

  it('maps published card rows to runtime footballer units and currency fields', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result).toMatchObject({
      id: PLAYER_ID,
      footballPlayerId: PLAYER_ID,
      clueCardId: CLUE_CARD_ID,
      transfermarktId: '123',
      name: 'Erling Haaland',
      positionGroup: 'FWD',
      trueValue: 180_000_000,
      trueValueEur: 180_000_000,
      currentValueEur: 180_000_000,
      imageUrl: 'https://img.example/haaland.jpg',
    });
    // The lot opens at the SCOUT season's real market value — the figure the
    // card itself shows — when it leaves bidding headroom (≤90% of trueValue).
    expect(result.startingPrice).toBe(result.snapshots![0].valueEur);
    expect(result.startingPriceEur).toBe(result.snapshots![0].valueEur);
    // Reveal steps: the five stat facets, then the card's first two authored
    // text hints (paced like facets — each string travels only when revealed).
    expect(result.clues).toEqual([
      'Goals', 'Assists', 'Market value', 'Age', 'League',
      basePublishedCard.clue_1, basePublishedCard.clue_2,
    ]);
    expect(result.snapshots).toHaveLength(3);
  });

  it('never serves a text-clue card when snapshots are thin — skips to another candidate', async () => {
    // Two candidates come back without enough season history (view/table
    // drift or a degraded read); the invariant demands they be skipped, not
    // served in the legacy text-clue format.
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(DEFAULT_SEASON_ROWS.slice(0, 2))
      .mockResolvedValue(DEFAULT_SEASON_ROWS);

    const result = await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
    });

    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(3);
    expect(result?.clues).toEqual([
      'Goals', 'Assists', 'Market value', 'Age', 'League',
      basePublishedCard.clue_1, basePublishedCard.clue_2,
    ]);
    expect(result?.snapshots).toHaveLength(3);
  });

  it('throws a typed no-content error when there are no published usable rows', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(null);
    (auctionContentRepo.getPublishedCardAvailability as Mock).mockResolvedValue({
      base_count: 0,
      usable_count: 0,
      missing_price_count: 0,
    });

    await expect(
      auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' })
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.CONTENT_UNAVAILABLE,
    });
  });

  it('returns null from the match-flow lookup only when the filtered pool is exhausted', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(null);

    await expect(
      auctionContentService.findRandomPublishedAuctionCard({
        locale: 'en',
        positionGroup: 'FWD',
        excludeClueCardIds: [CLUE_CARD_ID],
      })
    ).resolves.toBeNull();
    expect(auctionContentRepo.getPublishedCardAvailability).not.toHaveBeenCalled();
  });

  it('throws a typed price error when published rows are missing price fields', async () => {
    (auctionContentRepo.getPublishedCardAvailability as Mock).mockResolvedValue({
      base_count: 1,
      usable_count: 0,
      missing_price_count: 1,
    });

    await expect(
      auctionContentService.assertPublishedAuctionContentAvailable('en')
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('rejects a returned row with a missing starting price instead of inventing a fallback', async () => {
    (auctionContentRepo.getPublishedAuctionCardById as Mock).mockResolvedValue({
      ...basePublishedCard,
      starting_price_eur: null,
    });

    await expect(
      auctionContentService.getPublishedAuctionCardById(CLUE_CARD_ID)
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('rejects a returned row with a missing true auction price instead of using current value fallback', async () => {
    (auctionContentRepo.getPublishedAuctionCardById as Mock).mockResolvedValue({
      ...basePublishedCard,
      auction_price_eur: null,
    });

    await expect(
      auctionContentService.getPublishedAuctionCardById(CLUE_CARD_ID)
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('passes position filters and used card exclusions through to the repo', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    await auctionContentService.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
    });

    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: 'en',
        positionGroup: 'FWD',
        excludeClueCardIds: [CLUE_CARD_ID],
      })
    );
  });

  it('rolls the fame mix: 32% veteran-famous, 58% famous, 10% lesser known', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    // Low roll: famous tier with the veteran-era bias (2010s scout seasons).
    await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' }, () => 0.1);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ fameTier: 'well_known', veteranEra: true })
    );

    await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' }, () => 0.89);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ fameTier: 'well_known' })
    );
    expect((auctionContentRepo.getRandomPublishedAuctionCard as Mock).mock.lastCall?.[0]).not.toHaveProperty('veteranEra');

    await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' }, () => 0.9);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ fameTier: 'lesser_known' })
    );

    // Rolled tier exhausted → the retry must be unrestricted, not the other tier.
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(basePublishedCard);
    const result = await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' }, () => 0.5);
    expect(result).toMatchObject({ clueCardId: CLUE_CARD_ID });
    const calls = (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mock.calls;
    expect(calls[calls.length - 1][0].fameTier).toBeUndefined();

    // Veteran slice exhausted → fall back to plain famous, THEN unrestricted.
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock)
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(basePublishedCard);
    await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' }, () => 0.1);
    const chain = (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mock.calls.map((c) => [c[0].fameTier, c[0].veteranEra]);
    expect(chain).toEqual([
      ['well_known', true],
      ['well_known', undefined],
      [undefined, undefined],
    ]);
  });

  it('respects an explicit fameTier without re-rolling', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    await auctionContentService.findRandomPublishedAuctionCard({ locale: 'en', fameTier: 'lesser_known' });

    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(1);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({ fameTier: 'lesser_known' })
    );
  });

  it('excludes cross-match recently-seen footballers when the filtered pool still has content', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    const result = await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
      excludeRecentlySeenFootballPlayerIds: [SEEN_PLAYER_ID],
    });

    expect(result).toMatchObject({ clueCardId: CLUE_CARD_ID });
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(1);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeRecentlySeenFootballPlayerIds: [SEEN_PLAYER_ID],
      })
    );
  });

  it('falls back to the least-recently-seen footballer when the fresh pool runs dry', async () => {
    // Fresh pool dry = tiered AND unrestricted picks return nothing; the
    // history retry then hits (tiered first) and succeeds.
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(basePublishedCard);

    const result = await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
      excludeRecentlySeenFootballPlayerIds: [SEEN_PLAYER_ID],
    }, () => 0.5);

    // Never fails the round: falls back to a repeat rather than returning null.
    expect(result).toMatchObject({ clueCardId: CLUE_CARD_ID });
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(3);
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        excludeRecentlySeenFootballPlayerIds: undefined,
        preferLeastRecentlySeenFootballPlayerIds: [SEEN_PLAYER_ID],
        // The in-match exclusion is NEVER dropped — only the history one.
        excludeClueCardIds: [CLUE_CARD_ID],
      })
    );
  });

  it('does not run the history retry when there is no history to exclude', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(null);

    const result = await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
    }, () => 0.5);

    expect(result).toBeNull();
    // Tiered pick + unrestricted fallback only — no third history-based query.
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(2);
  });

  it('leaves the difficulty seam off by default', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
      positionGroup: 'FWD',
    });

    const [options] = (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mock.calls[0];
    expect(options.preferredDifficulty).toBeUndefined();
  });

  it('forwards an explicit preferred difficulty to the repo', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
      locale: 'en',
      positionGroup: 'FWD',
      preferredDifficulty: 'hard',
    });

    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({ preferredDifficulty: 'hard' })
    );
  });

  it('prices the lot at the scout season value, ignoring the view starting price', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue({
      ...basePublishedCard,
      starting_price_eur: 10_000_000,
    });

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result.startingPrice).toBe(result.snapshots![0].valueEur);
    expect(result.startingPrice).not.toBe(10_000_000);
    expect(result.trueValue).toBe(180_000_000);
  });

  it('keeps the view starting price when the scout season opens above 90% of the hidden value', async () => {
    // Declined veteran: glory-season value dwarfs today's. Opening at the
    // scout price would make buying a guaranteed loss, so the capped view
    // fallback must win.
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue({
      ...basePublishedCard,
      auction_price_eur: 4_000_000,
      current_value_eur: 4_000_000,
      starting_price_eur: 1_500_000,
    });
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue([
      { season_label: '2015/16', league_name: 'bundesliga', age: 26, apps: 31, goals: 20, assists: 12, clean_sheets: null, goals_conceded: null, value_eur: 75_000_000 },
      { season_label: '2020/21', league_name: 'bundesliga', age: 31, apps: 32, goals: 11, assists: 18, clean_sheets: null, goals_conceded: null, value_eur: 30_000_000 },
      { season_label: '2025/26', league_name: 'mls', age: 36, apps: 25, goals: 6, assists: 8, clean_sheets: null, goals_conceded: null, value_eur: 4_000_000 },
    ]);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result.snapshots![0].valueEur).toBe(75_000_000);
    expect(result.startingPrice).toBe(1_500_000);
    expect(result.startingPriceEur).toBe(1_500_000);
    expect(result.trueValue).toBe(4_000_000);
  });

  it('accepts a scout price exactly at 90% of the hidden value (inclusive cap)', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue([
      { season_label: '2023/24', league_name: 'premier-league', age: 23, apps: 30, goals: 20, assists: 5, clean_sheets: null, goals_conceded: null, value_eur: '162000000' },
      { season_label: '2024/25', league_name: 'premier-league', age: 24, apps: 32, goals: 28, assists: 7, clean_sheets: null, goals_conceded: null, value_eur: 150_000_000 },
      { season_label: '2025/26', league_name: 'premier-league', age: 25, apps: 31, goals: 26, assists: 6, clean_sheets: null, goals_conceded: null, value_eur: 180_000_000 },
    ]);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    // 162M === 0.9 * 180M — the boundary must be ACCEPTED, and a string-typed
    // value_eur row must survive the numeric comparison.
    expect(result.startingPrice).toBe(162_000_000);
  });

  it('falls back when the scout price is just above the cap on a rising career', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue([
      { season_label: '2023/24', league_name: 'premier-league', age: 23, apps: 30, goals: 20, assists: 5, clean_sheets: null, goals_conceded: null, value_eur: 171_000_000 },
      { season_label: '2024/25', league_name: 'premier-league', age: 24, apps: 32, goals: 28, assists: 7, clean_sheets: null, goals_conceded: null, value_eur: 175_000_000 },
      { season_label: '2025/26', league_name: 'premier-league', age: 25, apps: 31, goals: 26, assists: 6, clean_sheets: null, goals_conceded: null, value_eur: 180_000_000 },
    ]);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    // 171M is 95% of 180M — above the 90% cap, so the view price must win.
    expect(result.startingPrice).toBe(30_000_000);
  });

  const snapshotRows = [
    { season_label: '2020/21', league_name: 'laliga', age: 19, apps: 20, goals: 3, assists: 1, clean_sheets: null, goals_conceded: null, value_eur: '5000000' },
    { season_label: '2021/22', league_name: 'laliga', age: 20, apps: 30, goals: 8, assists: 4, clean_sheets: null, goals_conceded: null, value_eur: '20000000' },
    { season_label: '2025/26', league_name: 'liga-portugal', age: 24, apps: 31, goals: 3, assists: 9, clean_sheets: null, goals_conceded: null, value_eur: '29000000' },
  ];

  it('attaches season snapshots: facet + hint clues, display league, last value pinned to trueValue', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue(snapshotRows);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result.snapshots).toHaveLength(3);
    expect(result.snapshots![0]).toMatchObject({ season: '2020/21', league: 'La Liga', valueEur: 5_000_000 });
    // The scoring season's value is pinned to the server trueValue so client
    // profit math can never diverge from the ranked score.
    expect(result.snapshots!.at(-1)).toMatchObject({ season: '2025/26', league: 'Primeira Liga', valueEur: result.trueValue });
    expect(result.league).toBe('Primeira Liga');
    expect(result.clues).toEqual([
      'Goals', 'Assists', 'Market value', 'Age', 'League',
      basePublishedCard.clue_1, basePublishedCard.clue_2,
    ]);
  });

  it('rolls the scout season across the career window (final season always scores)', async () => {
    const fiveSeasons = [
      { season_label: '2018/19', league_name: 'laliga', age: 17, apps: 12, goals: 1, assists: 0, clean_sheets: null, goals_conceded: null, value_eur: '2000000' },
      { season_label: '2019/20', league_name: 'laliga', age: 18, apps: 22, goals: 4, assists: 2, clean_sheets: null, goals_conceded: null, value_eur: '4000000' },
      ...snapshotRows,
    ];
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue(fiveSeasons);

    // fameTier pinned so the injected RNG is consumed by the scout roll only.
    const low = await auctionContentService.findRandomPublishedAuctionCard(
      { locale: 'en', fameTier: 'well_known' },
      () => 0
    );
    expect(low!.snapshots).toHaveLength(5);
    expect(low!.snapshots![0].season).toBe('2018/19');

    const high = await auctionContentService.findRandomPublishedAuctionCard(
      { locale: 'en', fameTier: 'well_known' },
      () => 0.99
    );
    // Highest roll starts the window at the latest eligible scout season —
    // always leaving MIN_SNAPSHOT_SEASONS in the served arc.
    expect(high!.snapshots).toHaveLength(3);
    expect(high!.snapshots![0].season).toBe('2020/21');
    expect(high!.snapshots!.at(-1)).toMatchObject({ season: '2025/26', valueEur: high!.trueValue });
  });

  it('cycles the scout season per human without repeats until every season is shown', async () => {
    const fiveSeasons = [
      { season_label: '2018/19', league_name: 'laliga', age: 17, apps: 12, goals: 1, assists: 0, clean_sheets: null, goals_conceded: null, value_eur: '2000000' },
      { season_label: '2019/20', league_name: 'laliga', age: 18, apps: 22, goals: 4, assists: 2, clean_sheets: null, goals_conceded: null, value_eur: '4000000' },
      ...snapshotRows,
    ];
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue(fiveSeasons);

    const userIds = ['44444444-4444-4444-4444-444444444444'];
    const scoutSeasonAtSeenCount = async (seenCount: number) => {
      (auctionContentRepo.claimScoutEncounter as Mock).mockResolvedValue(seenCount + 1);
      const card = await auctionContentService.findRandomPublishedAuctionCard(
        { locale: 'en', fameTier: 'well_known', scoutCycleUserIds: userIds },
        // RNG must be ignored on the cycling path — a varying roll proves it.
        () => 0.42
      );
      return card!.snapshots![0].season;
    };

    // 3 eligible scout seasons → 3 consecutive encounters show 3 DISTINCT
    // seasons, then the cycle wraps to the first one again.
    const first = await scoutSeasonAtSeenCount(0);
    const second = await scoutSeasonAtSeenCount(1);
    const third = await scoutSeasonAtSeenCount(2);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(await scoutSeasonAtSeenCount(3)).toBe(first);
    expect(auctionContentRepo.claimScoutEncounter).toHaveBeenCalledWith(userIds, PLAYER_ID);
  });

  it('throws content-unavailable when EVERY candidate lacks snapshots (stats-only pool)', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);
    (auctionContentRepo.getSeasonSnapshots as Mock).mockResolvedValue(snapshotRows.slice(0, 2));

    // Stats-only invariant: thin-history candidates are never served in the
    // text-clue format — the lookup exhausts its redraws and reports empty.
    await expect(
      auctionContentService.findRandomPublishedAuctionCard({ locale: 'en' })
    ).resolves.toBeNull();
    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledTimes(4);
  });
});
