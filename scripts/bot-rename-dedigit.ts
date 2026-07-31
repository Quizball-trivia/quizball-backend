/**
 * One-time hygiene pass: reduce the share of persistent-bot nicknames that
 * contain a digit from the roster's initial ~46% down to the real-human
 * baseline (~24%).
 *
 * WHY this exists: the roster generator draws digits per-name at the measured
 * rate, but single-word names get a boosted digit rate to expand their entropy
 * (name-generator.ts). Over 1,000 bots that compounded into a share roughly
 * double the human one, which is a bot tell. This script renames a deterministic
 * subset of digit-bearing bots to digit-free names in the SAME generated style.
 *
 * Ongoing organic renames are the rename worker's job; this only corrects the
 * initial skew.
 *
 * SAFETY MODEL
 *   - Reads prod READ-ONLY through the roster's readonly-db wrapper (explicit
 *     BEGIN READ ONLY + SELECT-only screen + per-query statement timeout).
 *   - Writes ONLY through the audited admin endpoint
 *     PATCH /api/v1/internal/bots/tuning/roster/:botUserId, never raw SQL, so
 *     every rename lands in nickname_history (changed_by='admin', counted=false)
 *     and bot_admin_edits — organic-looking, attributable and reversible.
 *   - Dry-run by default. --execute additionally requires the resolved target to
 *     be the expected Supabase ref and an interactive typed confirmation.
 *
 * Usage:
 *   BOT_DEDIGIT_DATABASE_URL='postgres://…pooler:5432…' \
 *     npx tsx scripts/bot-rename-dedigit.ts [--target N] [--seed N] [--json out.json]
 *   …same env… npx tsx scripts/bot-rename-dedigit.ts --execute
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { buildCandidate } from './persistent-bot-roster/name-generator.js';
import type { NameStructurePatterns } from './persistent-bot-roster/patterns.js';
import { fieldRng } from './persistent-bot-roster/prng.js';
import { nfcLower } from './persistent-bot-roster/exclusion.js';
import { openReadOnlyDb } from './persistent-bot-roster/readonly-db.js';

/** The ONLY project this script may write to. */
const EXPECTED_PROD_REF = 'lfbwhxvwubzeqkztghok';
const DEFAULT_API_BASE = 'https://api.quizball.io';
const DEFAULT_TOKEN_FILE = '/tmp/prod-ops-token.txt';
const DEFAULT_SEED = 20260731;
/** Human baseline: engaged real players carrying a digit in their nickname. */
const DEFAULT_TARGET_DIGIT_SHARE = 0.24;
/** Batch pacing so 200+ renames don't land as one indistinguishable burst. */
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BATCH_PAUSE_MS = 3_000;
const DEFAULT_REQUEST_SPACING_MS = 400;
const RENAME_NOTE = 'owner request: reduce digit-name share to human baseline';
/** Endpoint bound: nickname min/max enforced by patchBotBodySchema. */
const NICKNAME_MIN_LENGTH = 2;
const NICKNAME_MAX_LENGTH = 20;
/** Redraw budget per bot before we give up on that bot (never a bot-tell fallback). */
const MAX_ATTEMPTS_PER_BOT = 60;

interface Cli {
  execute: boolean;
  seed: number;
  target: number | null;
  targetShare: number;
  apiBase: string;
  tokenFile: string;
  batchSize: number;
  batchPauseMs: number;
  jsonOut: string | null;
  sample: number;
  yes: boolean;
}

function parseCli(argv: string[]): Cli {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${flag} must be a number`);
    return n;
  };
  const targetRaw = get('--target');
  return {
    execute: argv.includes('--execute'),
    seed: num('--seed', DEFAULT_SEED),
    target: targetRaw === undefined ? null : Number(targetRaw),
    targetShare: num('--target-share', DEFAULT_TARGET_DIGIT_SHARE),
    apiBase: get('--api-base') ?? process.env.BOT_DEDIGIT_API_BASE ?? DEFAULT_API_BASE,
    tokenFile: get('--token-file') ?? DEFAULT_TOKEN_FILE,
    batchSize: num('--batch-size', DEFAULT_BATCH_SIZE),
    batchPauseMs: num('--batch-pause-ms', DEFAULT_BATCH_PAUSE_MS),
    jsonOut: get('--json') ?? null,
    sample: num('--sample', 20),
    yes: argv.includes('--yes'),
  };
}

interface BotRow extends Record<string, unknown> {
  id: string;
  nickname: string;
  rp: number | null;
}

const hasDigit = (s: string): boolean => /[0-9]/.test(s);

/**
 * Resolve the Supabase project ref from the DSN. Works for both the direct host
 * (db.<ref>.supabase.co) and the pooler (user postgres.<ref>).
 */
function resolveProjectRef(dsn: string): string | null {
  const url = new URL(dsn);
  const hostMatch = /^db\.([a-z0-9]+)\.supabase\.co$/i.exec(url.hostname);
  if (hostMatch) return hostMatch[1];
  const userMatch = /^postgres\.([a-z0-9]+)$/i.exec(decodeURIComponent(url.username));
  if (userMatch) return userMatch[1];
  return null;
}

/**
 * Deterministic, stratified selection: bots are bucketed by RP band and picked
 * round-robin across bands, each band ordered by a seeded hash of the bot id.
 * Spreads renames across the ladder instead of clustering at the top or bottom,
 * and is stable across runs for the same seed + roster.
 */
function selectStratified(bots: BotRow[], count: number, seed: number): BotRow[] {
  const BANDS = 8;
  const rps = bots.map((b) => b.rp ?? 0);
  const maxRp = Math.max(1, ...rps);
  const bands: BotRow[][] = Array.from({ length: BANDS }, () => []);
  for (const bot of bots) {
    const idx = Math.min(BANDS - 1, Math.floor(((bot.rp ?? 0) / (maxRp + 1)) * BANDS));
    bands[idx].push(bot);
  }
  for (const band of bands) {
    band.sort((a, b) => {
      const ra = fieldRng(seed, 0, `order:${a.id}`)();
      const rb = fieldRng(seed, 0, `order:${b.id}`)();
      return ra === rb ? a.id.localeCompare(b.id) : ra - rb;
    });
  }
  // Round-robin across bands, proportional by construction: a band runs dry and
  // is skipped, so the remainder spreads over the bands that still have stock.
  const picked: BotRow[] = [];
  for (let cursor = 0; picked.length < count; cursor++) {
    let progressed = false;
    for (const band of bands) {
      if (cursor < band.length) {
        progressed = true;
        picked.push(band[cursor]);
        if (picked.length === count) break;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

/**
 * Generate a digit-free name in the roster's own style.
 *
 * Reuses buildCandidate verbatim with digitRate forced to 0, then REJECTS any
 * candidate that still carries a digit. The rejection pass is required, not
 * belt-and-braces: the protected-athlete branch appends its own digit token
 * independently of digitRate (name-generator.ts), which leaves ~2% digit-bearing
 * names if you only zero the rate. Rejecting instead of stripping keeps the
 * other measured distributions (two-word rate, casing, separators) intact.
 */
function generateDigitFreeName(
  seed: number,
  bot: BotRow,
  basePatterns: NameStructurePatterns,
  taken: Set<string>,
): string | null {
  const patterns: NameStructurePatterns = { ...basePatterns, digitRate: 0 };
  const rng = fieldRng(seed, 0, `dedigit:${bot.id}`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_BOT; attempt++) {
    const candidate = buildCandidate({ rng, patterns, attempt }).trim();
    if (hasDigit(candidate)) continue;
    if (candidate.length < NICKNAME_MIN_LENGTH || candidate.length > NICKNAME_MAX_LENGTH) continue;
    const key = nfcLower(candidate);
    if (taken.has(key)) continue;
    taken.add(key);
    return candidate;
  }
  return null;
}

interface Rename {
  botUserId: string;
  from: string;
  to: string;
  rp: number | null;
}

async function loadState(seedShare: number) {
  const db = openReadOnlyDb({ statementTimeoutMs: 90_000 });

  // Every name that must not be collided with: live nicknames (all users, not
  // just bots) plus both sides of nickname_history. History matters because the
  // endpoint rejects names another user released inside the reservation window.
  const nameRows = await db.query<{ name: string }[]>(`
    SELECT nickname AS name FROM users WHERE nickname IS NOT NULL
    UNION
    SELECT old_nickname AS name FROM nickname_history WHERE old_nickname IS NOT NULL
    UNION
    SELECT new_nickname AS name FROM nickname_history WHERE new_nickname IS NOT NULL
  `);

  // Candidates: persistent bots with a digit, excluding any bot that is already
  // reserved for a lobby/match, is in a live match, or has ALREADY been renamed
  // by an admin (a second rename of the same bot in one day is not organic).
  const candidates = await db.query<BotRow[]>(`
    SELECT u.id, u.nickname, rp.rp
    FROM users u
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    WHERE u.is_ai = true
      AND u.ai_kind = 'persistent'
      AND u.nickname ~ '[0-9]'
      AND NOT EXISTS (
        SELECT 1 FROM synthetic_bot_reservations r
        WHERE r.bot_user_id = u.id AND (r.expires_at IS NULL OR r.expires_at > now())
      )
      AND NOT EXISTS (
        SELECT 1 FROM match_players mp
        JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = u.id AND m.status IN ('active', 'pending', 'in_progress')
      )
      AND NOT EXISTS (
        SELECT 1 FROM nickname_history nh WHERE nh.user_id = u.id
      )
    ORDER BY u.id
  `);

  const [totals] = await db.query<{ total: string; with_digits: string }[]>(`
    SELECT count(*) AS total, count(*) FILTER (WHERE nickname ~ '[0-9]') AS with_digits
    FROM users WHERE is_ai = true AND ai_kind = 'persistent'
  `);

  const [human] = await db.query<{ total: string; with_digits: string }[]>(`
    SELECT count(*) AS total, count(*) FILTER (WHERE u.nickname ~ '[0-9]') AS with_digits
    FROM users u
    WHERE u.is_ai IS NOT TRUE AND u.nickname IS NOT NULL
      AND EXISTS (SELECT 1 FROM match_players mp WHERE mp.user_id = u.id)
  `);

  const excluded = new Set<string>();
  for (const row of nameRows) if (row.name) excluded.add(nfcLower(row.name));

  return {
    excluded,
    candidates,
    totalBots: Number(totals.total),
    botsWithDigits: Number(totals.with_digits),
    humanTotal: Number(human.total),
    humanWithDigits: Number(human.with_digits),
    targetShare: seedShare,
  };
}

async function patchNickname(
  cli: Cli,
  token: string,
  rename: Rename,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `${cli.apiBase.replace(/\/$/, '')}/api/v1/internal/bots/tuning/roster/${rename.botUserId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-ops-report-token': token },
      body: JSON.stringify({ nickname: rename.to, note: RENAME_NOTE }),
    },
  );
  return { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 300) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  const dsn = process.env.BOT_DEDIGIT_DATABASE_URL;
  if (!dsn) {
    throw new Error(
      'BOT_DEDIGIT_DATABASE_URL is required (never DATABASE_URL, so pointing this at prod is deliberate). ' +
        'Use the SESSION pooler on port 5432.',
    );
  }
  const ref = resolveProjectRef(dsn);
  const port = new URL(dsn).port;
  if (port === '6543') {
    throw new Error('Refusing the transaction pooler (6543): use the session pooler on 5432.');
  }
  // The read wrapper keys off ROSTER_MEASURE_DATABASE_URL; bind it here so the
  // caller never has to set the roster variable to run this script.
  process.env.ROSTER_MEASURE_DATABASE_URL = dsn;

  console.log(`Target project ref : ${ref ?? '(unresolved)'}${ref === EXPECTED_PROD_REF ? '  [PROD]' : ''}`);
  console.log(`Mode               : ${cli.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log(`Seed               : ${cli.seed}\n`);

  const state = await loadState(cli.targetShare);

  const humanShare = state.humanWithDigits / Math.max(1, state.humanTotal);
  const desiredDigitCount = Math.round(state.totalBots * cli.targetShare);
  const neededRaw = state.botsWithDigits - desiredDigitCount;
  const needed = cli.target ?? Math.max(0, neededRaw);
  const renameCount = Math.min(needed, state.candidates.length);

  console.log('CURRENT STATE');
  console.log(`  persistent bots           : ${state.totalBots}`);
  console.log(
    `  bots with a digit         : ${state.botsWithDigits} ` +
      `(${((state.botsWithDigits / state.totalBots) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  human baseline (played)   : ${state.humanWithDigits}/${state.humanTotal} ` +
      `(${(humanShare * 100).toFixed(1)}%)`,
  );
  console.log(`  eligible digit-bots       : ${state.candidates.length} (reserved / in-match / already-renamed excluded)`);
  console.log(`  target digit share        : ${(cli.targetShare * 100).toFixed(1)}%  -> keep ${desiredDigitCount} digit names`);
  console.log(`  renames to perform        : ${renameCount}\n`);

  // Seed the taken-set with every existing name so generated names can collide
  // with neither prod nor each other.
  const taken = new Set(state.excluded);
  const selected = selectStratified(state.candidates, renameCount, cli.seed);

  const renames: Rename[] = [];
  const failures: string[] = [];
  for (const bot of selected) {
    const next = generateDigitFreeName(cli.seed, bot, PATTERNS.name, taken);
    if (!next) {
      failures.push(bot.nickname);
      continue;
    }
    renames.push({ botUserId: bot.id, from: bot.nickname, to: next, rp: bot.rp });
  }

  // Collision audit: against prod, and within the batch itself.
  const seenInBatch = new Set<string>();
  let selfCollisions = 0;
  let prodCollisions = 0;
  for (const r of renames) {
    const key = nfcLower(r.to);
    if (seenInBatch.has(key)) selfCollisions++;
    seenInBatch.add(key);
    if (state.excluded.has(key)) prodCollisions++;
  }
  const digitLeak = renames.filter((r) => hasDigit(r.to)).length;

  const projectedDigits = state.botsWithDigits - renames.length;
  const projectedShare = projectedDigits / state.totalBots;

  console.log(`SAMPLE (${Math.min(cli.sample, renames.length)} of ${renames.length})`);
  for (const r of renames.slice(0, cli.sample)) {
    console.log(`  ${r.from.padEnd(22)} -> ${r.to.padEnd(24)} (rp ${r.rp ?? 0})`);
  }

  const twoWord = renames.filter((r) => r.to.includes(' ')).length;
  console.log('\nRESULT');
  console.log(`  renames generated         : ${renames.length}`);
  console.log(`  collisions vs prod        : ${prodCollisions}`);
  console.log(`  collisions within batch   : ${selfCollisions}`);
  console.log(`  new names still w/ digit  : ${digitLeak}`);
  console.log(`  unresolvable bots         : ${failures.length}`);
  console.log(`  two-word share of new     : ${((twoWord / Math.max(1, renames.length)) * 100).toFixed(1)}%`);
  console.log(
    `  projected digit share     : ${projectedDigits}/${state.totalBots} = ` +
      `${(projectedShare * 100).toFixed(1)}%  (human ${(humanShare * 100).toFixed(1)}%)`,
  );

  if (cli.jsonOut) {
    writeFileSync(
      cli.jsonOut,
      JSON.stringify({ seed: cli.seed, ref, generatedAt: new Date().toISOString(), renames }, null, 2),
    );
    console.log(`\n  plan written to ${cli.jsonOut}`);
  }

  const blocking = prodCollisions + selfCollisions + digitLeak;
  if (blocking > 0) {
    throw new Error(`Refusing to proceed: ${blocking} collision/digit defects in the generated plan.`);
  }

  if (!cli.execute) {
    console.log('\nDRY RUN — nothing was written. Re-run with --execute to apply.');
    return;
  }

  // ---- execution gate ----
  if (ref !== EXPECTED_PROD_REF) {
    throw new Error(`--execute is bound to prod ref ${EXPECTED_PROD_REF}; resolved ${ref ?? 'nothing'}.`);
  }
  const token = readFileSync(cli.tokenFile, 'utf8').trim();
  if (!token) throw new Error(`Ops token file ${cli.tokenFile} is empty`);

  if (!cli.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      `\nType RENAME ${renames.length} to apply these renames to PROD (${ref}): `,
    );
    rl.close();
    if (answer.trim() !== `RENAME ${renames.length}`) {
      console.log('Aborted — confirmation did not match.');
      return;
    }
  }

  let applied = 0;
  const errors: { botUserId: string; status: number; body: string }[] = [];
  for (let i = 0; i < renames.length; i++) {
    const rename = renames[i];
    const result = await patchNickname(cli, token, rename);
    if (result.ok) {
      applied++;
      console.log(`  [${applied}/${renames.length}] ${rename.from} -> ${rename.to}`);
    } else {
      errors.push({ botUserId: rename.botUserId, status: result.status, body: result.body });
      console.error(`  FAILED ${rename.from} -> ${rename.to}: ${result.status} ${result.body}`);
    }
    if (i < renames.length - 1) {
      const endOfBatch = (i + 1) % cli.batchSize === 0;
      await sleep(endOfBatch ? cli.batchPauseMs : DEFAULT_REQUEST_SPACING_MS);
    }
  }

  console.log(`\nApplied ${applied}/${renames.length}; ${errors.length} failed.`);
  if (errors.length > 0) process.exitCode = 1;
}

// patterns.json is the checked-in measured distribution the roster was built
// from; reusing it keeps renamed bots stylistically identical to the rest.
const PATTERNS = JSON.parse(
  readFileSync(new URL('./persistent-bot-roster/patterns.json', import.meta.url), 'utf8'),
) as { name: NameStructurePatterns };

main().catch((error: unknown) => {
  console.error(`\nbot-rename-dedigit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
