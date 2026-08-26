import { logger } from '../../core/logger.js';
import { getRandom } from '../../core/rng.js';
import {
  auctionContentRepo,
  type AuctionContentLocale,
  type AuctionFameTier,
  type PublishedAuctionCardRow,
  type RandomPublishedAuctionCardOptions,
} from './auction-content.repo.js';
import {
  AuctionContentUnavailableError,
  AuctionStartingPriceUnavailableError,
} from './auction.errors.js';
import type { AuctionFootballer, PositionGroup } from './auction.types.js';

export interface PublishedAuctionCard extends AuctionFootballer {
  id: string;
  footballPlayerId: string;
  clueCardId: string;
  transfermarktId: string | null;
  positionLabelEn: string | null;
  positionLabelKa: string | null;
  currentValueEur: number;
  peakValueEur: number | null;
  trueValueEur: number;
  auctionPriceEur: number;
  startingPriceEur: number;
  locale: AuctionContentLocale;
  difficulty: 'easy' | 'medium' | 'hard';
  generationProvider: string | null;
  generationModel: string | null;
  promptVersion: string;
  evidence: unknown;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function requirePositivePrice(
  value: string | number | null,
  field: 'auction_price_eur' | 'starting_price_eur',
  row: PublishedAuctionCardRow
): number {
  const parsed = toNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AuctionStartingPriceUnavailableError({
      code: 'auction_starting_price_unavailable',
      field,
      clue_card_id: row.clue_card_id,
    });
  }
  return parsed;
}

function mapPublishedAuctionCard(row: PublishedAuctionCardRow): PublishedAuctionCard {
  const auctionPriceEur = requirePositivePrice(row.auction_price_eur, 'auction_price_eur', row);
  const startingPriceEur = requirePositivePrice(row.starting_price_eur, 'starting_price_eur', row);
  const currentValueEur = requirePositivePrice(row.current_value_eur, 'auction_price_eur', row);

  return {
    id: row.football_player_id,
    footballPlayerId: row.football_player_id,
    clueCardId: row.clue_card_id,
    transfermarktId: row.transfermarkt_id === null ? null : String(row.transfermarkt_id),
    name: row.name,
    imageUrl: row.image_url,
    positionGroup: row.position_group as PositionGroup,
    positionLabelEn: row.position_label_en,
    positionLabelKa: row.position_label_ka,
    trueValue: auctionPriceEur,
    trueValueEur: auctionPriceEur,
    auctionPriceEur,
    startingPrice: startingPriceEur,
    startingPriceEur,
    currentValueEur,
    peakValueEur: toNumber(row.peak_value_eur),
    currentClub: row.current_club,
    nationality: row.nationality,
    clues: [row.clue_1, row.clue_2, row.clue_3],
    locale: row.locale as AuctionContentLocale,
    difficulty: row.difficulty as PublishedAuctionCard['difficulty'],
    generationProvider: row.generation_provider,
    generationModel: row.generation_model,
    promptVersion: row.prompt_version,
    evidence: row.evidence,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertPublishedAuctionContentAvailable(locale: AuctionContentLocale): Promise<void> {
  const availability = await auctionContentRepo.getPublishedCardAvailability(locale);

  if (availability.usable_count > 0) return;

  if (availability.base_count > 0 && availability.missing_price_count > 0) {
    throw new AuctionStartingPriceUnavailableError({
      code: 'auction_starting_price_unavailable',
      locale,
      ...availability,
    });
  }

  throw new AuctionContentUnavailableError({
    code: 'auction_content_unavailable',
    locale,
    ...availability,
  });
}

export const auctionContentService = {
  async getPublishedCardCount(locale: AuctionContentLocale): Promise<number> {
    return auctionContentRepo.getPublishedCardCount(locale);
  },

  async getRandomPublishedAuctionCard(
    options: RandomPublishedAuctionCardOptions
  ): Promise<PublishedAuctionCard> {
    const card = await findRandomPublishedAuctionCard(options);
    if (!card) {
      await assertPublishedAuctionContentAvailable(options.locale);
      throw new AuctionContentUnavailableError({
        code: 'auction_content_unavailable',
        locale: options.locale,
        position_group: options.positionGroup ?? null,
        excluded_clue_card_count: options.excludeClueCardIds?.length ?? 0,
      });
    }

    return card;
  },

  /**
   * Match-flow lookup where `null` has one precise meaning: the filtered pool
   * (position + already-used exclusions) is exhausted. Repository/DB failures
   * still reject, allowing the realtime layer to retry without mistaking an
   * outage for a legitimate end-of-match condition.
   */
  findRandomPublishedAuctionCard,

  /**
   * Cross-match no-repeat pick. Applies the recently-seen footballer exclusion
   * first. If that exhausts the pool, it retries with the same history ordered
   * least-recently-seen first, rather than discarding the history signal.
   */
  async findRandomPublishedAuctionCardExcludingSeen(
    options: RandomPublishedAuctionCardOptions,
    random: () => number = getRandom
  ): Promise<PublishedAuctionCard | null> {
    const seenPlayerIds = options.excludeRecentlySeenFootballPlayerIds ?? [];
    if (seenPlayerIds.length === 0) return findRandomPublishedAuctionCard(options, random);

    const fresh = await findRandomPublishedAuctionCard(options, random);
    if (fresh) return fresh;
    logger.info(
      {
        locale: options.locale,
        positionGroup: options.positionGroup ?? null,
        excludedSeenPlayerCount: seenPlayerIds.length,
        excludedUsedCount: options.excludeClueCardIds?.length ?? 0,
      },
      'Auction card pool empty with cross-match history excluded; choosing least-recently-seen player'
    );

    return findRandomPublishedAuctionCard({
      ...options,
      excludeRecentlySeenFootballPlayerIds: undefined,
      preferLeastRecentlySeenFootballPlayerIds:
        seenPlayerIds.length > 0 ? seenPlayerIds : undefined,
    }, random);
  },

  getRecentlySeenFootballPlayerIds: auctionContentRepo.getRecentlySeenFootballPlayerIds,
  recordSeenClueCards: auctionContentRepo.recordSeenClueCards,

  async getPublishedAuctionCardById(clueCardId: string): Promise<PublishedAuctionCard> {
    const row = await auctionContentRepo.getPublishedAuctionCardById(clueCardId);
    if (!row) {
      throw new AuctionContentUnavailableError({
        code: 'auction_content_unavailable',
        clue_card_id: clueCardId,
      });
    }
    return mapPublishedAuctionCard(row);
  },

  assertPublishedAuctionContentAvailable,
};

// Serve roughly 80% household names, 20% deeper cuts (raised from 70/30 on
// 2026-08-26 after player feedback that lots skewed obscure). Uniform picking
// would drift toward unknowns as generation finishes the long €5-25M tail of
// the pool; the weighted roll keeps matches recognisable regardless of pool
// shape. The ≥€25M fame threshold stays put: goalkeepers have only ~20 cards
// above it, so raising the BAR (rather than the share) would loop the same
// few GK names.
const FAME_MIX_WELL_KNOWN_SHARE = 0.9;
// Within the famous 80%, this fraction of the WHOLE roll prefers VETERAN
// famous players (age 29+) whose cards carry 2010-2018 scout seasons — the
// era spread owners asked for (roll < 0.32 veteran-famous, < 0.9 famous,
// else lesser-known — i.e. 32% / 58% / 10%).
const FAME_MIX_VETERAN_SHARE = 0.32;

async function findRandomPublishedAuctionCard(
  options: RandomPublishedAuctionCardOptions,
  random: () => number = getRandom
): Promise<PublishedAuctionCard | null> {
  // Stats-only is a product invariant. A card whose snapshot lookup comes back
  // thin (view/table drift, degraded DB read) must NEVER fall through in the
  // legacy text-clue format — skip it and try another candidate instead.
  for (let attempt = 0; attempt < AUCTION_SNAPSHOT_CARD_ATTEMPTS; attempt += 1) {
    let row: PublishedAuctionCardRow | null;
    if (!options.fameTier) {
      const roll = random();
      const fameTier: AuctionFameTier =
        roll < FAME_MIX_WELL_KNOWN_SHARE ? 'well_known' : 'lesser_known';
      const veteranEra = roll < FAME_MIX_VETERAN_SHARE;
      row = await auctionContentRepo.getRandomPublishedAuctionCard({
        ...options,
        fameTier,
        ...(veteranEra ? { veteranEra } : {}),
      });
      // Veteran slice exhausted for this position (GK has only ~21 such
      // cards) — retry the plain famous tier before going unrestricted.
      if (!row && veteranEra) {
        row = await auctionContentRepo.getRandomPublishedAuctionCard({ ...options, fameTier });
      }
      // The rolled tier is exhausted for this position/exclusion set — fall
      // through to the unrestricted pool rather than failing the round.
      if (!row) {
        row = await auctionContentRepo.getRandomPublishedAuctionCard(options);
      }
    } else {
      row = await auctionContentRepo.getRandomPublishedAuctionCard(options);
    }
    if (!row) return null;

    const card = await attachSeasonSnapshots(mapPublishedAuctionCard(row), random, options.scoutCycleUserIds);
    if (card.snapshots && card.snapshots.length >= MIN_SNAPSHOT_SEASONS) return card;

    logger.warn(
      { footballPlayerId: card.footballPlayerId, clueCardId: card.clueCardId, locale: options.locale },
      'Auction candidate lacks season snapshots; skipping (stats-only invariant)'
    );
  }
  return null;
}

// The web client's LEAGUES catalogue uses display names; the snapshot table
// stores Transfermarkt competition slugs. Map the leagues the client knows,
// title-case the rest (display-only there; chemistry matches on raw strings).
const LEAGUE_DISPLAY_NAMES: Record<string, string> = {
  'premier-league': 'Premier League',
  laliga: 'La Liga',
  'serie-a': 'Serie A',
  bundesliga: 'Bundesliga',
  'ligue-1': 'Ligue 1',
  eredivisie: 'Eredivisie',
  'liga-portugal': 'Primeira Liga',
  'liga-portugal-bwin': 'Primeira Liga',
  'campeonato-brasileiro-serie-a': 'Brasileirão',
  'scottish-premiership': 'Scottish Premiership',
  'primera-division-de-argentina': 'Primera División',
};

export function displayLeagueName(slug: string): string {
  const known = LEAGUE_DISPLAY_NAMES[slug.toLowerCase()];
  if (known) return known;
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Reveal-step labels for snapshot lots. Content is rendered client-side from
// the snapshot; these keep the reveal cadence at five steps and read sensibly
// on any client that falls back to plain clue text.
const SNAPSHOT_FACETS = ['Goals', 'Assists', 'Market value', 'Age', 'League'] as const;
const SNAPSHOT_FACETS_GK = ['Clean sheets', 'Goals conceded', 'Market value', 'Age', 'League'] as const;

/** Authored text hints revealed after the stat facets (clue_1 and clue_2). */
export const AUCTION_TEXT_HINTS_PER_LOT = 2;

/** A lot may open at most this fraction of its hidden current value: buying
 *  at the opening price must never be a built-in loss. Mirrors the ≤90% cap
 *  the pricing view applies to its own fallback season pick. */
export const AUCTION_MAX_OPENING_VALUE_RATIO = 0.9;

/** A snapshot lot needs history to hide in and a value arc to gamble on. */
const MIN_SNAPSHOT_SEASONS = 3;

/** Candidate redraws before a selection gives up rather than serving a
 *  snapshot-less card. Small: the SQL predicate already filters to
 *  snapshot-ready players, so a miss means drift between view and table. */
const AUCTION_SNAPSHOT_CARD_ATTEMPTS = 4;

/** Stable per-player offset so all players don't start their season rotation
 *  at the same career point. Salted server-side: player UUIDs are public after
 *  reveal, and an unsalted offset would let players precompute (and
 *  crowd-source) which season a first encounter shows. */
const SCOUT_CYCLE_SALT = process.env.AUCTION_SCOUT_CYCLE_SALT?.trim() || 'qb-scout-cycle-v1';

function scoutCycleOffset(footballPlayerId: string): number {
  let hash = 0;
  for (const char of `${footballPlayerId}:${SCOUT_CYCLE_SALT}`) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

async function attachSeasonSnapshots(
  card: PublishedAuctionCard,
  random: () => number = getRandom,
  scoutCycleUserIds?: string[]
): Promise<PublishedAuctionCard> {
  const allRows = await auctionContentRepo.getSeasonSnapshots(card.footballPlayerId);
  if (allRows.length < MIN_SNAPSHOT_SEASONS) return card;

  // Vary the SCOUT season instead of always showing the earliest one: the same
  // player then presents different numbers across matches, so repeat
  // encounters can't be memorised. Any season with at least two later seasons
  // is eligible (keeps a real gap to gamble across); the final season always
  // stays the scoring season.
  //
  // With human context, rotate ranked-style: every repeat encounter advances
  // one season, so NO season repeats until all of them have been shown (then
  // the cycle wraps). Without context (previews, tooling), fall back to a
  // uniform roll.
  const maxScoutIndex = allRows.length - MIN_SNAPSHOT_SEASONS;
  const cycleLength = maxScoutIndex + 1;
  let scoutIndex: number;
  if (scoutCycleUserIds?.length) {
    // Claim-on-read: the upsert both increments and returns the cursor in one
    // statement, so overlapping selections can never serve the same season.
    const claimed = await auctionContentRepo
      .claimScoutEncounter(scoutCycleUserIds, card.footballPlayerId)
      .catch((error) => {
        // Degraded, not broken: selection proceeds at the player's fixed
        // initial season — but SAY so, or a failing counter would silently
        // turn the whole rotation into permanent repeats.
        logger.warn(
          { error, footballPlayerId: card.footballPlayerId },
          'Auction scout-encounter claim failed; serving initial scout season'
        );
        return 0;
      });
    const seenCount = Math.max(0, claimed - 1);
    scoutIndex = (scoutCycleOffset(card.footballPlayerId) + seenCount) % cycleLength;
  } else {
    scoutIndex = Math.min(maxScoutIndex, Math.floor(random() * cycleLength));
  }
  const rows = allRows.slice(scoutIndex);

  const snapshots = rows.map((row, index) => ({
    season: row.season_label,
    league: displayLeagueName(row.league_name),
    age: row.age,
    apps: row.apps,
    goals: row.goals,
    assists: row.assists ?? undefined,
    cleanSheets: row.clean_sheets ?? undefined,
    conceded: row.goals_conceded ?? undefined,
    // The final season is the scoring season: pin its value to the server's
    // trueValue so client profit math and server rankings can never disagree.
    valueEur: index === rows.length - 1 ? card.trueValue : Number(row.value_eur),
  }));

  card.snapshots = snapshots;

  // The lot opens at the scout season's REAL market value — the exact figure
  // the card itself shows ("buy him at his {scout season} price"; profit is
  // what he became by the scoring season) — but ONLY when that price leaves
  // bidding headroom. A veteran's glory-season price sits ABOVE his hidden
  // current value (42% of draws under the fame mix), which made buying at
  // the opening a guaranteed loss: bots estimated the decline and passed,
  // humans anchored on the displayed price and bled (prod 2026-08-26: median
  // human profit −50M, 1 win in 41). Overpriced lots instead keep the view's
  // starting_price_eur — a different real career season already capped at
  // the same ratio — so every opening is a live deal and the auction stays a
  // "how much MORE is he worth" contest.
  const scoutValue = snapshots[0]?.valueEur;
  if (
    Number.isFinite(scoutValue)
    && scoutValue > 0
    && scoutValue <= AUCTION_MAX_OPENING_VALUE_RATIO * card.trueValue
  ) {
    card.startingPrice = Math.floor(scoutValue);
    card.startingPriceEur = Math.floor(scoutValue);
  }

  card.league = snapshots[snapshots.length - 1]?.league ?? null;
  // Reveal steps: the five stat facets, then up to two of the card's authored
  // text hints (clue_1/clue_2, already in the match locale). The hint TEXTS
  // ride the existing revealedClues pacing — the client receives each string
  // only when its step is revealed, exactly like the facet labels before them.
  // 721 cards per locale carry facet LABELS ("Goals", "გოლები", ...) in their
  // clue columns — placeholder rows from the stats pivot, not authored hints.
  // A real hint is a sentence; the length floor filters the labels out, and a
  // card without authored hints simply serves the five stat facets alone.
  const authoredClues = (card.clues ?? [])
    .filter((text): text is string => typeof text === 'string' && text.trim().length >= 25)
    .slice(0, AUCTION_TEXT_HINTS_PER_LOT);
  card.clues = [
    ...(card.positionGroup === 'GK' ? SNAPSHOT_FACETS_GK : SNAPSHOT_FACETS),
    ...authoredClues,
  ];
  return card;
}

export type { AuctionContentLocale };
