/** FIFA Card Detective for Freecroco (contract v1.2 §7.3). The server deals 10 cards from the daily card pool (never
 *  the cards of today's public dailies), keeps them, and judges every clue purchase and guess: the browser only ever
 *  sees an opaque per-play card ref, the clues the rules have opened, and a card's identity once it is resolved. The
 *  edition (free on quizball.io) is withheld until then too: contract §7.3 lists only the position and two stats as
 *  free, and edition + position + two stats is enough to look most cards up in a public card database. */

import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { partnerBegin } from '../../partner-analytics.js';
import { asSql, type Db } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import type { PartnerPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle, settlePartnerPlay, startPartnerPlay } from '../kit.js';
import { selectDailyFifaCardIds, type FifaCardCandidate } from '../../../daily-challenges/fifa-card-selection.js';
import { buildFifaFaceUrl } from '../../../daily-challenges/fifa-face-url.js';
import type { FifaCardRow } from '../../../daily-challenges/daily-challenges.types.js';
import {
  CD_CARD_COUNT,
  CD_CLUE_COSTS,
  CD_IDLE_SECONDS,
  CD_START_POINTS,
  CD_WRONG_GUESS_COST,
  freeCluesFor,
  matchesCardName,
  type CdClueKey,
  type CdStatKey,
} from './cd-partner.rules.js';

/** What the server keeps per dealt card. `card` holds the answer: it never leaves the server unresolved. */
interface CardSnapshot {
  name: string;
  nameKa: string | null;
  accepted: string[];
  editionLabel: string;
  overall: number;
  position: string;
  nation: string;
  nationCode: string;
  league: string;
  club: string;
  stats: Record<CdStatKey, number>;
  faceUrl: string | null;
}

interface CardState {
  ref: string;
  cardId: string;
  card: CardSnapshot;
  coins: number;
  open: CdClueKey[];
  wrongGuesses: number;
  status: 'pending' | 'solved' | 'skipped';
  points: number;
}

interface PlayRow {
  play_id: string;
  player_id: string;
  cards: CardState[];
  current_index: number;
  version: number;
  idle_deadline: Date;
  settled_at: Date | null;
}

export interface CdClues {
  rating?: number;
  position?: string;
  nation?: { name: string; code: string };
  league?: string;
  club?: string;
  pac?: number;
  sho?: number;
  pas?: number;
  dri?: number;
  def?: number;
  phy?: number;
}

export interface CdRevealedCard {
  name: string;
  editionLabel: string;
  overall: number;
  position: string;
  nation: string;
  nationCode: string;
  league: string;
  club: string;
  stats: Record<CdStatKey, number>;
  faceUrl: string | null;
}

export interface CdPlayState {
  playId: string;
  version: number;
  state: 'active' | 'finished';
  cardCount: number;
  /** The card being played (0-based); equals cardCount once every card is resolved. */
  index: number;
  /** Points banked so far (solved cards). */
  score: number;
  startPoints: number;
  clueCosts: Record<CdClueKey, number>;
  wrongGuessCost: number;
  current: {
    ref: string;
    points: number;
    wrongGuesses: number;
    open: CdClueKey[];
    clues: CdClues;
  } | null;
  resolved: Array<{ ref: string; solved: boolean; points: number; card: CdRevealedCard }>;
  finished: { playId: string; score: number; sent: boolean } | null;
}

const ROW_COLUMNS = ['play_id', 'player_id', 'cards', 'current_index', 'version', 'idle_deadline', 'settled_at'];

function displayName(card: CardSnapshot, language: string): string {
  return language === 'ka' && card.nameKa ? card.nameKa : card.name;
}

function cluesOf(card: CardSnapshot, open: CdClueKey[]): CdClues {
  const clues: CdClues = {};
  for (const key of open) {
    if (key === 'rating') clues.rating = card.overall;
    else if (key === 'position') clues.position = card.position;
    else if (key === 'nation') clues.nation = { name: card.nation, code: card.nationCode };
    else if (key === 'league') clues.league = card.league;
    else if (key === 'club') clues.club = card.club;
    else clues[key] = card.stats[key];
  }
  return clues;
}

function revealed(card: CardSnapshot, language: string): CdRevealedCard {
  return {
    name: displayName(card, language),
    editionLabel: card.editionLabel,
    overall: card.overall,
    position: card.position,
    nation: card.nation,
    nationCode: card.nationCode,
    league: card.league,
    club: card.club,
    stats: { ...card.stats },
    faceUrl: card.faceUrl,
  };
}

type PlayEnd = Pick<PartnerPlay, 'id' | 'state' | 'score'>;

/**
 * Where a play stands, read under the player lock (see lockRow): its parent play and whether a block cancelled it.
 * Every response is built from one, so a cancelled play can never be shown.
 */
interface PlayCtx {
  parent: PlayEnd;
  /** Cancelled by a block (or the player is blocked with the play still running). */
  cancelled: boolean;
}

/** The context after a save: settlement may have ended the parent. */
function afterSave(ctx: PlayCtx, end: PlayEnd | null): PlayCtx {
  return end ? { parent: end, cancelled: ctx.cancelled || end.state === 'cancelled' } : ctx;
}

function toState(row: PlayRow, language: string, ctx: PlayCtx): CdPlayState {
  if (ctx.cancelled) {
    // Only that it ended, unscored: no card, no clue, no identity.
    return {
      playId: row.play_id,
      version: row.version,
      state: 'finished',
      cardCount: row.cards.length,
      index: 0,
      score: 0,
      startPoints: CD_START_POINTS,
      clueCosts: { ...CD_CLUE_COSTS },
      wrongGuessCost: CD_WRONG_GUESS_COST,
      current: null,
      resolved: [],
      finished: { playId: row.play_id, score: 0, sent: false },
    };
  }
  const end = ctx.parent;
  const current = row.settled_at ? undefined : row.cards[row.current_index];
  return {
    playId: row.play_id,
    version: row.version,
    state: row.settled_at ? 'finished' : 'active',
    cardCount: row.cards.length,
    index: row.current_index,
    score: row.cards.reduce((sum, c) => sum + c.points, 0),
    startPoints: CD_START_POINTS,
    clueCosts: { ...CD_CLUE_COSTS },
    wrongGuessCost: CD_WRONG_GUESS_COST,
    current: current
      ? {
          ref: current.ref,
          points: current.coins,
          wrongGuesses: current.wrongGuesses,
          open: [...current.open],
          clues: cluesOf(current.card, current.open),
        }
      : null,
    resolved: row.cards
      .filter((c) => c.status !== 'pending')
      .map((c) => ({ ref: c.ref, solved: c.status === 'solved', points: c.points, card: revealed(c.card, language) })),
    finished: end.state === 'finished' ? { playId: end.id, score: end.score ?? 0, sent: true } : null,
  };
}

function snapshotOf(row: FifaCardRow): CardSnapshot {
  return {
    name: row.name,
    nameKa: row.name_ka,
    accepted: Array.from(new Set([row.name, row.name_ka ?? '', ...row.accepted].map((v) => v.trim()).filter(Boolean))),
    editionLabel: row.edition_label,
    overall: row.overall,
    position: row.position,
    nation: row.nation,
    nationCode: row.nation_code,
    league: row.league,
    club: row.club,
    stats: { pac: row.pac, sho: row.sho, pas: row.pas, dri: row.dri, def: row.def, phy: row.phy },
    faceUrl: buildFifaFaceUrl(row.photo_id, row.photo_ver),
  };
}

/**
 * 10 cards with the daily's difficulty mix, never a player in an existing public Card Detective or FIFA Cards set of
 * yesterday, today or later (UTC) — those answers are public on quizball.io — preferring cards this player has not
 * been dealt before. "Same player" is matched like the daily allocator: name (case/punctuation folded), a shared
 * accepted answer, or the same face. Read-only: a partner start never creates or changes a public set. It runs inside
 * the start transaction, so a failed lookup refuses the start without using a play.
 */
async function dealCards(tx: Db, playerId: string): Promise<CardState[]> {
  const candidates = await tx<(Omit<FifaCardCandidate, 'last_served_day'>)[]>`
    WITH public_cards AS (
      SELECT pc.name, pc.accepted, pc.photo_id
      FROM fifa_cards pc
      WHERE pc.id IN (
        SELECT unnest(card_ids) FROM daily_card_detective_sets
        WHERE challenge_day >= (clock_timestamp() AT TIME ZONE 'UTC')::date - 1
        UNION
        SELECT unnest(card_ids) FROM daily_fifa_card_sets
        WHERE challenge_day >= (clock_timestamp() AT TIME ZONE 'UTC')::date - 1
      )
    )
    SELECT c.id::text AS id, c.difficulty, c.edition, c.name
    FROM fifa_cards c
    WHERE c.is_active
      AND NOT EXISTS (
        SELECT 1 FROM public_cards o
        WHERE o.name = c.name
           OR regexp_replace(lower(o.name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g')
           OR o.accepted && c.accepted
           OR (o.photo_id IS NOT NULL AND o.photo_id = c.photo_id)
      )`;
  const seen = await tx<{ card_id: string; day: string }[]>`
    SELECT e->>'cardId' AS card_id, max(p.created_at)::date::text AS day
    FROM partner_card_detective_plays p, jsonb_array_elements(p.cards) e
    WHERE p.player_id = ${playerId}
    GROUP BY 1`;
  const lastDealt = new Map(seen.map((s) => [s.card_id, s.day]));
  // A fresh salt per play: unlike the daily, two players must not get the same cards in the same order.
  const salt = randomBytes(12).toString('hex');
  const ids = selectDailyFifaCardIds(
    candidates.map((c) => ({ ...c, last_served_day: lastDealt.get(c.id) ?? null })),
    CD_CARD_COUNT,
    salt,
    'partner',
  );
  if (ids.length === 0) return [];
  const rows = await tx<FifaCardRow[]>`SELECT * FROM fifa_cards WHERE id = ANY(${tx.array(ids)}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return [];
    const ref = randomUUID().replaceAll('-', '').slice(0, 16);
    return [{ ref, cardId: id, card: snapshotOf(row), coins: CD_START_POINTS, open: freeCluesFor(ref), wrongGuesses: 0, status: 'pending' as const, points: 0 }];
  });
}

/** The play row, locked; a play a block cancelled meanwhile is refused (the next request closes its row). */
/** Always the first lock of a request (the block path's order: player, then plays). True while the player is active. */
async function lockPlayer(tx: Db, playerId: string): Promise<boolean> {
  const [player] = await tx<{ status: string }[]>`SELECT status FROM partner_players WHERE id = ${playerId} FOR SHARE`;
  return player?.status === 'active';
}

async function contextOf(tx: Db, playId: string, active: boolean): Promise<PlayCtx> {
  const parent = (await playEnd(tx, playId))!;
  return { parent, cancelled: parent.state === 'cancelled' || (!active && parent.state === 'started') };
}

/**
 * The play row for one request: the player row first (FOR SHARE; a block takes it exclusively before cancelling
 * plays), then the play row. No block can land until the request commits, so its context cannot change under it.
 */
async function lockRow(tx: Db, partner: PartnerPrincipal, playId: string): Promise<{ row: PlayRow; ctx: PlayCtx }> {
  const active = await lockPlayer(tx, partner.playerId);
  const [row] = await tx<PlayRow[]>`
    SELECT ${tx(ROW_COLUMNS)} FROM partner_card_detective_plays
    WHERE play_id = ${playId} AND player_id = ${partner.playerId} FOR UPDATE`;
  if (!row) throw new PartnerError('not_found', 'Play not found');
  return { row, ctx: await contextOf(tx, playId, active) };
}

/**
 * A block cancels the parent play (contract §5.5: no event, the play stays used). Close this player's rows of
 * cancelled plays in a statement of its own, before anything reads them as playable (an unblocked player must not
 * resume a cancelled play).
 */
async function closeCancelled(playerId: string): Promise<void> {
  await sql`
    UPDATE partner_card_detective_plays g SET settled_at = clock_timestamp()
    FROM partner_plays p
    WHERE p.id = g.play_id AND p.state = 'cancelled' AND g.player_id = ${playerId} AND g.settled_at IS NULL`;
}

async function playEnd(tx: Db, playId: string): Promise<PlayEnd | null> {
  const [row] = await tx<PlayEnd[]>`SELECT id, state, score FROM partner_plays WHERE id = ${playId}`;
  return row ?? null;
}

/** Persists the cards; when every card is resolved (or `endNow`), settles the play: one score event at `at`. */
async function save(
  tx: Db,
  row: PlayRow,
  opts: { endNow?: boolean; at?: Date; cause?: 'idle' | 'quit' } = {},
): Promise<{ row: PlayRow; end: PlayEnd | null }> {
  const done = opts.endNow || row.current_index >= row.cards.length;
  const [saved] = await tx<PlayRow[]>`
    UPDATE partner_card_detective_plays
    SET cards = ${tx.json(row.cards as never)}, current_index = ${row.current_index}, version = version + 1,
        idle_deadline = clock_timestamp() + make_interval(secs => ${CD_IDLE_SECONDS}),
        settled_at = CASE WHEN ${done} THEN clock_timestamp() ELSE NULL END
    WHERE play_id = ${row.play_id}
    RETURNING ${tx(ROW_COLUMNS)}`;
  if (!done) return { row: saved, end: null };
  const score = Math.min(CD_CARD_COUNT * CD_START_POINTS, saved.cards.reduce((sum, c) => sum + c.points, 0));
  const end = await settlePartnerPlay(tx as never, row.play_id, score, opts.at, undefined, {
    endCause: opts.endNow ? (opts.cause ?? 'idle') : 'completed',
  });
  return { row: saved, end };
}

/** Partner-wide rule: a request that reaches us up to 1 s after a deadline still counts. */
const LATE_GRACE_MS = 1_000;

/** A play left idle past its deadline ends there, with what it had banked, even if the sweeper has not run yet. */
async function settleIfIdle(tx: Db, row: PlayRow): Promise<{ row: PlayRow; end: PlayEnd | null } | null> {
  if (row.settled_at || row.idle_deadline.getTime() + LATE_GRACE_MS > Date.now()) return null;
  return save(tx, row, { endNow: true, at: row.idle_deadline });
}

function currentCard(row: PlayRow, ref: string, version: number): CardState {
  if (row.settled_at) throw new PartnerError('play_not_active');
  if (row.version !== version) throw new PartnerError('stale_version');
  const card = row.cards[row.current_index];
  if (!card || card.ref !== ref || card.status !== 'pending') throw new PartnerError('stale_version');
  return card;
}

async function act<T>(partner: PartnerPrincipal, fn: (tx: Db) => Promise<{ value: T; settled: boolean }>): Promise<T> {
  await closeCancelled(partner.playerId);
  const result = (await partnerBegin((t) => fn(asSql(t)))) as { value: T; settled: boolean };
  if (result.settled) afterPartnerSettle();
  return result.value;
}

export const partnerCardDetectiveService = {
  async current(partner: PartnerPrincipal): Promise<{ play: CdPlayState | null }> {
    return act(partner, async (tx) => {
      const active = await lockPlayer(tx, partner.playerId);
      const [row] = await tx<PlayRow[]>`
        SELECT ${tx(ROW_COLUMNS)} FROM partner_card_detective_plays
        WHERE player_id = ${partner.playerId} AND settled_at IS NULL
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`;
      if (!row) return { value: { play: null }, settled: false };
      const ctx = await contextOf(tx, row.play_id, active);
      return { value: { play: ctx.cancelled ? null : toState(row, partner.language, ctx) }, settled: false };
    });
  },

  /** Deals today's play, or returns the open one (a retried or second start never reserves twice). */
  async start(partner: PartnerPrincipal, clientNonce: string): Promise<CdPlayState> {
    const open = await this.current(partner);
    if (open.play) return open.play;
    const { result } = await startPartnerPlay(partner, 'card-detective', `${partner.playerId}:${clientNonce}`, async (t, play) => {
      const tx = asSql(t);
      const [existing] = await tx<PlayRow[]>`
        SELECT ${tx(ROW_COLUMNS)} FROM partner_card_detective_plays WHERE play_id = ${play.id}`;
      // reservePlay holds the player lock: the play's state is current.
      if (existing) return toState(existing, partner.language, { parent: play, cancelled: play.state === 'cancelled' });
      if (play.state !== 'started') throw new PartnerError('play_not_active');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-card-detective:${partner.playerId}`}, 0))`;
      const [racing] = await tx<{ play_id: string }[]>`
        SELECT play_id FROM partner_card_detective_plays WHERE player_id = ${partner.playerId} AND settled_at IS NULL`;
      if (racing) throw new PartnerError('request_conflict', 'A play is already in progress');
      const cards = await dealCards(tx, partner.playerId);
      // Rolls the reservation back with it: no cards, no play used.
      if (cards.length < CD_CARD_COUNT) throw new PartnerError('game_not_available');
      const [row] = await tx<PlayRow[]>`
        INSERT INTO partner_card_detective_plays (play_id, player_id, cards, idle_deadline)
        VALUES (${play.id}, ${partner.playerId}, ${tx.json(cards as never)},
                clock_timestamp() + make_interval(secs => ${CD_IDLE_SECONDS}))
        RETURNING ${tx(ROW_COLUMNS)}`;
      return toState(row, partner.language, { parent: play, cancelled: false });
    });
    return result;
  },

  async reveal(partner: PartnerPrincipal, playId: string, input: { ref: string; clue: CdClueKey; version: number }): Promise<CdPlayState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      if (ctx.cancelled) return { value: toState(row, partner.language, ctx), settled: false };
      const idle = await settleIfIdle(tx, row);
      if (idle) return { value: toState(idle.row, partner.language, afterSave(ctx, idle.end)), settled: true };
      const card = currentCard(row, input.ref, input.version);
      if (card.open.includes(input.clue)) throw new PartnerError('invalid_request', 'This clue is already open');
      const cost = CD_CLUE_COSTS[input.clue];
      if (card.coins < cost) throw new PartnerError('invalid_request', 'Not enough points left on this card for that clue');
      card.coins -= cost;
      card.open.push(input.clue);
      const saved = await save(tx, row);
      return { value: toState(saved.row, partner.language, afterSave(ctx, saved.end)), settled: false };
    });
  },

  async guess(partner: PartnerPrincipal, playId: string, input: { ref: string; name: string; version: number }): Promise<{ correct: boolean; state: CdPlayState }> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      if (ctx.cancelled) return { value: { correct: false, state: toState(row, partner.language, ctx) }, settled: false };
      const idle = await settleIfIdle(tx, row);
      if (idle) return { value: { correct: false, state: toState(idle.row, partner.language, afterSave(ctx, idle.end)) }, settled: true };
      const card = currentCard(row, input.ref, input.version);
      const correct = matchesCardName(input.name, card.card.accepted);
      if (correct) {
        card.status = 'solved';
        card.points = card.coins;
        row.current_index += 1;
      } else {
        card.wrongGuesses += 1;
        card.coins = Math.max(0, card.coins - CD_WRONG_GUESS_COST);
      }
      const saved = await save(tx, row);
      return { value: { correct, state: toState(saved.row, partner.language, afterSave(ctx, saved.end)) }, settled: Boolean(saved.end) };
    });
  },

  async skip(partner: PartnerPrincipal, playId: string, input: { ref: string; version: number }): Promise<CdPlayState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      if (ctx.cancelled) return { value: toState(row, partner.language, ctx), settled: false };
      const idle = await settleIfIdle(tx, row);
      if (idle) return { value: toState(idle.row, partner.language, afterSave(ctx, idle.end)), settled: true };
      const card = currentCard(row, input.ref, input.version);
      card.status = 'skipped';
      card.points = 0;
      row.current_index += 1;
      const saved = await save(tx, row);
      return { value: toState(saved.row, partner.language, afterSave(ctx, saved.end)), settled: Boolean(saved.end) };
    });
  },

  /** One of this player's plays, finished ones included: how the screen recovers a lost or refused response. */
  async get(partner: PartnerPrincipal, playId: string): Promise<CdPlayState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      if (ctx.cancelled) return { value: toState(row, partner.language, ctx), settled: false };
      const idle = await settleIfIdle(tx, row);
      if (idle) return { value: toState(idle.row, partner.language, afterSave(ctx, idle.end)), settled: true };
      return { value: toState(row, partner.language, ctx), settled: false };
    });
  },

  /** The player leaves early: the play ends with the points banked so far (contract §7). */
  async finish(partner: PartnerPrincipal, playId: string): Promise<CdPlayState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      if (ctx.cancelled || row.settled_at) return { value: toState(row, partner.language, ctx), settled: false };
      const idle = await settleIfIdle(tx, row);
      const saved = idle ?? (await save(tx, row, { endNow: true, cause: 'quit' }));
      return { value: toState(saved.row, partner.language, afterSave(ctx, saved.end)), settled: true };
    });
  },

  /** Sweeper: a play left idle is settled with what it had earned, dated at its idle deadline; plays a block
   *  cancelled are closed without an event. */
  async sweepIdle(limit = 100): Promise<number> {
    const due = await sql<{ play_id: string; player_id: string }[]>`
      SELECT g.play_id, g.player_id FROM partner_card_detective_plays g
      WHERE g.settled_at IS NULL
        AND (g.idle_deadline < clock_timestamp() - make_interval(secs => ${LATE_GRACE_MS / 1000})
          OR EXISTS (SELECT 1 FROM partner_plays p WHERE p.id = g.play_id AND p.state = 'cancelled'))
      ORDER BY g.idle_deadline LIMIT ${limit}`;
    let settled = 0;
    for (const { play_id, player_id } of due) {
      // One failing play must not hold back the rest of the batch on every run.
      const done = await partnerBegin(async (t) => {
        const tx = asSql(t);
        const active = await lockPlayer(tx, player_id);
        const [row] = await tx<PlayRow[]>`
          SELECT ${tx(ROW_COLUMNS)} FROM partner_card_detective_plays
          WHERE play_id = ${play_id} FOR UPDATE SKIP LOCKED`;
        if (!row || row.settled_at) return false;
        const ctx = await contextOf(tx, play_id, active);
        if (ctx.cancelled) {
          // Closed without an event; a running play of a blocked player is cancelled by the block itself.
          if (ctx.parent.state !== 'cancelled') return false;
          await tx`UPDATE partner_card_detective_plays SET settled_at = clock_timestamp() WHERE play_id = ${play_id}`;
          return true;
        }
        return Boolean(await settleIfIdle(tx, row));
      }).catch((err) => {
        logger.error({ err, playId: play_id }, 'Partner Card Detective sweep failed for a play');
        return false;
      });
      if (done) settled += 1;
    }
    if (settled > 0) afterPartnerSettle();
    return settled;
  },
};
