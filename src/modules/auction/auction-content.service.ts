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
    options: RandomPublishedAuctionCardOptions
  ): Promise<PublishedAuctionCard | null> {
    const seenPlayerIds = options.excludeRecentlySeenFootballPlayerIds ?? [];
    if (seenPlayerIds.length === 0) return findRandomPublishedAuctionCard(options);

    const fresh = await findRandomPublishedAuctionCard(options);
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
    });
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

// Serve roughly 70% household names, 30% deeper cuts. Uniform picking would
// drift toward unknowns as generation finishes the long €5-25M tail of the
// pool; the weighted roll keeps matches recognisable regardless of pool shape.
const FAME_MIX_WELL_KNOWN_SHARE = 0.7;

async function findRandomPublishedAuctionCard(
  options: RandomPublishedAuctionCardOptions,
  random: () => number = getRandom
): Promise<PublishedAuctionCard | null> {
  if (!options.fameTier) {
    const fameTier: AuctionFameTier =
      random() < FAME_MIX_WELL_KNOWN_SHARE ? 'well_known' : 'lesser_known';
    const tiered = await auctionContentRepo.getRandomPublishedAuctionCard({
      ...options,
      fameTier,
    });
    if (tiered) return attachSeasonSnapshots(mapPublishedAuctionCard(tiered));
    // The rolled tier is exhausted for this position/exclusion set — fall
    // through to the unrestricted pool rather than failing the round.
  }
  const row = await auctionContentRepo.getRandomPublishedAuctionCard(options);
  return row ? attachSeasonSnapshots(mapPublishedAuctionCard(row)) : null;
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

/** A snapshot lot needs history to hide in and a value arc to gamble on. */
const MIN_SNAPSHOT_SEASONS = 3;

async function attachSeasonSnapshots(card: PublishedAuctionCard): Promise<PublishedAuctionCard> {
  const rows = await auctionContentRepo.getSeasonSnapshots(card.footballPlayerId);
  if (rows.length < MIN_SNAPSHOT_SEASONS) return card;

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
  card.league = snapshots[snapshots.length - 1]?.league ?? null;
  card.clues = [
    ...(card.positionGroup === 'GK' ? SNAPSHOT_FACETS_GK : SNAPSHOT_FACETS),
  ];
  return card;
}

export type { AuctionContentLocale };
