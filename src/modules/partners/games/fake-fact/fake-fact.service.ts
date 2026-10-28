/** Fake Fact for Freecroco (replaces Guess the Goal in contract §7.4): a footballer and five facts, one of them fake.
 *  Card 1: find the fake within 30 s, 100 points; wrong or out of time = 0 and the play ends. A right card 1 opens a
 *  bonus card the player opens when ready (within 2 minutes, else the play ends with its 100): 30 s, +40. A play left
 *  midway ends at its deadline with what it earned. Cards come from the Dato falso room pool, cards this player has
 *  not been shown first. A card's fake and explanation leave the server only once that card is
 *  settled. One score event per play, written with the result; no coins, XP or Quizball leaderboard entries. */

import { randomUUID } from 'node:crypto';
import { sql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { partnerBegin } from '../../partner-analytics.js';
import { asSql, type Db } from '../../partner-db.js';
import { PartnerError } from '../../partner-errors.js';
import type { PartnerPrincipal } from '../../partner-player-auth.js';
import type { PartnerPlay } from '../../partner-quota.service.js';
import { afterPartnerSettle, settlePartnerPlay, startPartnerPlay } from '../kit.js';
import { dfCardSchema, dfPlayerKeys, type DfCard, type DfDifficulty } from '../../../room/games/dato-falso/dato-falso.rules.js';

export const FAKE_FACT_MAIN_POINTS = 100;
export const FAKE_FACT_BONUS_POINTS = 40;
export const FAKE_FACT_CARD_SECONDS = 30;
/** A right card 1 waits this long for the player to open the bonus; then the play ends with its 100. */
export const FAKE_FACT_BETWEEN_SECONDS = 120;
/** Partner-wide rule: an answer that reaches us up to 1 s after its deadline still counts; expiry waits as long. */
export const FAKE_FACT_LATE_GRACE_MS = 1_000;

const MAIN_TIERS: DfDifficulty[] = ['easy', 'medium'];
const BONUS_TIERS: DfDifficulty[] = ['medium', 'hard'];

type Step = 'card1' | 'between' | 'card2' | 'done';
interface CardResult { pick: number | null; right: boolean; points: number }

interface PlayRow {
  play_id: string;
  player_id: string;
  cards: DfCard[];
  card_ids: string[];
  shown_ids: string[];
  step: Step;
  results: CardResult[];
  deadline: Date;
  settled_at: Date | null;
}
const ROW_COLUMNS = ['play_id', 'player_id', 'cards', 'card_ids', 'shown_ids', 'step', 'results', 'deadline', 'settled_at'];

type PlayEnd = Pick<PartnerPlay, 'id' | 'state' | 'score'>;
interface PlayCtx { parent: PlayEnd; cancelled: boolean }

/** A card before its reveal, in every language (the player may switch language mid-play): no fake, no explanation. */
export interface FakeFactCard {
  id: string;
  category: DfCard['category'];
  player: { name: DfCard['player']['name']; portrait: string | null };
  options: Array<{ label: DfCard['options'][number]['label']; art: DfCard['options'][number]['art'] }>;
}

export interface FakeFactSettledCard extends CardResult {
  card: FakeFactCard;
  fake: number;
  explain: DfCard['explain'];
  timedOut: boolean;
}

export interface FakeFactState {
  playId: string;
  step: Step;
  serverNow: string;
  /** The open card's answer deadline, or (between) until when the bonus can be opened. Null once the play ended. */
  deadline: string | null;
  graceMs: number;
  cardSeconds: number;
  /** Points banked so far. */
  score: number;
  maxScore: number;
  /** The card being answered (card1 / card2), else null. */
  card: FakeFactCard | null;
  /** Settled cards with their reveal, in deal order. */
  results: FakeFactSettledCard[];
  /** Set once the play ended: its score, and whether it was sent (false when a block cancelled it). */
  finished: { playId: string; score: number; sent: boolean } | null;
}

const publicCard = (card: DfCard): FakeFactCard => ({
  id: card.id,
  category: card.category,
  player: { name: card.player.name, portrait: card.player.portrait },
  options: card.options.map((o) => ({ label: o.label, art: o.art })),
});

const banked = (results: readonly CardResult[]): number => results.reduce((sum, r) => sum + r.points, 0);

function afterSettle(ctx: PlayCtx, end: PlayEnd | null): PlayCtx {
  return end ? { parent: end, cancelled: ctx.cancelled || end.state === 'cancelled' } : ctx;
}

/** `now`: the database clock the deadlines are on, so the screen's countdown matches what the server judges. */
function toState(row: PlayRow, ctx: PlayCtx, now: number): FakeFactState {
  const base = { playId: row.play_id, serverNow: new Date(now).toISOString(), graceMs: FAKE_FACT_LATE_GRACE_MS, cardSeconds: FAKE_FACT_CARD_SECONDS, maxScore: FAKE_FACT_MAIN_POINTS + FAKE_FACT_BONUS_POINTS };
  if (ctx.cancelled) {
    // Only that it ended, unscored: no card, no answer.
    return { ...base, step: 'done', deadline: null, score: 0, card: null, results: [], finished: { playId: row.play_id, score: 0, sent: false } };
  }
  const ended = row.settled_at !== null || ctx.parent.state !== 'started';
  const open = !ended && (row.step === 'card1' || row.step === 'card2');
  return {
    ...base,
    step: ended ? 'done' : row.step,
    deadline: ended ? null : row.deadline.toISOString(),
    score: banked(row.results),
    card: open ? publicCard(row.cards[row.step === 'card1' ? 0 : 1]) : null,
    results: row.results.map((r, i) => ({ ...r, card: publicCard(row.cards[i]), fake: row.cards[i].fake, explain: row.cards[i].explain, timedOut: r.pick === null })),
    finished: ended ? { playId: row.play_id, score: ctx.parent.state === 'finished' ? (ctx.parent.score ?? 0) : 0, sent: ctx.parent.state === 'finished' } : null,
  };
}

/** Always the first lock of a request (the block path's order: player, then plays). True while the player is active. */
async function lockPlayer(tx: Db, playerId: string): Promise<boolean> {
  const [player] = await tx<{ status: string }[]>`SELECT status FROM partner_players WHERE id = ${playerId} FOR SHARE`;
  return player?.status === 'active';
}

/** Every deadline decision reads the database clock (deadlines are written with it), never a replica's own. */
async function dbNow(tx: Db): Promise<number> {
  const [{ now }] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return now.getTime();
}

async function playEnd(tx: Db, playId: string): Promise<PlayEnd | null> {
  const [row] = await tx<PlayEnd[]>`SELECT id, state, score FROM partner_plays WHERE id = ${playId}`;
  return row ?? null;
}

async function contextOf(tx: Db, playId: string, active: boolean): Promise<PlayCtx> {
  const parent = (await playEnd(tx, playId))!;
  return { parent, cancelled: parent.state === 'cancelled' || (!active && parent.state === 'started') };
}

/** The play row for one request: the player row first (FOR SHARE; a block takes it exclusively before cancelling
 *  plays), then the play row, so no block can land until the request commits. */
async function lockRow(tx: Db, partner: PartnerPrincipal, playId: string): Promise<{ row: PlayRow; ctx: PlayCtx }> {
  const active = await lockPlayer(tx, partner.playerId);
  const [row] = await tx<PlayRow[]>`
    SELECT ${tx(ROW_COLUMNS)} FROM partner_fake_fact_plays
    WHERE play_id = ${playId} AND player_id = ${partner.playerId} FOR UPDATE`;
  if (!row) throw new PartnerError('not_found', 'Play not found');
  return { row, ctx: await contextOf(tx, playId, active) };
}

/** A block cancels the parent play (contract §5.5: no event, the play stays used). Close this player's rows of
 *  cancelled plays before anything reads them as playable (an unblocked player must not resume a cancelled play). */
async function closeCancelled(playerId: string): Promise<void> {
  await sql`
    UPDATE partner_fake_fact_plays g SET settled_at = clock_timestamp(), step = 'done'
    FROM partner_plays p
    WHERE p.id = g.play_id AND p.state = 'cancelled' AND g.player_id = ${playerId} AND g.settled_at IS NULL`;
}

/** Stores the play's new step and results; on 'done' settles it: one score event dated `at`. */
async function save(
  tx: Db,
  row: PlayRow,
  next: { step: Step; results: CardResult[]; deadline?: Date; at: Date; cause?: 'completed' | 'timeout' },
): Promise<{ row: PlayRow; end: PlayEnd | null }> {
  const done = next.step === 'done';
  const [saved] = await tx<PlayRow[]>`
    UPDATE partner_fake_fact_plays
    SET step = ${next.step}, results = ${tx.json(next.results as never)},
        deadline = ${next.deadline ?? row.deadline},
        settled_at = CASE WHEN ${done} THEN clock_timestamp() ELSE NULL END
    WHERE play_id = ${row.play_id}
    RETURNING ${tx(ROW_COLUMNS)}`;
  if (!done) return { row: saved, end: null };
  const end = await settlePartnerPlay(tx as never, row.play_id, banked(next.results), next.at, undefined, {
    endCause: next.cause ?? 'completed',
  });
  return { row: saved, end };
}

/** An answer gets the 1 s transit grace; opening the bonus does not (it has no answer in flight to protect). */
const overdue = (row: PlayRow, now: number): boolean =>
  row.settled_at === null && now > row.deadline.getTime() + (row.step === 'between' ? 0 : FAKE_FACT_LATE_GRACE_MS);

/** A deadline that passed (plus the grace) ends where it stood, dated at the deadline: an open card counts as
 *  unanswered; a bonus never opened keeps the 100. Null while nothing is due. */
async function settleIfOverdue(tx: Db, row: PlayRow, now: number): Promise<{ row: PlayRow; end: PlayEnd | null } | null> {
  if (!overdue(row, now)) return null;
  const results = row.step === 'between' ? row.results : [...row.results, { pick: null, right: false, points: 0 }];
  return save(tx, row, { step: 'done', results, at: row.deadline, cause: 'timeout' });
}

async function act<T>(partner: PartnerPrincipal, fn: (tx: Db) => Promise<{ value: T; settled: boolean }>): Promise<T> {
  await closeCancelled(partner.playerId);
  const result = (await partnerBegin((t) => fn(asSql(t)))) as { value: T; settled: boolean };
  if (result.settled) afterPartnerSettle();
  return result.value;
}

/** Never-shown cards first (then the one shown longest ago), random within a tier, never the footballer of `avoid`.
 *  No fixed intro order: every Freecroco player starting on the same cards would make answers shareable. A player plays
 *  once a day, so the history scanned stays small. */
async function pickCard(tx: Db, playerId: string, tiers: DfDifficulty[], avoid: DfCard | null): Promise<DfCard | null> {
  const avoidKeys = avoid ? dfPlayerKeys(avoid) : null;
  const BATCH = 50;
  // One random order for the whole scan: a fresh random() per page could move a card into an already skipped page.
  const shuffle = randomUUID();
  for (let offset = 0; ; offset += BATCH) {
    const rows = await tx<{ payload: unknown }[]>`
      WITH seen AS (
        SELECT c.id, max(f.created_at) AS at
        FROM partner_fake_fact_plays f, unnest(f.shown_ids) AS c(id)
        WHERE f.player_id = ${playerId}
        GROUP BY c.id
      )
      SELECT r.payload FROM room_pool r
      LEFT JOIN seen s ON s.id = r.item_id
      WHERE r.game = 'dato_falso' AND r.enabled AND r.difficulty = ANY(${tx.array(tiers)}::text[])
        AND (${avoidKeys?.id ?? null}::text IS NULL OR r.payload->'player'->>'id' IS DISTINCT FROM ${avoidKeys?.id ?? null}::text)
      ORDER BY s.at ASC NULLS FIRST, md5(r.item_id || ${shuffle}), r.item_id
      LIMIT ${BATCH} OFFSET ${offset}`;
    for (const { payload } of rows) {
      const parsed = dfCardSchema.safeParse(payload);
      if (!parsed.success) continue;
      // One person can come from two sources under two ids: the name decides too.
      if (avoidKeys && dfPlayerKeys(parsed.data).name === avoidKeys.name) continue;
      return parsed.data;
    }
    if (rows.length < BATCH) return null;
  }
}

export const partnerFakeFactService = {
  /** The open play, settling it first if its time ran out (then its result: reopening the game shows how it ended). */
  async current(partner: PartnerPrincipal): Promise<{ play: FakeFactState | null }> {
    return act<{ play: FakeFactState | null }>(partner, async (tx) => {
      const active = await lockPlayer(tx, partner.playerId);
      const [row] = await tx<PlayRow[]>`
        SELECT ${tx(ROW_COLUMNS)} FROM partner_fake_fact_plays
        WHERE player_id = ${partner.playerId} AND settled_at IS NULL
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`;
      if (!row) return { value: { play: null }, settled: false };
      const ctx = await contextOf(tx, row.play_id, active);
      if (ctx.cancelled) return { value: { play: null }, settled: false };
      const now = await dbNow(tx);
      const ended = await settleIfOverdue(tx, row, now);
      if (ended) return { value: { play: toState(ended.row, afterSettle(ctx, ended.end), now) }, settled: true };
      return { value: { play: toState(row, ctx, now) }, settled: false };
    });
  },

  /** Deals today's play and opens card 1, or returns the open play (a retried or second start never reserves twice). */
  async start(partner: PartnerPrincipal, clientNonce: string): Promise<FakeFactState> {
    const open = await this.current(partner);
    if (open.play && !open.play.finished) return open.play;
    const { result } = await startPartnerPlay(partner, 'fake-fact', `${partner.playerId}:${clientNonce}`, async (t, play) => {
      const tx = asSql(t);
      const now = await dbNow(tx);
      const [existing] = await tx<PlayRow[]>`SELECT ${tx(ROW_COLUMNS)} FROM partner_fake_fact_plays WHERE play_id = ${play.id}`;
      // reservePlay holds the player lock: the play's state is current.
      if (existing) return toState(existing, { parent: play, cancelled: play.state === 'cancelled' }, now);
      if (play.state !== 'started') throw new PartnerError('play_not_active');
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-fake-fact:${partner.playerId}`}, 0))`;
      const [racing] = await tx<{ play_id: string }[]>`
        SELECT play_id FROM partner_fake_fact_plays WHERE player_id = ${partner.playerId} AND settled_at IS NULL`;
      if (racing) throw new PartnerError('request_conflict', 'A play is already in progress');
      const main = await pickCard(tx, partner.playerId, MAIN_TIERS, null);
      const bonus = main ? await pickCard(tx, partner.playerId, BONUS_TIERS, main) : null;
      // Rolls the reservation back with it: no cards, no play used.
      if (!main || !bonus) throw new PartnerError('game_not_available');
      const [row] = await tx<PlayRow[]>`
        INSERT INTO partner_fake_fact_plays (play_id, player_id, cards, card_ids, shown_ids, deadline)
        VALUES (${play.id}, ${partner.playerId}, ${tx.json([main, bonus] as never)}, ${tx.array([main.id, bonus.id])}::text[],
                ${tx.array([main.id])}::text[], ${new Date(now + FAKE_FACT_CARD_SECONDS * 1000)})
        RETURNING ${tx(ROW_COLUMNS)}`;
      return toState(row, { parent: play, cancelled: false }, now);
    });
    return result;
  },

  /** Answers the open card (`card` 0 = main, 1 = bonus). A retried answer gets the stored result; an answer after the
   *  deadline gets the timeout. */
  async answer(partner: PartnerPrincipal, playId: string, input: { card: 0 | 1; option: number }): Promise<FakeFactState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      const now = await dbNow(tx);
      if (ctx.cancelled) return { value: toState(row, ctx, now), settled: false };
      // A deadline that passed settles first, so even a retry never shows an expired card as open.
      const timedOut = await settleIfOverdue(tx, row, now);
      const current = timedOut?.row ?? row;
      const stored = current.results[input.card];
      if (stored) {
        if (stored.pick === input.option || stored.pick === null) {
          return { value: toState(current, afterSettle(ctx, timedOut?.end ?? null), now), settled: Boolean(timedOut) };
        }
        throw new PartnerError('play_not_active');
      }
      if (timedOut) return { value: toState(timedOut.row, afterSettle(ctx, timedOut.end), now), settled: true };
      const openCard = row.step === 'card1' ? 0 : row.step === 'card2' ? 1 : null;
      if (openCard !== input.card) throw new PartnerError('stale_version');
      const right = input.option === row.cards[input.card].fake;
      const points = right ? (input.card === 0 ? FAKE_FACT_MAIN_POINTS : FAKE_FACT_BONUS_POINTS) : 0;
      const results = [...row.results, { pick: input.option, right, points }];
      const at = new Date(now);
      const saved = input.card === 0 && right
        ? await save(tx, row, { step: 'between', results, at, deadline: new Date(now + FAKE_FACT_BETWEEN_SECONDS * 1000) })
        : await save(tx, row, { step: 'done', results, at });
      return { value: toState(saved.row, afterSettle(ctx, saved.end), now), settled: Boolean(saved.end) };
    });
  },

  /** Opens the bonus card: its 30 s start now, not while the player reads card 1's answer. */
  async next(partner: PartnerPrincipal, playId: string): Promise<FakeFactState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      const now = await dbNow(tx);
      if (ctx.cancelled) return { value: toState(row, ctx, now), settled: false };
      const ended = await settleIfOverdue(tx, row, now);
      if (ended) return { value: toState(ended.row, afterSettle(ctx, ended.end), now), settled: true };
      // A retried open (lost response) gets the open bonus.
      if (row.step === 'card2' && !row.settled_at) return { value: toState(row, ctx, now), settled: false };
      if (row.step !== 'between') throw new PartnerError('play_not_active');
      const [saved] = await tx<PlayRow[]>`
        UPDATE partner_fake_fact_plays
        SET step = 'card2', shown_ids = array_append(shown_ids, card_ids[2]),
            deadline = ${new Date(now + FAKE_FACT_CARD_SECONDS * 1000)}
        WHERE play_id = ${row.play_id}
        RETURNING ${tx(ROW_COLUMNS)}`;
      return { value: toState(saved, ctx, now), settled: false };
    });
  },

  /** One of this player's plays, finished ones included (settling it first if its time ran out): how the screen
   *  recovers a lost or refused response, and what its countdown asks when it reaches 0. */
  async get(partner: PartnerPrincipal, playId: string): Promise<FakeFactState> {
    return act(partner, async (tx) => {
      const { row, ctx } = await lockRow(tx, partner, playId);
      const now = await dbNow(tx);
      if (ctx.cancelled) return { value: toState(row, ctx, now), settled: false };
      const ended = await settleIfOverdue(tx, row, now);
      if (ended) return { value: toState(ended.row, afterSettle(ctx, ended.end), now), settled: true };
      return { value: toState(row, ctx, now), settled: false };
    });
  },

  /** Sweeper: a play left at a deadline is settled where it stood, dated at the deadline; plays a block cancelled are
   *  closed without an event. */
  async sweepOverdue(limit = 100): Promise<number> {
    const due = await sql<{ play_id: string; player_id: string }[]>`
      SELECT g.play_id, g.player_id FROM partner_fake_fact_plays g
      WHERE g.settled_at IS NULL
        AND (g.deadline < clock_timestamp() - make_interval(secs => ${FAKE_FACT_LATE_GRACE_MS / 1000})
          OR EXISTS (SELECT 1 FROM partner_plays p WHERE p.id = g.play_id AND p.state = 'cancelled'))
      ORDER BY g.deadline LIMIT ${limit}`;
    let settled = 0;
    for (const { play_id, player_id } of due) {
      const done = await partnerBegin(async (t) => {
        const tx = asSql(t);
        const active = await lockPlayer(tx, player_id);
        // SKIP LOCKED: a player answering right now, or another replica's sweeper, owns the row.
        const [row] = await tx<PlayRow[]>`
          SELECT ${tx(ROW_COLUMNS)} FROM partner_fake_fact_plays
          WHERE play_id = ${play_id} FOR UPDATE SKIP LOCKED`;
        if (!row || row.settled_at) return false;
        const ctx = await contextOf(tx, play_id, active);
        if (ctx.cancelled) {
          // Closed without an event; a running play of a blocked player is cancelled by the block itself.
          if (ctx.parent.state !== 'cancelled') return false;
          await tx`UPDATE partner_fake_fact_plays SET settled_at = clock_timestamp(), step = 'done' WHERE play_id = ${play_id}`;
          return true;
        }
        return Boolean(await settleIfOverdue(tx, row, await dbNow(tx)));
      }).catch((err) => {
        // One failing play must not hold back the rest of the batch on every run.
        logger.error({ err, playId: play_id }, 'Partner Fake Fact sweep failed for a play');
        return false;
      });
      if (done) settled += 1;
    }
    if (settled > 0) afterPartnerSettle();
    return settled;
  },
};
