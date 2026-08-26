import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { POSITION_GROUPS } from './auction.constants.js';
import type { PositionGroup } from './auction.types.js';

export type AuctionContentLocale = 'en' | 'ka';
export type AuctionContentDifficulty = 'easy' | 'medium' | 'hard';

/**
 * Difficulty-aware selection seam. Cards will soon carry richer prompt versions
 * (`v3-rich-medium` / `v3-rich-hard`); when a preferred difficulty is provided
 * we bias the pick toward the matching prompt_version pattern, falling back to
 * ANY card if none match. Game rules are NOT wired to this yet — this only adds
 * the plumbing so a later change can pass a preference without a schema change.
 */
export type AuctionPreferredDifficulty = 'medium' | 'hard';

const PROMPT_VERSION_PATTERN_BY_DIFFICULTY: Record<AuctionPreferredDifficulty, string> = {
  medium: 'v3-rich-medium%',
  hard: 'v3-rich-hard%',
};

/**
 * Cross-match no-repeat window: don't re-serve a footballer a player saw within
 * this many days, regardless of which locale or card variant was shown.
 */
export const AUCTION_CARD_HISTORY_WINDOW_DAYS = 14;

export interface SeasonSnapshotRow {
  season_label: string;
  league_name: string;
  age: number | null;
  apps: number;
  goals: number;
  assists: number | null;
  clean_sheets: number | null;
  goals_conceded: number | null;
  value_eur: number | string;
}

export interface PublishedAuctionCardRow {
  clue_card_id: string;
  football_player_id: string;
  transfermarkt_id: string | number | null;
  name: string;
  image_url: string | null;
  position_group: string | null;
  position_label_en: string | null;
  position_label_ka: string | null;
  current_club: string | null;
  nationality: string | null;
  current_value_eur: string | number | null;
  peak_value_eur: string | number | null;
  locale: string;
  clue_1: string;
  clue_2: string;
  clue_3: string;
  difficulty: string;
  status: string;
  source: string;
  generation_provider: string | null;
  generation_model: string | null;
  prompt_version: string;
  evidence: Json;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
  auction_price_eur: string | number | null;
  starting_price_eur: string | number | null;
  active_status: string;
}

export interface PublishedAuctionContentAvailability {
  base_count: number;
  usable_count: number;
  missing_price_count: number;
}

export interface RandomPublishedAuctionCardOptions {
  locale: AuctionContentLocale;
  positionGroup?: PositionGroup;
  /**
   * Card IDs already used in this match. The repository resolves them to their
   * football players so another locale/variant cannot repeat the same player.
   */
  excludeClueCardIds?: string[];
  /**
   * Soft exclusion: footballers the match's human participants have seen in
   * recent matches (cross-match no-repeat across locales and card variants).
   */
  excludeRecentlySeenFootballPlayerIds?: string[];
  /**
   * Humans whose seen-history drives the scout-season rotation: each repeat
   * encounter of the same player advances to the next career season, so no
   * season repeats until all of them have been shown (ranked-style no-repeat).
   */
  scoutCycleUserIds?: string[];
  /**
   * Exhausted-pool fallback, ordered least-recently-seen first. This preserves
   * recency as a ranking signal instead of reverting to an unweighted repeat.
   */
  preferLeastRecentlySeenFootballPlayerIds?: string[];
  /**
   * Difficulty-aware seam (default off). When set, biases the pick toward cards
   * whose prompt_version matches the difficulty pattern; falls back to ANY card
   * if none match. Not yet wired to game rules.
   */
  preferredDifficulty?: AuctionPreferredDifficulty;
  /**
   * Fame-mix seam: restrict the pick to household names (>= the fame value
   * threshold) or the deeper cuts below it. Callers roll the 70/30 mix and
   * fall back to the unrestricted pool when a tier is exhausted.
   */
  fameTier?: AuctionFameTier;
  /**
   * Bias the draw toward VETERAN famous players (age 29+): their long careers
   * put 2010-2018 scout seasons on the card, so matches aren't wall-to-wall
   * 2021-generation (owner feedback 2026-08-26). 226 such cards exist
   * (58 DEF / 75 FWD / 72 MID / 21 GK) — callers must fall back to the plain
   * famous tier when this thins out for a position.
   */
  veteranEra?: boolean;
}

export type AuctionFameTier = 'well_known' | 'lesser_known';

/**
 * Market value is the fame proxy we have for every player. €25M keeps the
 * "well known" pool at recognisable-starter level (~160 players today) while
 * the long tail of €5-25M players fills the lesser-known 30%.
 */
export const AUCTION_WELL_KNOWN_VALUE_EUR = 25_000_000;
/** A career peak this high keeps a faded veteran in the famous tier. */
export const AUCTION_WELL_KNOWN_PEAK_VALUE_EUR = 30_000_000;

const publishedEligiblePredicate = sql`
  status = 'published'
  AND active_status = 'active'
  AND image_url IS NOT NULL
  AND current_value_eur IS NOT NULL
  AND position_group IN ('GK', 'DEF', 'MID', 'FWD')
`;

const usablePricePredicate = sql`
  auction_price_eur IS NOT NULL
  AND starting_price_eur IS NOT NULL
`;

// Snapshot lots only: every served player must have enough valued season
// history to run the scouting-snapshot reveal (product rule — no text-clue
// lots). Mirrors MIN_SNAPSHOT_SEASONS in auction-content.service.
const snapshotReadyPredicate = sql`
  football_player_id IN (
    SELECT football_player_id
    FROM player_season_snapshots
    WHERE value_eur IS NOT NULL
    GROUP BY football_player_id
    HAVING count(*) >= 3
  )
`;

function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

export const auctionContentRepo = {
  async getPublishedCardCount(locale: AuctionContentLocale): Promise<number> {
    // Mirrors EVERY hard filter of the selection query (incl. snapshot
    // readiness) — an availability gate that passes cards selection would
    // reject lets matchmaking start unfillable matches.
    const [row] = await sql<{ count: string | number }[]>`
      SELECT COUNT(*)::text AS count
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND ${usablePricePredicate}
        AND ${snapshotReadyPredicate}
        AND locale = ${locale}
    `;

    return parseCount(row?.count);
  },

  async getPublishedCardAvailability(locale: AuctionContentLocale): Promise<PublishedAuctionContentAvailability> {
    const [row] = await sql<{
      base_count: string | number;
      usable_count: string | number;
      missing_price_count: string | number;
    }[]>`
      SELECT
        COUNT(*)::text AS base_count,
        COUNT(*) FILTER (
          WHERE ${usablePricePredicate}
            AND ${snapshotReadyPredicate}
        )::text AS usable_count,
        COUNT(*) FILTER (
          WHERE NOT (${usablePricePredicate})
        )::text AS missing_price_count
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND locale = ${locale}
    `;

    return {
      base_count: parseCount(row?.base_count),
      usable_count: parseCount(row?.usable_count),
      missing_price_count: parseCount(row?.missing_price_count),
    };
  },

  async getRandomPublishedAuctionCard(
    options: RandomPublishedAuctionCardOptions
  ): Promise<PublishedAuctionCardRow | null> {
    const excludeIds = options.excludeClueCardIds ?? [];
    const seenPlayerIds = options.excludeRecentlySeenFootballPlayerIds ?? [];
    const leastRecentlySeenPlayerIds =
      options.preferLeastRecentlySeenFootballPlayerIds ?? [];
    const positionFilter = options.positionGroup
      ? sql`AND position_group = ${options.positionGroup}`
      : sql``;
    // Fame is judged by the CAREER, not just today's price tag: an aging star
    // whose current value decayed (Modric-class veterans) is still a household
    // name. Judging by current value alone put 293 of the pool's 306 thirty-plus
    // players in the "lesser known" bucket — players only ever saw the
    // 2021-generation (owner feedback 2026-08-26). peak >= 30M OR current >=
    // 25M widens the tier to 641 cards incl. 148 aging stars.
    const fameFilter = options.fameTier === 'well_known'
      ? sql`AND (current_value_eur >= ${AUCTION_WELL_KNOWN_VALUE_EUR}
             OR COALESCE(peak_value_eur, 0) >= ${AUCTION_WELL_KNOWN_PEAK_VALUE_EUR})`
      : options.fameTier === 'lesser_known'
        ? sql`AND current_value_eur < ${AUCTION_WELL_KNOWN_VALUE_EUR}
              AND COALESCE(peak_value_eur, 0) < ${AUCTION_WELL_KNOWN_PEAK_VALUE_EUR}`
        : sql``;
    const eraFilter = options.veteranEra
      ? sql`AND football_player_id IN (
          SELECT fp.id FROM football_players fp
          WHERE fp.date_of_birth <= (CURRENT_DATE - INTERVAL '29 years')
        )`
      : sql``;
    const excludeFilter = excludeIds.length > 0
      ? sql`AND football_player_id NOT IN (
          SELECT used.football_player_id
          FROM player_clue_cards used
          WHERE used.id = ANY(${sql.array(excludeIds)}::uuid[])
        )`
      : sql``;
    // Cross-match history exclusion is by footballer, not clue card, so a
    // different locale or V2 variant cannot bypass the no-repeat window.
    const seenFilter = seenPlayerIds.length > 0
      ? sql`AND football_player_id <> ALL(${sql.array(seenPlayerIds)}::uuid[])`
      : sql``;
    // Difficulty seam: prefer the matching rich prompt_version when asked. Kept
    // as a soft ORDER BY bias rather than a hard WHERE so a locale/position with
    // no v3-rich cards yet still returns a card (default behaviour unchanged
    // when preferredDifficulty is omitted).
    const leastRecentlySeenOrder = leastRecentlySeenPlayerIds.length > 0
      ? sql`array_position(${sql.array(leastRecentlySeenPlayerIds)}::uuid[], football_player_id) ASC NULLS LAST,`
      : sql``;
    const difficultyOrder = options.preferredDifficulty
      ? sql`(prompt_version LIKE ${PROMPT_VERSION_PATTERN_BY_DIFFICULTY[options.preferredDifficulty]}) DESC,`
      : sql``;

    const [row] = await sql<PublishedAuctionCardRow[]>`
      SELECT *
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND ${usablePricePredicate}
        AND ${snapshotReadyPredicate}
        AND locale = ${options.locale}
        ${positionFilter}
        ${fameFilter}
        ${eraFilter}
        ${excludeFilter}
        ${seenFilter}
      ORDER BY ${leastRecentlySeenOrder} ${difficultyOrder} random()
      LIMIT 1
    `;

    return row ?? null;
  },

  /**
   * Footballers the given users have already seen within the recent window.
   * History is stored by clue-card id, so join through player_clue_cards to
   * collapse every locale/variant onto football_player_id. Results are ordered
   * oldest first for the exhausted-pool least-recently-seen fallback.
   *
   * Auction's analogue of matchQuestionsRepo.getRecentlySeenQuestionIds. Ranked
   * derives history from match_questions.shown_at; auction has no per-match card
   * table (cards live in the redis state blob), so it reads the dedicated
   * auction_seen_cards log written at round start.
   *
   * Best-effort by contract: callers use the ordered result as a hard exclusion
   * first, then as an oldest-first fallback ranking if the fresh pool is empty.
   */
  /**
   * Career seasons for the scouting-snapshot lot, chronological, valued rows
   * only (a season without a market value can't anchor the price gamble).
   */
  async getSeasonSnapshots(footballPlayerId: string): Promise<SeasonSnapshotRow[]> {
    // Window = the NEWEST 10 valued seasons (a plain ASC LIMIT would drop the
    // latest seasons for long careers, pinning "future value" to an old year),
    // returned chronologically for the scout-earliest / value-latest contract.
    return sql<SeasonSnapshotRow[]>`
      SELECT season_label, league_name, age, apps, goals, assists,
             clean_sheets, goals_conceded, value_eur
      FROM (
        SELECT season_label, league_name, age, apps, goals, assists,
               clean_sheets, goals_conceded, value_eur, season_start_year
        FROM player_season_snapshots
        WHERE football_player_id = ${footballPlayerId}
          AND value_eur IS NOT NULL
        ORDER BY season_start_year DESC
        LIMIT 10
      ) recent
      ORDER BY season_start_year ASC
    `;
  },

  /**
   * Atomically CLAIM one encounter of this player for these humans and return
   * the highest post-claim count (max over users: the most-exposed human's
   * rotation never repeats a season early; a shared lot can only follow one
   * cursor). Claiming at selection time — a single upsert-returning statement —
   * means two overlapping selections can never read the same cursor, which a
   * separate read-then-record pair could. Backed by the dedicated per-(user,
   * player) counter: auction_seen_cards can't count encounters (it dedupes per
   * card and varies with locale variants). All-time on purpose — the
   * scout-season cycle only wraps after every season was shown.
   */
  async claimScoutEncounter(
    userIds: string[],
    footballPlayerId: string
  ): Promise<number> {
    if (userIds.length === 0) return 0;
    const rows = await sql<{ encounters: string | number }[]>`
      INSERT INTO auction_scout_encounters (user_id, football_player_id)
      SELECT unnest(${sql.array(userIds)}::uuid[]), ${footballPlayerId}
      ON CONFLICT (user_id, football_player_id)
      DO UPDATE SET encounters = auction_scout_encounters.encounters + 1, last_seen_at = NOW()
      RETURNING encounters
    `;
    return rows.reduce((max, row) => Math.max(max, parseCount(row.encounters)), 0);
  },

  async getRecentlySeenFootballPlayerIds(
    userIds: string[],
    withinDays = AUCTION_CARD_HISTORY_WINDOW_DAYS
  ): Promise<string[]> {
    if (userIds.length === 0) return [];

    const rows = await sql<{ football_player_id: string }[]>`
      SELECT pcc.football_player_id
      FROM auction_seen_cards seen
      JOIN player_clue_cards pcc
        ON pcc.id = seen.clue_card_id
      WHERE seen.user_id = ANY(${sql.array(userIds)}::uuid[])
        AND seen.seen_at > now() - make_interval(days => ${withinDays})
      GROUP BY pcc.football_player_id
      ORDER BY MAX(seen.seen_at) ASC
    `;

    return rows.map((row) => row.football_player_id);
  },

  /**
   * Record that each of `userIds` saw `clueCardId`. Re-seeing bumps seen_at so
   * the recency window slides forward and the table stays bounded to distinct
   * (user, card) pairs rather than growing per match.
   */
  async recordSeenClueCards(userIds: string[], clueCardIds: string[]): Promise<void> {
    if (userIds.length === 0 || clueCardIds.length === 0) return;

    const rows = userIds.flatMap((userId) => (
      clueCardIds.map((clueCardId) => [userId, clueCardId] as [string, string])
    ));

    await sql`
      INSERT INTO auction_seen_cards ${sql(rows.map(([user_id, clue_card_id]) => ({ user_id, clue_card_id })))}
      ON CONFLICT (user_id, clue_card_id) DO UPDATE SET seen_at = NOW()
    `;
  },

  async getPublishedAuctionCardById(clueCardId: string): Promise<PublishedAuctionCardRow | null> {
    const [row] = await sql<PublishedAuctionCardRow[]>`
      SELECT *
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND locale IN ('en', 'ka')
        AND clue_card_id = ${clueCardId}
      LIMIT 1
    `;

    return row ?? null;
  },

  positionGroups(): readonly PositionGroup[] {
    return POSITION_GROUPS;
  },
};
