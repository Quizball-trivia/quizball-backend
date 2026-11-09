/**
 * One locale's question text for PRODUCTION, copied row by row from staging, where translate-missing-locales.ts wrote it.
 * A production question takes staging's text only when staging has the same question id and, node by node, the same
 * English: every {en,…} node of prompt, payload and explanation is compared in order, and only an empty production slot
 * of the locale is filled. Nothing else in a row changes. Questions without such a match are left for
 * `translate-missing-locales.ts apply --production`.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/questions-locale-from-staging.ts --locale=pt            # dry run
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/questions-locale-from-staging.ts --locale=pt --write    # write
 *
 * Read: published questions and every question a campaign quiz page serves. Writes go in short transactions of CHUNK
 * rows (one statement each), each preceded by a JSON snapshot of the rows' current text, and skip any row edited since
 * it was read (questions.updated_at and a hash of the payload).
 */
import postgres from 'postgres';
import { banner, connect, opt, pause, readOnly, requireLocale, sample, snapshot, WRITE, writeTx } from './locale-copy-common.js';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Node = { en: string; [locale: string]: Json };
type Row = { id: string; prompt: Json; payload: Json; explanation: Json; updated_at: string; payload_h: string };

const LOCALE = requireLocale();
const CHUNK = 100;
const LIMIT = Number(opt('limit') ?? 0);
const { prod, staging } = connect();

const isNode = (v: Json): v is Node => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Node).en === 'string';
const empty = (v: unknown) => typeof v !== 'string' || v.trim() === '';
function nodes(v: Json, out: Node[] = []): Node[] {
  if (isNode(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => nodes(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => nodes(x, out));
  return out;
}
const all = (r: Row) => [...nodes(r.prompt), ...nodes(r.payload), ...nodes(r.explanation)];

/** In id pages: one large result through the pooler can drop the connection. */
async function questions(sql: postgres.Sql): Promise<Map<string, Row>> {
  const out = new Map<string, Row>();
  // Small pages in primary-key order: a 2,000-row page took ~9 s on production and the pooler dropped the connection.
  for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
    const from = after;
    const page = await readOnly(sql, (tx) => tx<Row[]>`
      SELECT q.id::text AS id, q.prompt, qp.payload, q.explanation, q.updated_at::text AS updated_at, md5(qp.payload::text) AS payload_h
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
      WHERE (q.status = 'published' OR EXISTS (SELECT 1 FROM campaign_quiz_questions c WHERE c.question_id = q.id))
        AND q.id > ${from}::uuid ORDER BY q.id LIMIT 300`);
    for (const r of page) out.set(r.id, r);
    if (page.length < 300) return out;
    after = page[page.length - 1].id;
  }
}

async function main() {
  banner('questions', LOCALE);
  const [target, source] = await Promise.all([questions(prod), questions(staging)]);
  const stats = { rows: target.size, complete: 0, noSource: 0, shapeDiffers: 0, englishDiffers: 0, slotsAlreadySet: 0, slotsSourceEmpty: 0, slotsToFill: 0 };
  const plan: Row[] = [];
  const leftForTranslator: string[] = [];
  for (const row of target.values()) {
    const mine = all(row);
    if (mine.every((n) => !empty(n[LOCALE]))) { stats.complete += 1; continue; }
    const src = source.get(row.id);
    if (!src) { stats.noSource += 1; leftForTranslator.push(row.id); continue; }
    const theirs = all(src);
    if (mine.length !== theirs.length) { stats.shapeDiffers += 1; leftForTranslator.push(row.id); continue; }
    // One differing English node means the question was edited on one side: the whole row goes to the translator.
    if (mine.some((n, i) => n.en !== theirs[i].en)) { stats.englishDiffers += 1; leftForTranslator.push(row.id); continue; }
    let changed = 0;
    mine.forEach((n, i) => {
      if (!empty(n[LOCALE])) { stats.slotsAlreadySet += 1; return; }
      if (empty(theirs[i][LOCALE])) { stats.slotsSourceEmpty += 1; return; }
      n[LOCALE] = theirs[i][LOCALE];
      changed += 1;
    });
    if (changed > 0) { plan.push(row); stats.slotsToFill += changed; }
    if (mine.some((n) => empty(n[LOCALE]))) leftForTranslator.push(row.id);
  }
  if (LIMIT > 0) plan.splice(LIMIT);
  console.log(stats);
  console.log(`rows to write: ${plan.length}`);
  console.log(`rows that will still lack ${LOCALE} afterwards (for translate-missing-locales --production): ${leftForTranslator.length}${sample(leftForTranslator)}`);
  if (!WRITE || plan.length === 0) return;

  let written = 0, skipped = 0, failed = 0;
  for (let c = 0; c < plan.length; c += CHUNK) {
    const chunk = plan.slice(c, c + CHUNK);
    const ids = chunk.map((r) => r.id);
    const before = await readOnly(prod, (tx) => tx`SELECT q.id, q.prompt, qp.payload, q.explanation, q.updated_at::text AS updated_at
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.id::text = ANY(${ids})`);
    snapshot(`questions-${LOCALE}`, before);
    try {
      const done = await writeTx(prod, async (tx) => {
        // Both rows of each question are locked first and checked under the lock, so an edit that commits while this
        // chunk waits is never overwritten (an UPDATE that only re-checks its own WHERE would not see it).
        const locked = await tx<Array<{ id: string; updated_at: string; payload_h: string }>>`
          SELECT q.id::text AS id, q.updated_at::text AS updated_at, md5(p.payload::text) AS payload_h
          FROM questions q JOIN question_payloads p ON p.question_id = q.id
          WHERE q.id::text = ANY(${ids}) FOR UPDATE OF q, p`;
        const now = new Map(locked.map((l) => [l.id, l]));
        const rows = chunk
          .filter((r) => now.get(r.id)?.updated_at === r.updated_at && now.get(r.id)?.payload_h === r.payload_h)
          .map((r) => ({ id: r.id, prompt: r.prompt, explanation: r.explanation, payload: r.payload }));
        if (rows.length === 0) return [];
        return tx<Array<{ id: string }>>`
          WITH v AS (
            SELECT * FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb) AS x(id text, prompt jsonb, explanation jsonb, payload jsonb)
          ), q AS (
            UPDATE questions q SET prompt = v.prompt, explanation = v.explanation
            FROM v WHERE q.id::text = v.id
            RETURNING q.id::text AS id
          )
          UPDATE question_payloads p SET payload = v.payload FROM v JOIN q ON q.id = v.id
          WHERE p.question_id::text = v.id
          RETURNING p.question_id::text AS id`;
      }, { campaignGuard: true });
      written += done.length;
      skipped += chunk.length - done.length;
    } catch (e) {
      failed += chunk.length;
      console.error(`chunk ${c / CHUNK + 1} rolled back: ${(e as Error).message}`);
    }
    await pause(250);
    console.log(`rows ${Math.min(c + CHUNK, plan.length)}/${plan.length} · written ${written} · skipped ${skipped} · failed ${failed}`);
  }
  console.log(`done: written ${written}, skipped (edited meanwhile) ${skipped}, failed ${failed}; a re-run fills only what is still empty`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));
