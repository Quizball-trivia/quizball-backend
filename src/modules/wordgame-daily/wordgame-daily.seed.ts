import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { addDays } from '../daily/daily.calendar.js';
import { canonical } from '../pistas/pistas.seed.js';
import { CONTENT_START as NAME_CHAIN_START } from '../name-chain-daily/name-chain-daily.days.js';
import { nameChainPackSchema } from '../room/games/name-chain/name-chain.engine.js';
import { sharedPlayerPackSchema } from '../room/games/shared-player/shared-player.engine.js';
import { CONTENT_START as SHARED_PLAYER_START } from '../shared-player-daily/shared-player-daily.days.js';

/**
 * Day seeding for the two word-game dailies (scripts/wordgames-seed-days.ts): validates the private days file and
 * writes it in one transaction. Nothing here may print a footballer or a club: messages name days and counts only.
 */
export const WORDGAME_DAILIES = ['shared_player', 'name_chain'] as const;
export type WordgameDaily = (typeof WORDGAME_DAILIES)[number];

/** Seeds of the dailies and of the room pool take the same lock, so the daily / room overlap check cannot be raced. */
export const WORDGAMES_CONTENT_LOCK = 'wordgames-content';
const MAX_CLUB_REPEATS = 2;

const GAMES = {
  shared_player: { days: 'shared_player_days', runs: 'shared_player_runs', payload: 'pairs', contentStart: SHARED_PLAYER_START, schema: sharedPlayerPackSchema as z.ZodTypeAny },
  name_chain: { days: 'name_chain_days', runs: 'name_chain_runs', payload: 'chain', contentStart: NAME_CHAIN_START, schema: nameChainPackSchema as z.ZodTypeAny },
} as const;

export interface SeedDay { day: string; number: number; contentVersion: number; content: Record<string, unknown> }

const fileSchema = z.object({
  game: z.enum(WORDGAME_DAILIES),
  days: z.array(z.object({ day: z.string(), number: z.number().int(), content: z.record(z.unknown()) }).strict()).min(1),
}).strict();

/** A day's content version: sha256 over the canonical JSON of the stored content, first 8 hex digits. */
export const contentHash = (content: unknown): number => parseInt(createHash('sha256').update(canonical(content)).digest('hex').slice(0, 8), 16) || 1;

const dayNumberFrom = (start: string, day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;

const releaseOf = (day: SeedDay): string => (day.content as { release: string }).release;

/**
 * Validates a days file: contiguous days from the game's first content day, every day a valid pack. A day names the
 * footballer release that judges it, so a file may hold more than one: played days stay on theirs (re-pointing them
 * would be a correction that unranks their runs) while later days move to a newer one. The process holds two releases
 * at a time (footballers.service MAX_HELD); `releases` is in order of first use.
 */
export function parseDaysFile(raw: unknown): { game: WordgameDaily; releases: string[]; days: SeedDay[] } {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid days file: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')} ${i.code}`).join('; ')}`);
  const { game } = parsed.data;
  const config = GAMES[game];
  const releases: string[] = [];
  const pairIds = new Set<string>();
  const days = parsed.data.days.map((d, i): SeedDay => {
    const expected = addDays(config.contentStart, i);
    if (d.day !== expected) throw new Error(`days must be contiguous from ${config.contentStart}: position ${i + 1} is ${d.day}, expected ${expected}`);
    if (d.number !== dayNumberFrom(config.contentStart, d.day)) throw new Error(`${d.day}: number must be ${dayNumberFrom(config.contentStart, d.day)}`);
    const content = config.schema.safeParse(d.content);
    // The issue path names the field; its message could quote content, so only the path is printed.
    if (!content.success) throw new Error(`${d.day}: invalid content (${content.error.issues.slice(0, 4).map((issue) => issue.path.join('.') || 'shape').join(', ')})`);
    const release = (content.data as { release: string }).release;
    if (!releases.includes(release)) releases.push(release);
    if (game === 'shared_player') {
      const pairs = (content.data as z.infer<typeof sharedPlayerPackSchema>).pairs;
      const clubs = new Map<string, number>();
      for (const pair of pairs) {
        // The same two clubs under another id are the same pair: yesterday's answers would be today's.
        const clubsKey = clubPairKey(pair.a.key, pair.b.key);
        if (pairIds.has(pair.id) || pairIds.has(clubsKey)) throw new Error(`${d.day}: a pair appears on more than one day`);
        pairIds.add(pair.id);
        pairIds.add(clubsKey);
        if (new Set(pair.accepted).size !== pair.accepted.length) throw new Error(`${d.day}: a pair lists an accepted footballer twice`);
        if (pair.examples > pair.accepted.length) throw new Error(`${d.day}: a pair names more examples than accepted footballers`);
        for (const key of [pair.a.key, pair.b.key]) clubs.set(key, (clubs.get(key) ?? 0) + 1);
        if (pair.a.key === pair.b.key) throw new Error(`${d.day}: a pair of one club`);
      }
      if (Math.max(...clubs.values()) > MAX_CLUB_REPEATS) throw new Error(`${d.day}: a club appears more than ${MAX_CLUB_REPEATS} times`);
    }
    return { day: d.day, number: d.number, contentVersion: contentHash(content.data), content: content.data as Record<string, unknown> };
  });
  return { game, releases, days };
}

/** A pair of clubs whatever its order or its id. */
export const clubPairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export interface SeedOutcome { fresh: number; unchanged: number; corrected: number; unranked: number }

/**
 * Writes the days in ONE transaction under the word games content lock. Refused: a release that is not seeded here, an
 * accepted footballer the release does not know, a daily pair that is also a room pair (a room reveal would hand out a
 * daily answer), and a changed day that already has runs unless `allowCorrection` (its ranked runs are then unranked).
 */
export async function seedDays(sql: Sql, input: { game: WordgameDaily; days: readonly SeedDay[] }, opts: { dryRun: boolean; allowCorrection: boolean }): Promise<SeedOutcome> {
  const config = GAMES[input.game];
  return sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    // The production role kills a transaction idle for 15 s; keep generous but bounded budgets.
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`SET LOCAL statement_timeout = '120s'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '120s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtext(${WORDGAMES_CONTENT_LOCK}))`;
    await tx`LOCK TABLE ${tx.unsafe(config.days)} IN SHARE ROW EXCLUSIVE MODE`;
    const releases = [...new Set(input.days.map(releaseOf))];
    const seeded = new Set((await tx<Array<{ id: string }>>`SELECT id FROM wordgame_releases WHERE id = ANY(${tx.array(releases)}::text[])`).map((r) => r.id));
    const missing = releases.filter((id) => !seeded.has(id));
    if (missing.length > 0) throw new Error(`Footballer release ${missing.join(', ')} is not seeded here; run wordgames-seed-release first`);
    if (input.game === 'shared_player') {
      const pairs = input.days.flatMap((d) => (d.content as z.infer<typeof sharedPlayerPackSchema>).pairs);
      // By id and by the two clubs: the same pair under another id would leak just the same.
      const [{ n: inRooms }] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM room_pool WHERE game = 'shared_player' AND (
          item_id = ANY(${tx.array(pairs.map((p) => p.id))}::text[])
          OR least(payload->'a'->>'key', payload->'b'->>'key') || '|' || greatest(payload->'a'->>'key', payload->'b'->>'key') = ANY(${tx.array(pairs.map((p) => clubPairKey(p.a.key, p.b.key)))}::text[])
        )`;
      if (inRooms > 0) throw new Error(`${inRooms} daily pair(s) are also room pairs; refused (a room reveal would hand out a daily answer)`);
      // A day that stays stored (not in this file) must not share a pair with a day being written: its answers would
      // be readable through the other day once that one is closed.
      const [{ n: inOtherDays }] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM shared_player_days d CROSS JOIN LATERAL jsonb_array_elements(d.pairs->'pairs') AS p(pair)
        WHERE d.day <> ALL(${tx.array(input.days.map((d) => d.day))}::date[]) AND (
          p.pair->>'id' = ANY(${tx.array(pairs.map((p) => p.id))}::text[])
          OR least(p.pair->'a'->>'key', p.pair->'b'->>'key') || '|' || greatest(p.pair->'a'->>'key', p.pair->'b'->>'key') = ANY(${tx.array(pairs.map((p) => clubPairKey(p.a.key, p.b.key)))}::text[])
        )`;
      if (inOtherDays > 0) throw new Error(`${inOtherDays} pair(s) are already on a stored day outside this file; refused`);
      // Every day is judged by its own release: its accepted footballers must be in that one.
      for (const release of releases) {
        const accepted = [...new Set(input.days.filter((d) => releaseOf(d) === release).flatMap((d) => (d.content as z.infer<typeof sharedPlayerPackSchema>).pairs).flatMap((p) => p.accepted))];
        let unknown = 0;
        for (let i = 0; i < accepted.length; i += 5_000) {
          const [{ n }] = await tx<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM unnest(${tx.array(accepted.slice(i, i + 5_000))}::text[]) AS a(pid)
            WHERE NOT EXISTS (SELECT 1 FROM wordgame_players p WHERE p.release_id = ${release} AND p.pid = a.pid)`;
          unknown += n;
        }
        if (unknown > 0) throw new Error(`${unknown} accepted footballers are not in release ${release}; nothing written`);
      }
    }
    const stored = new Map((await tx<Array<{ day: string; contentVersion: string }>>`
      SELECT day::text AS day, content_version AS "contentVersion" FROM ${tx.unsafe(config.days)}`).map((r) => [r.day, Number(r.contentVersion)]));
    const changed = input.days.filter((d) => stored.has(d.day) && stored.get(d.day) !== d.contentVersion).map((d) => d.day).sort();
    // Every start and move holds FOR SHARE on its day row until it commits; FOR UPDATE on the corrected days waits for
    // those in flight and holds back new ones, so the run counts below are final.
    if (changed.length > 0) await tx`SELECT day FROM ${tx.unsafe(config.days)} WHERE day = ANY(${tx.array(changed)}::date[]) ORDER BY day FOR UPDATE`;
    const played = new Map((await tx<Array<{ day: string; runs: number }>>`
      SELECT day::text AS day, count(*)::int AS runs FROM ${tx.unsafe(config.runs)} WHERE day = ANY(${tx.array(changed)}::date[]) GROUP BY day`).map((r) => [r.day, r.runs]));
    const blocked = changed.filter((day) => (played.get(day) ?? 0) > 0);
    if (blocked.length > 0 && !opts.allowCorrection) throw new Error(`Refusing to change days that already have runs (${blocked.join(', ')}); pass --allow-correction to correct them (their ranked runs are unranked)`);
    const outcome: SeedOutcome = { fresh: 0, unchanged: 0, corrected: 0, unranked: 0 };
    for (const d of input.days) {
      if (!stored.has(d.day)) outcome.fresh += 1;
      else if (stored.get(d.day) === d.contentVersion) { outcome.unchanged += 1; continue; }
      else outcome.corrected += 1;
      if (opts.dryRun) continue;
      await tx`
        INSERT INTO ${tx.unsafe(config.days)} (day, number, content_version, ${tx.unsafe(config.payload)})
        VALUES (${d.day}, ${d.number}, ${d.contentVersion}, ${tx.json(d.content as never)})
        ON CONFLICT (day) DO UPDATE SET number = EXCLUDED.number, content_version = EXCLUDED.content_version, ${tx.unsafe(config.payload)} = EXCLUDED.${tx.unsafe(config.payload)}
      `;
      if (stored.has(d.day) && (played.get(d.day) ?? 0) > 0) outcome.unranked += (await tx`UPDATE ${tx.unsafe(config.runs)} SET ranked = false WHERE day = ${d.day} AND ranked`).count;
    }
    return outcome;
  }) as Promise<SeedOutcome>;
}
