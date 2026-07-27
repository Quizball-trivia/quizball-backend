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

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openReadOnlyDb } from './readonly-db.js';
import { buildExclusion } from './exclusion.js';
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

    // Activity — per-user sessionization (§1.3) -------------------------
    // Pull each real player's match-start timestamps (epoch seconds, Tbilisi
    // local hour + local day), then segment into sessions on 20-minute gaps and
    // build a per-user tuple in JS. An aggregate histogram cannot yield per-user
    // patterns, so the clustering happens over per-user tuples, not the hist.
    const starts = await q<{ user_id: string; epoch: number; hour: number; day: string }[]>(`
      SELECT mp.user_id,
             extract(epoch FROM m.started_at)::bigint AS epoch,
             extract(hour FROM (m.started_at AT TIME ZONE 'Asia/Tbilisi'))::int AS hour,
             (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day
      FROM matches m JOIN match_players mp ON mp.match_id = m.id JOIN users u ON u.id = mp.user_id
      WHERE u.is_ai = false AND u.is_seed = false AND m.is_dev = false
        AND m.started_at IS NOT NULL AND m.started_at > now() - interval '60 days'
      ORDER BY mp.user_id, m.started_at
    `);
    // Retain the raw histogram purely for report disclosure.
    const hist = new Array(24).fill(0);
    for (const r of starts) hist[r.hour] = (hist[r.hour] ?? 0) + 1;

    const activity: ActivityPatterns = buildActivityModel(starts, hist);

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

    // Category slugs (real, active, non-format) -----------------------
    // Skill affinities must key on LIVE slugs (hyphenated). Exclude the
    // daily-challenge FORMAT sub-categories — they are quiz formats, not skill
    // domains — and any inactive category.
    const catRows = await q<{ slug: string }[]>(`
      SELECT slug FROM categories
      WHERE is_active = true AND slug NOT LIKE 'daily-challenges%'
      ORDER BY slug
    `);
    const categorySlugs = catRows.map((r) => r.slug);

    // Frozen exclusion set (salted-hash, privacy-preserving) ----------
    // Fetch RAW names (no SQL lower/DISTINCT): NFC-normalization must happen
    // BEFORE dedup so canonically-equal but byte-different names collapse to one
    // entry. Then salt + hash + dedup + sort. Plaintext never leaves this scope.
    const exclusionRows = await q<{ x: string }[]>(`
      SELECT x FROM (
        SELECT nickname x FROM users WHERE nickname IS NOT NULL
        UNION ALL SELECT old_nickname FROM nickname_history WHERE old_nickname IS NOT NULL
        UNION ALL SELECT new_nickname FROM nickname_history WHERE new_nickname IS NOT NULL
      ) s WHERE x IS NOT NULL
    `);
    const rawNames = exclusionRows.map((r) => r.x);
    const salt = randomBytes(16).toString('hex');
    const exclusion = buildExclusion(rawNames, salt);

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      // Non-identifying label only (no project ref / role / pooler host).
      measuredAgainst: `${envTag()} @ ${new Date().toISOString()}`,
      cohort: {
        realWithIdentity: cohort!.real_identity,
        namedUsers: cohort!.named,
        namedAndPlayed: cohort!.named_played,
        everPlayed: cohort!.ever_played,
      },
      exclusion,
      categorySlugs,
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

interface StartRow {
  user_id: string;
  epoch: number;
  hour: number;
  day: string;
}

/** Per-user activity profile derived from that user's match-start sequence. */
interface UserProfile {
  peakHour: number; // modal local start hour
  medianSessionLen: number; // matches per session (20-min-gap segmentation)
  peakDayCap: number; // busiest single day's match count
}

const SESSION_GAP_SECONDS = 20 * 60; // §1.3: gaps < 20min are the same session

/**
 * Build the activity model by PER-USER sessionization + clustering (§1.3):
 *   1. For each user, segment their ordered match-starts into sessions on
 *      20-minute gaps; record modal hour, median session length, and busiest-day
 *      match count.
 *   2. Assign each user to one of four hour-band archetypes by modal hour, with
 *      night-owl fixed to the plan's 07:00–01:23 window (night = 00:00–01:23 or
 *      the pre-dawn tail). Archetype weight = share of users.
 *   3. Per archetype, derive the daily-cap quantiles from ITS members' peak-day
 *      counts — so (schedule, cap) are jointly consistent (night-owls, whose
 *      windows are short, cannot draw a 15-match cap).
 */
function buildActivityModel(starts: StartRow[], hist: number[]): ActivityPatterns {
  // Group by user, preserving the query's per-user time order.
  const byUser = new Map<string, StartRow[]>();
  for (const r of starts) {
    const arr = byUser.get(r.user_id);
    if (arr) arr.push(r);
    else byUser.set(r.user_id, [r]);
  }

  const profiles: UserProfile[] = [];
  for (const rows of byUser.values()) {
    if (rows.length === 0) continue;
    // Modal hour.
    const hourCounts = new Array(24).fill(0);
    for (const r of rows) hourCounts[r.hour]++;
    let peakHour = 0;
    for (let h = 1; h < 24; h++) if (hourCounts[h] > hourCounts[peakHour]) peakHour = h;

    // Sessionize on 20-min gaps; collect session lengths.
    const sessionLens: number[] = [];
    let curLen = 1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.epoch - rows[i - 1]!.epoch <= SESSION_GAP_SECONDS) {
        curLen++;
      } else {
        sessionLens.push(curLen);
        curLen = 1;
      }
    }
    sessionLens.push(curLen);
    const medianSessionLen = median(sessionLens);

    // Busiest single day's match count = a per-user cap proxy.
    const dayCounts = new Map<string, number>();
    for (const r of rows) dayCounts.set(r.day, (dayCounts.get(r.day) ?? 0) + 1);
    const peakDayCap = Math.max(...dayCounts.values());

    profiles.push({ peakHour, medianSessionLen, peakDayCap });
  }

  // Archetype assignment by modal hour band. The 22:00–01:59 tail is folded into
  // EVENING; true night_owl is only the 02:00–05:59 pre-dawn minority.
  const archetypeOf = (peakHour: number): 'evening' | 'daytime' | 'morning' | 'night_owl' => {
    if (peakHour >= 2 && peakHour <= 5) return 'night_owl';
    if (peakHour >= 6 && peakHour <= 10) return 'morning';
    if (peakHour >= 11 && peakHour <= 16) return 'daytime';
    return 'evening'; // 17:00–01:59 (incl. the late-night tail)
  };

  const buckets: Record<string, UserProfile[]> = { evening: [], daytime: [], morning: [], night_owl: [] };
  for (const p of profiles) buckets[archetypeOf(p.peakHour)]!.push(p);

  const windows: Record<string, { startHour: number; endHour: number }> = {
    // Night window ends 01:23 per plan §1.3 (endHour 25.38 ≈ 01:23 next day).
    evening: { startHour: 17, endHour: 25.38 },
    daytime: { startHour: 11, endHour: 17 },
    morning: { startHour: 7, endHour: 11 },
    night_owl: { startHour: 0, endHour: 5 },
  };

  // OVERRIDE the archetype MIX to the plan's design (evening-dominant, night-owl
  // a 2-3% minority). Reason: the per-user MODAL-HOUR signal is contaminated — a
  // spurious spike puts ~46% of users at exactly 00:00 Tbilisi (a timestamp
  // artifact, not real behaviour), so weighting the mix by measured modal hours
  // is meaningless. The per-user SESSION-LENGTH and CAP distributions below ARE
  // used (they are robust to the hour artifact); only the mix weight is imposed.
  const OVERRIDE_WEIGHTS: Record<string, number> = { evening: 55, daytime: 30, morning: 12, night_owl: 3 };
  // Night-owls get short windows, so cap them below the plan's 15 ceiling.
  const NIGHT_OWL_CAP_CEILING = 8;

  const archetypes = (['evening', 'daytime', 'morning', 'night_owl'] as const).map((key) => {
    // Session length + cap come from the per-user tuples of THIS cluster; if a
    // cluster is thin (e.g. night_owl under the artifact), fall back to all users
    // so we still have a robust cap/session distribution.
    const members = buckets[key]!.length >= 30 ? buckets[key]! : profiles;
    const sessionLens = members.map((m) => m.medianSessionLen).sort((a, b) => a - b);
    const caps = members.map((m) => m.peakDayCap).sort((a, b) => a - b);
    const loLen = Math.max(1, Math.round(quantileOf(sessionLens, 0.25) || 1));
    const hiLen = Math.max(loLen, Math.round(quantileOf(sessionLens, 0.9) || 3));
    const cap = (p: number) => {
      let v = Math.max(1, quantileOf(caps, p));
      if (key === 'night_owl') v = Math.min(v, NIGHT_OWL_CAP_CEILING);
      return v;
    };
    const capQ: [number, number][] = caps.length
      ? [[0.5, cap(0.5)], [0.75, cap(0.75)], [0.9, cap(0.9)], [0.99, cap(0.99)], [1.0, cap(1.0)]]
      : [[1.0, key === 'night_owl' ? 3 : 5]];
    return {
      key,
      weight: OVERRIDE_WEIGHTS[key]!,
      startHour: windows[key]!.startHour,
      endHour: windows[key]!.endHour,
      sessionLength: [loLen, hiLen] as [number, number],
      dailyCapQuantiles: capQ,
    };
  });

  return {
    // Per-user session/cap distributions are MEASURED; the archetype MIX weight
    // is OVERRIDDEN (contaminated modal-hour signal) — hence 'overridden'.
    source: 'overridden',
    hourlyHistogram: hist,
    scheduleArchetypes: archetypes,
    usersClustered: profiles.length,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Discrete quantile of a PRE-SORTED ascending array. */
function quantileOf(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * A NON-identifying environment label. Never emit the DSN's project ref, role,
 * or pooler host — those leak into committed artifacts. Prefer an explicit
 * ROSTER_ENV_TAG; otherwise coarse-classify by known Supabase project refs
 * without echoing them.
 */
function envTag(): string {
  const explicit = process.env.ROSTER_ENV_TAG;
  if (explicit) return explicit;
  const dsn = process.env.ROSTER_MEASURE_DATABASE_URL ?? '';
  if (dsn.includes('nsdfiprfmhdqhbfxfwpv')) return 'staging';
  if (dsn.includes('lfbwhxvwubzeqkztghok')) return 'prod';
  return 'unknown-env';
}

async function main() {
  const outArg = argVal('--out', path.join(__dirname, 'patterns.json'));
  const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);
  const patterns = await measure();
  writeFileSync(outPath, JSON.stringify(patterns, null, 2) + '\n');
  process.stdout.write(`Wrote ${outPath}\n`);
  process.stdout.write(`Cohort: ${JSON.stringify(patterns.cohort)}\n`);
  process.stdout.write(`Exclusion set: ${patterns.exclusion.count} salted hashes, digest=${patterns.exclusion.sha256.slice(0, 16)}...\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`measure failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
