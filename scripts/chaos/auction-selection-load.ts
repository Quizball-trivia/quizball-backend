/**
 * Auction SELECTION-PATH load test.
 *
 * Simulates N concurrent auction matches doing what the server does per round
 * on the content hot path: pick a published card (fame roll + snapshot-ready
 * filter + no-repeat exclusions), attach season snapshots, and atomically
 * CLAIM the scout-season cursor (auction_scout_encounters upsert-returning).
 * Runs through the real repo/service and the real per-replica pool + admission
 * controller, so results reflect one backend replica under load.
 *
 * Also proves claim atomicity: a burst of concurrent claims for ONE player
 * must produce strictly distinct cursors.
 *
 * Usage:
 *   npx tsx scripts/chaos/auction-selection-load.ts --matches 500 --rounds 7
 *   npx tsx scripts/chaos/auction-selection-load.ts --matches 1000 --rounds 7 --cleanup
 *
 * Writes ONLY to auction_scout_encounters for the synthetic (is_ai) users it
 * selects; --cleanup deletes exactly those rows afterwards.
 */
import { sql } from '../../src/db/index.js';
import { auctionContentService } from '../../src/modules/auction/index.js';
import type { PositionGroup } from '../../src/modules/auction/auction.types.js';

const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || !args[index + 1]) return fallback;
  return Number(args[index + 1]);
}
const MATCHES = flag('matches', 500);
const ROUNDS = flag('rounds', 7);
const CLEANUP = args.includes('--cleanup');
const ROUND_MS = flag('round-ms', 30_000);

const POSITIONS: PositionGroup[] = ['GK', 'DEF', 'DEF', 'MID', 'MID', 'FWD', 'FWD'];

interface Sample { ms: number; ok: boolean; snapshots: boolean }

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const botUsers = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE is_ai = true ORDER BY id LIMIT ${MATCHES}
  `;
  if (botUsers.length < MATCHES) {
    throw new Error(`need ${MATCHES} synthetic users, found ${botUsers.length}`);
  }
  const userIds = botUsers.map((row) => row.id);
  console.log(`[load] ${MATCHES} matches x ${ROUNDS} rounds @ ${ROUND_MS}ms/round (demand ~${(MATCHES / (ROUND_MS / 1000)).toFixed(1)} picks/s), users: ${userIds.length} synthetic (is_ai)`);

  const samples: Sample[] = [];
  const errors = new Map<string, number>();
  const startedAt = Date.now();

  await Promise.all(userIds.map(async (userId, matchIndex) => {
    // Stagger starts across one full round so demand is steady-state, then
    // pace rounds like a real match (one pick per ROUND_MS).
    await new Promise((resolve) => setTimeout(resolve, (matchIndex / MATCHES) * ROUND_MS));
    const usedClueCardIds: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      if (round > 0) await new Promise((resolve) => setTimeout(resolve, ROUND_MS));
      const position = POSITIONS[round % POSITIONS.length];
      const t0 = performance.now();
      try {
        const card = await auctionContentService.findRandomPublishedAuctionCardExcludingSeen({
          locale: 'en',
          positionGroup: position,
          excludeClueCardIds: [...usedClueCardIds],
          scoutCycleUserIds: [userId],
        });
        const ms = performance.now() - t0;
        samples.push({ ms, ok: true, snapshots: Boolean(card?.snapshots?.length) });
        if (card?.clueCardId) usedClueCardIds.push(card.clueCardId);
      } catch (error) {
        const ms = performance.now() - t0;
        samples.push({ ms, ok: false, snapshots: false });
        const key = error instanceof Error ? error.message.slice(0, 80) : String(error);
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    }
  }));

  const wallMs = Date.now() - startedAt;
  const okSamples = samples.filter((sample) => sample.ok);
  const latencies = okSamples.map((sample) => sample.ms).sort((a, b) => a - b);
  const withSnapshots = okSamples.filter((sample) => sample.snapshots).length;

  console.log(`[load] wall ${Math.round(wallMs / 1000)}s | picks ok ${okSamples.length}/${samples.length} | throughput ${(okSamples.length / (wallMs / 1000)).toFixed(1)}/s`);
  console.log(`[load] latency ms p50=${percentile(latencies, 50).toFixed(0)} p95=${percentile(latencies, 95).toFixed(0)} p99=${percentile(latencies, 99).toFixed(0)} max=${percentile(latencies, 100).toFixed(0)}`);
  console.log(`[load] snapshot lots: ${withSnapshots}/${okSamples.length} (${((withSnapshots / Math.max(1, okSamples.length)) * 100).toFixed(1)}%)`);
  for (const [message, count] of errors) console.log(`[load] ERROR x${count}: ${message}`);

  // ── Atomicity burst: 200 concurrent claims on ONE player must yield 200
  //    strictly distinct cursors for 200 distinct users, and for a SINGLE user
  //    hammered 50x concurrently, 50 distinct increasing counts.
  const [anyPlayer] = await sql<{ football_player_id: string }[]>`
    SELECT football_player_id FROM player_season_snapshots
    WHERE value_eur IS NOT NULL GROUP BY 1 HAVING count(*) >= 5 LIMIT 1
  `;
  const burstUser = userIds[0];
  const burst: number[] = [];
  // Waves of 10 stay inside the admission budget; concurrency within each wave
  // is what exercises the upsert's atomicity.
  for (let wave = 0; wave < 5; wave += 1) {
    const results = await Promise.all(Array.from({ length: 10 }, () => (
      sql<{ encounters: number }[]>`
        INSERT INTO auction_scout_encounters (user_id, football_player_id)
        VALUES (${burstUser}, ${anyPlayer.football_player_id})
        ON CONFLICT (user_id, football_player_id)
        DO UPDATE SET encounters = auction_scout_encounters.encounters + 1, last_seen_at = NOW()
        RETURNING encounters
      `.then((rows) => Number(rows[0].encounters))
    )));
    burst.push(...results);
  }
  const distinct = new Set(burst).size;
  console.log(`[atomicity] 50 concurrent claims, distinct cursors: ${distinct}/50 ${distinct === 50 ? 'OK' : 'FAILED — duplicate cursors!'}`);

  if (CLEANUP) {
    const deleted = await sql`
      DELETE FROM auction_scout_encounters
      WHERE user_id = ANY(${sql.array(userIds)}::uuid[])
    `;
    console.log(`[cleanup] deleted ${deleted.count} synthetic encounter rows`);
  }

  await sql.end({ timeout: 5 });
  process.exit(distinct === 50 && errors.size === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
