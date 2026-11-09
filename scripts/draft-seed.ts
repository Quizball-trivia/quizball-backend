/**
 * Seeds Football Draft content. Dry run unless --write.
 *
 *   npx tsx scripts/draft-seed.ts --pack <football-draft.json> --release <id> --target local|staging|production [--write] [--activate]
 *   npx tsx scripts/draft-seed.ts --days --release <id> --target … [--write]
 *
 * The pack comes from the private store (~/dev/quizball-private/football-draft/build_dev_pack.py); it never enters this
 * repository. Days: one setup per calendar day, the league rotating, each with a fresh random seed that stays in the
 * database (anyone holding a day's seed could work out its deal). A day already seeded is left as it is. Prints counts only.
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { resolvePistasSeedTarget, SEED_TARGETS, type PistasSeedTarget } from '../src/modules/pistas/pistas.seed.js';
import { CONTENT_START, PUBLISHED_DAYS } from '../src/modules/draft/draft-daily.days.js';
import { draftPackSchema, universeOf } from '../src/modules/draft/draft.universe.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name: string): boolean => args.includes(`--${name}`);

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const versionOf = (text: string): number => (createHash('sha256').update(text).digest().readUInt32BE(0) % 4_294_967_295) + 1;

async function main(): Promise<void> {
  const targetName = opt('target') as PistasSeedTarget | undefined;
  if (!targetName || !(SEED_TARGETS as readonly string[]).includes(targetName)) throw new Error(`--target must be one of ${SEED_TARGETS.join(', ')}`);
  const release = opt('release');
  if (!release) throw new Error('--release is required');
  const target = resolvePistasSeedTarget(process.env.DATABASE_URL, targetName);
  const write = has('write');
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => undefined, ssl: target.kind === 'local' ? false : 'require' });
  try {
    if (opt('pack')) {
      const raw: unknown = JSON.parse(readFileSync(resolve(opt('pack')!), 'utf8'));
      const pack = draftPackSchema.parse(raw);
      const u = universeOf(pack);
      // Every league must be able to name a full set of rivals, and every squad must be readable.
      for (const league of pack.leagues) {
        const rivals = u.opponents(league.id, 'check');
        if (rivals.length < league.teams - 1) throw new Error(`${league.id}: only ${rivals.length} rivals`);
      }
      console.log(`pack ${release}: ${pack.leagues.length} leagues, ${pack.clubs.length} club-seasons`);
      if (write) {
        let fresh = true;
        await sql.begin(async (tx) => {
          const inserted = await tx`INSERT INTO draft_packs (release, pack, active) VALUES (${release}, ${tx.json(pack as never)}, false) ON CONFLICT (release) DO NOTHING RETURNING release`;
          if (!inserted.length) {
            // A release id is never rewritten: corrected content needs a new one, or runs would change under players.
            const [same] = await tx<Array<{ same: boolean }>>`SELECT pack = ${tx.json(pack as never)}::jsonb AS same FROM draft_packs WHERE release = ${release}`;
            if (!same?.same) throw new Error(`release ${release} is already seeded with different content: use a new --release`);
            console.log(`release ${release} already seeded with this pack: unchanged`);
            fresh = false;
          }
          if (has('activate')) {
            await tx`UPDATE draft_packs SET active = false WHERE active AND release <> ${release}`;
            await tx`UPDATE draft_packs SET active = true WHERE release = ${release}`;
          }
        });
        console.log(`${fresh ? 'written' : 'kept'}${has('activate') ? ' and active' : ''}`);
      } else console.log('dry run: nothing written');
    }
    if (has('days')) {
      const [packRow] = await sql<Array<{ pack: unknown }>>`SELECT pack FROM draft_packs WHERE release = ${release}`;
      if (!packRow) throw new Error(`release ${release} is not seeded here`);
      const leagues = draftPackSchema.parse(packRow.pack).leagues;
      const rows = Array.from({ length: PUBLISHED_DAYS }, (_, i) => {
        const setup = { release, leagueId: leagues[i % leagues.length].id, era: 'all', formation: '4-3-3', seed: randomBytes(16).toString('hex') };
        return { day: addDays(CONTENT_START, i), number: i + 1, setup, contentVersion: versionOf(`${release}|${i}`) };
      });
      console.log(`days: ${rows.length} from ${rows[0].day} to ${rows[rows.length - 1].day}`);
      if (write) {
        let added = 0;
        for (const r of rows) {
          const out = await sql`INSERT INTO draft_days (day, number, content_version, setup) VALUES (${r.day}, ${r.number}, ${r.contentVersion}, ${sql.json(r.setup as never)}) ON CONFLICT (day) DO NOTHING RETURNING day`;
          added += out.length;
        }
        console.log(`added ${added}, already there ${rows.length - added}`);
      } else console.log('dry run: nothing written');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
