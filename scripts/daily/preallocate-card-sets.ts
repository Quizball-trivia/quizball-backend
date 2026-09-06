/**
 * Materialise the next N days of a card-based daily (FIFA Cards or Card
 * Detective) so the schedule exists ahead of time — visible to admins, editable
 * per day, and rotation-consistent because days are allocated in order.
 *
 * Allocation is append-only: it starts at today (UTC) — so today's set is
 * materialised before any future one — and walks forward; existing days are
 * returned as-is. Because each game's `last_served_day` counts future rows
 * too, filling days out of order would skew rotation; the script therefore
 * always continues from the latest scheduled day and refuses to run over gaps.
 *
 *   npx tsx scripts/daily/preallocate-card-sets.ts --type cardDetective --days 60
 *   npx tsx scripts/daily/preallocate-card-sets.ts --type fifaCards --days 60 --dry-run
 */
import 'dotenv/config';
import { sql } from '../../src/db/index.js';
import { dailyChallengesRepo } from '../../src/modules/daily-challenges/daily-challenges.repo.js';

type CardType = 'fifaCards' | 'cardDetective';
const SALT: Record<CardType, string> = {
  fifaCards: 'fifa-cards-rotation-v1',
  cardDetective: 'card-detective-rotation-v1',
};
const TABLE: Record<CardType, string> = {
  fifaCards: 'daily_fifa_card_sets',
  cardDetective: 'daily_card_detective_sets',
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const type = arg('type') as CardType | undefined;
const days = Number(arg('days', '60'));
const dryRun = process.argv.includes('--dry-run');
if (!type || !(type in SALT) || !Number.isInteger(days) || days < 1 || days > 366) {
  console.error('usage: --type fifaCards|cardDetective --days N [--dry-run]');
  process.exit(2);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
};

async function main() {
  const [{ count }] = await sql.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM daily_challenge_configs WHERE challenge_type = $1`, [type]);
  if (count === 0) throw new Error(`No daily_challenge_configs row for ${type} — run migrations first`);
  const [{ card_count: cardCount }] = await sql.unsafe<{ card_count: number }[]>(
    `SELECT COALESCE((settings->>'cardCount')::int, 10) AS card_count FROM daily_challenge_configs WHERE challenge_type = $1`,
    [type]
  );
  const [{ latest }] = await sql.unsafe<{ latest: string | null }[]>(`SELECT max(challenge_day)::text AS latest FROM ${TABLE[type]}`);
  const today = isoDay(new Date());
  const start = latest && latest >= today ? addDays(latest, 1) : today;
  // Gaps only matter when future rows already exist: every day from today up
  // to the latest scheduled one must be present, or first play would allocate
  // an earlier day against future history.
  const [{ gaps }] = latest && latest >= today
    ? await sql.unsafe<{ gaps: number }[]>(
        `SELECT count(*)::int AS gaps FROM generate_series($1::date, $2::date, '1 day') d
         WHERE NOT EXISTS (SELECT 1 FROM ${TABLE[type]} s WHERE s.challenge_day = d)`,
        [today, latest]
      )
    : [{ gaps: 0 }];
  if (gaps > 0) {
    console.error(`ABORT: ${gaps} unscheduled day(s) between today and the latest row — fill them chronologically first (or delete the future rows) so rotation history stays in order`);
    process.exitCode = 2;
    return;
  }
  console.log(`${type}: ${cardCount} cards/day · latest scheduled ${latest ?? 'none'} · allocating ${start} → ${addDays(start, days - 1)}${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) return;

  const allocate = type === 'fifaCards'
    ? dailyChallengesRepo.allocateDailyFifaCardSet
    : dailyChallengesRepo.allocateDailyCardDetectiveSet;
  let day = start;
  for (let i = 0; i < days; i++) {
    const set = await allocate(day, cardCount, SALT[type]);
    if (set.card_ids.length < cardCount) console.warn(`  ${day}: only ${set.card_ids.length}/${cardCount} cards (pool exhausted?)`);
    else console.log(`  ${day}: ${set.card_ids.length} cards`);
    day = addDays(day, 1);
  }
  const [{ total }] = await sql.unsafe<{ total: number }[]>(`SELECT count(*)::int AS total FROM ${TABLE[type]} WHERE challenge_day >= $1`, [today]);
  console.log(`done — ${total} days scheduled from ${today}`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => sql.end({ timeout: 5 }));
