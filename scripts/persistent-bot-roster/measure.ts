/**
 * Pattern-measurement script (READ-ONLY). Produces patterns.json from real
 * staging/prod data, consumed by the generator. Regeneratable and checked in.
 *
 * Usage:
 *   ROSTER_MEASURE_DATABASE_URL=postgres://... \
 *     tsx scripts/persistent-bot-roster/measure.ts [--out patterns.json]
 *
 * Read-only by construction (see readonly-db.ts): a dedicated env var and a
 * server-side default_transaction_read_only session.
 *
 * Filters are composed as plain SQL STRINGS (no dynamic/user input) and run via
 * sql.unsafe(). Every literal below is hard-coded in this file, so there is no
 * injection surface; plain strings also sidestep postgres.js fragment machinery.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openReadOnlyDb } from './readonly-db.js';
import type {
  ActivityPatterns,
  AvatarPatterns,
  ClubPatterns,
  CountryPatterns,
  NameStructurePatterns,
  RenamePatterns,
  RosterPatterns,
  SkillBandPatterns,
  WeightedString,
} from './patterns.js';
import { COUNTRY_CITIES } from './pools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function argVal(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const REAL_FILTER =
  "u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL " +
  "AND EXISTS (SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id)";
const NAME_FILTER =
  REAL_FILTER +
  " AND u.nickname IS NOT NULL AND u.nickname !~ '^Deleted' " +
  "AND EXISTS (SELECT 1 FROM match_players mp WHERE mp.user_id = u.id)";
const AVATAR_FILTER =
  REAL_FILTER + " AND u.avatar_customization IS NOT NULL AND jsonb_typeof(u.avatar_customization) = 'object'";

async function measure(): Promise<RosterPatterns> {
  const db = openReadOnlyDb();
  const q = db.query;

  {
    // Cohort ------------------------------------------------------------
    const [cohort] = await q<{ real_identity: number; named: number; named_played: number; ever_played: number }[]>(`
      SELECT
        (SELECT count(*)::int FROM users u WHERE ${REAL_FILTER}) AS real_identity,
        (SELECT count(*)::int FROM users u WHERE ${REAL_FILTER} AND u.nickname IS NOT NULL AND u.nickname !~ '^Deleted') AS named,
        (SELECT count(DISTINCT u.id)::int FROM users u JOIN match_players mp ON mp.user_id = u.id
           WHERE ${REAL_FILTER} AND u.nickname IS NOT NULL AND u.nickname !~ '^Deleted') AS named_played,
        (SELECT count(DISTINCT mp.user_id)::int FROM match_players mp JOIN users u ON u.id = mp.user_id
           WHERE u.is_ai = false AND u.is_seed = false AND u.is_deleted = false) AS ever_played
    `);

    // Name structure over the named+played cohort (the population bots
    // impersonate). Both cohort sizes are reported for context.
    const [nf] = await q<{
      tot: number; digit: number; space: number; us: number; dot: number; dash: number;
      geo: number; lower: number; upper: number; title: number; oneword: number; twoword: number;
    }[]>(`
      SELECT
        count(*)::int tot,
        count(*) FILTER (WHERE u.nickname ~ '[0-9]')::int digit,
        count(*) FILTER (WHERE u.nickname ~ ' ')::int space,
        count(*) FILTER (WHERE u.nickname ~ '_')::int us,
        count(*) FILTER (WHERE u.nickname ~ '\\.')::int dot,
        count(*) FILTER (WHERE u.nickname ~ '-')::int dash,
        count(*) FILTER (WHERE u.nickname ~ '[Ⴀ-ჿ]')::int geo,
        count(*) FILTER (WHERE u.nickname = lower(u.nickname) AND u.nickname ~ '[a-z]')::int lower,
        count(*) FILTER (WHERE u.nickname = upper(u.nickname) AND u.nickname ~ '[A-Z]')::int upper,
        count(*) FILTER (WHERE u.nickname ~ '^[A-Z][a-z]')::int title,
        count(*) FILTER (WHERE array_length(regexp_split_to_array(trim(u.nickname), '\\s+'), 1) = 1)::int oneword,
        count(*) FILTER (WHERE array_length(regexp_split_to_array(trim(u.nickname), '\\s+'), 1) = 2)::int twoword
      FROM users u WHERE ${NAME_FILTER}
    `);

    const namedCohortSize = cohort!.named;
    const cohortSize = Math.max(nf!.tot, 1);
    const trailing = await q<{ d: string; n: number }[]>(`
      SELECT (regexp_match(u.nickname, '([0-9]+)$'))[1] d, count(*)::int n
      FROM users u WHERE ${NAME_FILTER} AND u.nickname ~ '[0-9]+$'
      GROUP BY 1 ORDER BY n DESC LIMIT 25
    `);

    const rate = (x: number) => +(x / cohortSize).toFixed(4);
    const name: NameStructurePatterns = {
      cohortSize,
      namedCohortSize,
      singleWordRate: rate(nf!.oneword),
      twoWordRate: rate(nf!.twoword),
      digitRate: rate(nf!.digit),
      separators: { underscore: rate(nf!.us), dot: rate(nf!.dot), dash: rate(nf!.dash), space: rate(nf!.space) },
      casing: { allLower: rate(nf!.lower), allUpper: rate(nf!.upper), titleCase: rate(nf!.title) },
      georgianScriptRate: Math.max(rate(nf!.geo), 0.008),
      trailingDigitTokens: trailing.map((t) => ({ value: t.d, weight: t.n })),
    };

    // Avatar wardrobe --------------------------------------------------
    const [av] = await q<{ withav: number; total: number }[]>(`
      SELECT
        (SELECT count(*)::int FROM users u WHERE ${AVATAR_FILTER}) AS withav,
        (SELECT count(*)::int FROM users u WHERE ${REAL_FILTER}) AS total
    `);
    const AVATAR_KEYS = ['hair', 'jersey', 'skin', 'facialHair', 'glasses'] as const;
    const avatarKey = async (key: (typeof AVATAR_KEYS)[number]) =>
      (await q<{ v: string; n: number }[]>(`
        SELECT u.avatar_customization->>'${key}' v, count(*)::int n
        FROM users u WHERE ${AVATAR_FILTER} AND u.avatar_customization ? '${key}'
        GROUP BY 1 ORDER BY n DESC
      `)).filter((r) => r.v != null).map((r) => ({ value: r.v, weight: r.n } as WeightedString));
    const rawHair = await avatarKey('hair');
    const jersey = await avatarKey('jersey');
    const skin = await avatarKey('skin');
    const facialHair = await avatarKey('facialHair');
    const glasses = await avatarKey('glasses');
    const [avExtra] = await q<{ fh: number; gl: number; withav: number }[]>(`
      SELECT
        count(*) FILTER (WHERE u.avatar_customization ? 'facialHair')::int fh,
        count(*) FILTER (WHERE u.avatar_customization ? 'glasses')::int gl,
        count(*)::int withav
      FROM users u WHERE ${AVATAR_FILTER}
    `);

    // OVERRIDE hair: real hair is ~92% the app default (hair_boy_basic), an
    // artifact of most users never customizing. Reproducing it would make 1,000
    // bots look copy-pasted; flatten the default to a plurality and lift the rest.
    const overriddenHair = rebalanceHair(rawHair);
    const withavCount = avExtra!.withav || 1;
    const avatar: AvatarPatterns = {
      source: 'overridden',
      presenceRate: Math.max(+(av!.withav / Math.max(av!.total, 1)).toFixed(4), 0.05),
      hair: overriddenHair,
      jersey,
      skin,
      facialHairRate: +(avExtra!.fh / withavCount).toFixed(4),
      facialHair,
      glassesRate: +(avExtra!.gl / withavCount).toFixed(4),
      glasses,
      rawHairMeasured: rawHair,
    };

    // Country ----------------------------------------------------------
    const rawCountry = await q<{ c: string; n: number }[]>(`
      SELECT COALESCE(u.country, '(null)') c, count(*)::int n
      FROM users u WHERE ${REAL_FILTER} GROUP BY 1 ORDER BY n DESC LIMIT 25
    `);
    const country: CountryPatterns = {
      source: 'overridden',
      rationale:
        'Raw country is FI-dominated: geoip defaults ~97% of never-named signups to FI (0 Georgian-script names among them). ' +
        'The product is Georgian-first, so the generator imposes a GE-dominant distribution with a small international tail. ' +
        'This is a deliberate override of a measurement artifact, not a mimic of measured data.',
      distribution: [
        { value: 'GE', weight: 85 },
        { value: 'US', weight: 3 },
        { value: 'GB', weight: 3 },
        { value: 'TR', weight: 2 },
        { value: 'GR', weight: 2 },
        { value: 'DE', weight: 2 },
        { value: 'ES', weight: 3 },
      ].filter((c) => COUNTRY_CITIES[c.value]),
      rawMeasured: rawCountry.map((r) => ({ value: r.c, weight: r.n })),
      cities: Object.entries(COUNTRY_CITIES).map(([code, cities]) => ({ code, cities })),
    };

    // Club -------------------------------------------------------------
    const [clubAgg] = await q<{ nn: number; tot: number }[]>(`
      SELECT count(*) FILTER (WHERE u.favorite_club IS NOT NULL)::int nn, count(*)::int tot
      FROM users u WHERE ${REAL_FILTER}
    `);
    const clubTop = await q<{ fc: string; n: number }[]>(`
      SELECT u.favorite_club fc, count(*)::int n
      FROM users u WHERE ${REAL_FILTER} AND u.favorite_club IS NOT NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 20
    `);
    const club: ClubPatterns = {
      source: 'measured',
      nonNullRate: +(clubAgg!.nn / Math.max(clubAgg!.tot, 1)).toFixed(4),
      distribution: clubTop.map((r) => ({ value: r.fc, weight: r.n })),
    };

    // Activity ---------------------------------------------------------
    const hourly = await q<{ h: number; n: number }[]>(`
      SELECT EXTRACT(hour FROM (m.started_at AT TIME ZONE 'Asia/Tbilisi'))::int h, count(*)::int n
      FROM matches m JOIN match_players mp ON mp.match_id = m.id JOIN users u ON u.id = mp.user_id
      WHERE u.is_ai = false AND u.is_seed = false AND m.is_dev = false
        AND m.started_at IS NOT NULL AND m.started_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1
    `);
    const hist = new Array(24).fill(0);
    for (const r of hourly) hist[r.h] = r.n;

    const [mpd] = await q<{ p50: number; p75: number; p90: number; p99: number; mx: number }[]>(`
      WITH pd AS (
        SELECT mp.user_id, (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date d, count(*)::int c
        FROM matches m JOIN match_players mp ON mp.match_id = m.id JOIN users u ON u.id = mp.user_id
        WHERE u.is_ai = false AND u.is_seed = false AND m.is_dev = false
          AND m.started_at > now() - interval '30 days'
        GROUP BY 1, 2
      )
      SELECT
        percentile_disc(0.5) WITHIN GROUP (ORDER BY c)::int p50,
        percentile_disc(0.75) WITHIN GROUP (ORDER BY c)::int p75,
        percentile_disc(0.9) WITHIN GROUP (ORDER BY c)::int p90,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY c)::int p99,
        max(c)::int mx
      FROM pd
    `);
    const activity: ActivityPatterns = {
      source: 'measured',
      hourlyHistogram: hist,
      dailyCapQuantiles: [
        [0.5, Math.max(mpd!.p50, 2)],
        [0.75, Math.max(mpd!.p75, 3)],
        [0.9, Math.max(mpd!.p90, 8)],
        [0.99, Math.max(mpd!.p99, 14)],
        [1.0, Math.max(mpd!.mx, 20)],
      ],
      scheduleArchetypes: deriveArchetypes(hist),
    };

    // Rename -----------------------------------------------------------
    const [rn] = await q<{ renamed_users: number }[]>(`
      SELECT count(DISTINCT nh.user_id)::int renamed_users
      FROM nickname_history nh JOIN users u ON u.id = nh.user_id
      WHERE u.is_ai = false AND nh.counted = true
    `);
    const rename: RenamePatterns = {
      source: 'overridden',
      lifetimeRate: 0.12,
      rawMeasuredRate: +(rn!.renamed_users / Math.max(cohort!.named, 1)).toFixed(4),
    };

    const skill: SkillBandPatterns = {
      bandWeights: [20, 30, 30, 15, 5],
      bandRanges: [
        [0.05, 0.25],
        [0.25, 0.45],
        [0.45, 0.6],
        [0.6, 0.75],
        [0.75, 0.9],
      ],
    };

    // Frozen exclusion set --------------------------------------------
    const exclusionRows = await q<{ x: string }[]>(`
      SELECT DISTINCT lower(x) x FROM (
        SELECT nickname x FROM users WHERE nickname IS NOT NULL
        UNION SELECT old_nickname FROM nickname_history WHERE old_nickname IS NOT NULL
        UNION SELECT new_nickname FROM nickname_history WHERE new_nickname IS NOT NULL
      ) s WHERE x IS NOT NULL
    `);
    const names = exclusionRows.map((r) => r.x.normalize('NFC')).sort();
    const exclusionSha = createHash('sha256').update(names.join('\n')).digest('hex');

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      measuredAgainst: maskDsn(process.env.ROSTER_MEASURE_DATABASE_URL!),
      cohort: {
        realWithIdentity: cohort!.real_identity,
        namedUsers: cohort!.named,
        namedAndPlayed: cohort!.named_played,
        everPlayed: cohort!.ever_played,
      },
      exclusion: { count: names.length, sha256: exclusionSha, names },
      name,
      avatar,
      country,
      club,
      activity,
      rename,
      skill,
    } satisfies RosterPatterns;
  }
}

function rebalanceHair(raw: WeightedString[]): WeightedString[] {
  if (raw.length === 0) return [{ value: 'hair_boy_basic', weight: 1 }];
  const sorted = [...raw].sort((a, b) => b.weight - a.weight);
  return sorted.map((h, i) => ({ value: h.value, weight: i === 0 ? 35 : Math.max(h.weight, 8) }));
}

function deriveArchetypes(hist: number[]): ActivityPatterns['scheduleArchetypes'] {
  // Sum hist over the half-open hour window [a, b) with wraparound. `count` is
  // the number of hours to walk, so the loop always terminates (an `h !== b`
  // condition would spin forever when b wraps, e.g. mass(17, 24)).
  const mass = (a: number, count: number) => {
    let s = 0;
    for (let i = 0; i < count; i++) s += hist[(a + i) % 24] ?? 0;
    return s;
  };
  // Non-overlapping day windows for the three mainstream archetypes.
  const evening = mass(17, 7); // 17:00-23:59
  const daytime = mass(11, 6); // 11:00-16:59
  const morning = mass(6, 5); // 06:00-10:59
  const total = Math.max(evening + daytime + morning, 1);
  const w = (x: number) => Math.max(Math.round((x / total) * 97), 3);
  // Night-owl is deliberately a small MINORITY archetype (~2-3%, plan §1.3): the
  // aggregate 00:00-05:00 histogram mass is inflated by a handful of very active
  // night players, so weighting the archetype by raw mass would badly overstate
  // how many bots are night-owls. Fixed small weight; per-user preference, not
  // population match volume, is what this archetype models.
  return [
    { key: 'evening', weight: w(evening), startHour: 17, endHour: 25, sessionLength: [2, 5] },
    { key: 'daytime', weight: w(daytime), startHour: 11, endHour: 17, sessionLength: [1, 4] },
    { key: 'morning', weight: w(morning), startHour: 7, endHour: 11, sessionLength: [1, 3] },
    { key: 'night_owl', weight: 3, startHour: 0, endHour: 2, sessionLength: [1, 4] },
  ];
}

function maskDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
  } catch {
    return '(unparseable dsn)';
  }
}

async function main() {
  const outArg = argVal('--out', path.join(__dirname, 'patterns.json'));
  const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);
  const patterns = await measure();
  writeFileSync(outPath, JSON.stringify(patterns, null, 2) + '\n');
  process.stdout.write(`Wrote ${outPath}\n`);
  process.stdout.write(`Cohort: ${JSON.stringify(patterns.cohort)}\n`);
  process.stdout.write(`Exclusion set: ${patterns.exclusion.count} names, sha256=${patterns.exclusion.sha256.slice(0, 16)}...\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`measure failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
