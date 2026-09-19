import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { contentHash } from './question-manifest.mjs';
import { validateQuestionPackage } from './question-package.mjs';
import { validateQuestionPublicationPlan } from './question-publication.mjs';
import { rowsBeforeMediaBindings } from './content-media-bindings.mjs';

const CHUNK_SIZE = 100;

export function checkQuestionImportTarget(url, expectedProject, { allowLocal = false } = {}) {
  const target = new URL(url);
  if (allowLocal && target.hostname === '127.0.0.1' && target.port === '55519' && /^\/rehearsal_[a-z0-9_]+$/.test(target.pathname)) return;
  if (!/^[a-z]{20}$/.test(expectedProject)) throw new Error('Expected a pinned Supabase project');
  const direct = target.hostname === `db.${expectedProject}.supabase.co` && decodeURIComponent(target.username) === 'postgres';
  const session = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(target.hostname) && decodeURIComponent(target.username) === `postgres.${expectedProject}`;
  if ((!direct && !session) || (target.port && target.port !== '5432') || target.pathname !== '/postgres') throw new Error('Question importer requires the exact direct/session target; transaction pooler is refused');
}

async function journal(tx, batchId, table, before, after, phase) {
  await tx`INSERT INTO question_release_rows (batch_id,table_name,row_id,phase,before_data,after_data)
    VALUES (${batchId},${table},${after.id},${phase},${before == null ? null : tx.json(before)},${tx.json(after)})`;
}
const same = (a, b) => contentHash(a) === contentHash(b);
async function scopedTransaction(sql, fn, { readOnly = false } = {}) {
  return sql.begin(readOnly ? 'ISOLATION LEVEL REPEATABLE READ READ ONLY' : '', async tx => {
    await tx`SET LOCAL lock_timeout='2s'`;
    await tx`SET LOCAL statement_timeout='30s'`;
    await tx`SET LOCAL timezone='UTC'`;
    // A transaction lock serializes chunks without pinning a cloud connection
    // through operator pauses. The row receipts make retries idempotent.
    if (!readOnly) await tx`SELECT pg_advisory_xact_lock(20260919,33342)`;
    return fn(tx);
  });
}

export async function importQuestionPackage(sql, input, { dryRun = true } = {}) {
  const pkg = validateQuestionPackage(input);
  const report = { batchId: pkg.sha256, dryRun, insertedQuestions: 0, insertedCategories: 0, resumedQuestions: 0, conflictsUnchanged: pkg.unresolvedConflicts.length + (pkg.preservedConflicts?.length ?? 0), conflictDraftsPlanned: pkg.preservedConflicts?.length ?? 0 };
  const targetCategories = await sql`SELECT id,slug FROM categories`;
  const categoryById = new Map(targetCategories.map(row => [row.id, row.slug]));
  for (const row of pkg.categoryPrerequisites) if (categoryById.get(row.id) !== row.slug) throw new Error('Target category identity changed since the snapshot');
  // Preflight the complete set before the first write. A racing insert is also
  // caught by the PK inside a chunk, never overwritten with ON CONFLICT UPDATE.
  const ids = pkg.additions.map(item => item.question.id);
  const existing = ids.length ? await sql`SELECT id FROM questions WHERE id=ANY(${sql.array(ids)}::uuid[])` : [];
  const receipts = await sql`SELECT row_id,after_data FROM question_release_rows WHERE batch_id=${pkg.sha256} AND table_name='questions' AND phase='import'`;
  const owned = new Set(receipts.map(row => row.row_id));
  for (const row of existing) if (!owned.has(row.id)) throw new Error(`Target question appeared after snapshot: ${row.id}`);
  if (dryRun) return { ...report, questionsToInsert: ids.length - existing.length, categoriesToInsert: pkg.categories.filter(row => !categoryById.has(row.id)).length };
  const preservationMap = {
    conflictPolicy: pkg.conflictPolicy ?? 'hold',
    sourceSnapshotHash: pkg.sourceSnapshotHash, targetSnapshotHash: pkg.targetSnapshotHash,
    conflicts: pkg.preservedConflicts ?? [],
    additions: pkg.additions.map(item => ({ questionId: item.question.id, provenance: item.provenance ?? null, publication: item.publication })),
  };
  await scopedTransaction(sql, async tx => {
    await tx`INSERT INTO question_release_batches(id,source_project,target_project,manifest_sha256,preservation_map)
      VALUES (${pkg.sha256},${pkg.sourceProject},${pkg.targetProject},${pkg.sha256},${tx.json(preservationMap)}) ON CONFLICT (id) DO NOTHING`;
    const batch = (await tx`SELECT * FROM question_release_batches WHERE id=${pkg.sha256}`)[0];
    if (batch.source_project !== pkg.sourceProject || batch.target_project !== pkg.targetProject || batch.manifest_sha256 !== pkg.sha256 || !same(batch.preservation_map,preservationMap)) throw new Error('Batch receipt does not match package');
    const inserted = new Set(categoryById.keys());
    let pending = [...pkg.categories];
    while (pending.length) {
      const ready = pending.filter(row => !row.parent_id || inserted.has(row.parent_id));
      if (!ready.length) throw new Error('Unresolved category tree');
      for (const row of ready) {
        const current = (await tx`SELECT * FROM categories WHERE id=${row.id} OR slug=${row.slug}`)[0];
        if (current) {
          const receipt = (await tx`SELECT after_data FROM question_release_rows WHERE batch_id=${pkg.sha256} AND table_name='categories' AND row_id=${row.id} AND phase='import'`)[0];
          if (!receipt || !same(current, receipt.after_data)) throw new Error('New category changed or was created outside this release');
        } else {
          const after = (await tx`INSERT INTO categories ${tx(row)} RETURNING *`)[0];
          await journal(tx,pkg.sha256,'categories',null,after,'import'); report.insertedCategories++;
        }
        inserted.add(row.id);
      }
      pending = pending.filter(row => !inserted.has(row.id));
    }
  });
  for (let i=0; i<pkg.additions.length; i+=CHUNK_SIZE) {
    await scopedTransaction(sql, async tx => {
      const chunk = pkg.additions.slice(i,i+CHUNK_SIZE);
      const chunkIds = chunk.map(item=>item.question.id);
      const currentRows = await tx`SELECT q.* FROM questions q WHERE id=ANY(${tx.array(chunkIds)}::uuid[]) FOR UPDATE`;
      const currentById = new Map(currentRows.map(row=>[row.id,row]));
      const prior = await tx`SELECT * FROM question_release_rows WHERE batch_id=${pkg.sha256} AND row_id=ANY(${tx.array(chunkIds)}::uuid[]) AND table_name='questions' AND phase='import'`;
      const priorById = new Map(prior.map(row=>[row.row_id,row.after_data]));
      const fresh = [];
      for (const item of chunk) {
        const current = currentById.get(item.question.id);
        if (current) {
          if (!priorById.has(current.id) || !same(current,priorById.get(current.id))) throw new Error('Imported question has changed; automatic resume refused');
          const [currentPayload] = await rowsBeforeMediaBindings(tx,pkg.sha256,'question_payloads',await tx`SELECT * FROM question_payloads WHERE question_id=${current.id}`);
          const oldPayload = (await tx`SELECT after_data FROM question_release_rows WHERE batch_id=${pkg.sha256} AND table_name='question_payloads' AND row_id=${item.payload.id} AND phase='import'`)[0];
          if (!oldPayload || !same(currentPayload,oldPayload.after_data)) throw new Error('Imported payload has changed; automatic resume refused');
          report.resumedQuestions++;
        } else fresh.push(item);
      }
      if (!fresh.length) return;
      const questions = await tx`INSERT INTO questions ${tx(fresh.map(item=>item.question))} RETURNING *`;
      const payloads = await tx`INSERT INTO question_payloads ${tx(fresh.map(item=>item.payload))} RETURNING *`;
      const entries = [...questions.map(row=>({batch_id:pkg.sha256,table_name:'questions',row_id:row.id,phase:'import',before_data:null,after_data:tx.json(row)})),...payloads.map(row=>({batch_id:pkg.sha256,table_name:'question_payloads',row_id:row.id,phase:'import',before_data:null,after_data:tx.json(row)}))];
      await tx`INSERT INTO question_release_rows ${tx(entries)}`;
      report.insertedQuestions += questions.length;
    });
  }
  return report;
}

/** Publish only an explicitly selected subset of this release's unchanged rows.
 * Preflight every selection before writing, then recheck each locked chunk.
 * Failure midway leaves durable receipts for a safe retry or soft undo.
 */
export async function publishImportedQuestions(sql, input, publicationInput, { dryRun = true } = {}) {
  const pkg = validateQuestionPackage(input);
  const plan = validateQuestionPublicationPlan(publicationInput, pkg);
  const items = new Map(pkg.additions.map(item => [item.question.id, item]));
  const result = { batchId: pkg.sha256, planSha256: plan.sha256, verificationSha256: plan.verificationSha256, dryRun, published: 0, alreadyPublished: 0 };
  const checkChunk = async (tx, chunk, lock) => {
    const ids = chunk.map(item => item.id);
    const questions = await tx`SELECT * FROM questions WHERE id=ANY(${tx.array(ids)}::uuid[]) ${lock ? tx`FOR UPDATE` : tx``}`;
    const payloads = await rowsBeforeMediaBindings(tx,pkg.sha256,'question_payloads',await tx`SELECT * FROM question_payloads WHERE question_id=ANY(${tx.array(ids)}::uuid[]) ${lock ? tx`FOR UPDATE` : tx``}`);
    const payloadIds = chunk.map(row => items.get(row.id).payload.id);
    const receipts = await tx`SELECT * FROM question_release_rows WHERE batch_id=${pkg.sha256} AND row_id=ANY(${tx.array([...ids,...payloadIds])}::uuid[])`;
    const currentById = new Map(questions.map(row => [row.id,row]));
    const payloadByQuestion = new Map(payloads.map(row => [row.question_id,row]));
    const receiptByKey = new Map(receipts.map(row => [`${row.table_name}:${row.row_id}:${row.phase}`,row.after_data]));
    return chunk.map(selection => {
      const id=selection.id, item=items.get(id), current=currentById.get(id);
      if (receiptByKey.has(`questions:${id}:undo`)) throw new Error('This import was undone; automatic republication is refused');
      const published=receiptByKey.get(`questions:${id}:publish`);
      const imported=receiptByKey.get(`questions:${id}:import`);
      const importedPayload=receiptByKey.get(`question_payloads:${item.payload.id}:import`);
      if (!imported || !current || !same(current,published ?? imported)
          || !importedPayload || !same(payloadByQuestion.get(id),importedPayload)) throw new Error(`Question or payload changed or lacks an import receipt: ${id}`);
      return {selection,current,alreadyPublished:Boolean(published)};
    });
  };
  // Preview is a consistent read-only transaction with no locks or receipts.
  await scopedTransaction(sql, async tx => {
    for(let i=0;i<plan.selections.length;i+=CHUNK_SIZE) {
      const checked=await checkChunk(tx,plan.selections.slice(i,i+CHUNK_SIZE),false);
      if(dryRun) for(const row of checked) result[row.alreadyPublished ? 'alreadyPublished' : 'published']++;
    }
  },{readOnly:true});
  if(dryRun) return result;
  for(let i=0;i<plan.selections.length;i+=CHUNK_SIZE) {
    await scopedTransaction(sql,async tx=>{
      const checked=await checkChunk(tx,plan.selections.slice(i,i+CHUNK_SIZE),true);
      for(const row of checked) {
        if(row.alreadyPublished){result.alreadyPublished++;continue;}
        const after=(await tx`UPDATE questions SET status='published',ranked_eligible=${row.selection.rankedEligible} WHERE id=${row.selection.id} RETURNING *`)[0];
        await journal(tx,pkg.sha256,'questions',row.current,after,'publish');
        result.published++;
      }
    });
  }
  return result;
}

/** Soft rollback: retain rows and all references, make only still-owned rows
 * unavailable. If an editor/game has changed a row, flag it for review rather
 * than deleting it, overwriting the edit, or rewriting a player's history.
 */
export async function archiveImportedQuestions(sql, input, { dryRun = true } = {}) {
  const pkg=validateQuestionPackage(input);
  const result={batchId:pkg.sha256,dryRun,archived:0,alreadyUndone:0,needsReview:[]};
  for(let i=0;i<pkg.additions.length;i+=CHUNK_SIZE){
    await scopedTransaction(sql,async tx=>{
      for(const item of pkg.additions.slice(i,i+CHUNK_SIZE)){
        const receipts=await tx`SELECT phase,after_data FROM question_release_rows WHERE batch_id=${pkg.sha256} AND table_name='questions' AND row_id=${item.question.id}`;
        if(!receipts.length)continue;
        if(receipts.some(row=>row.phase==='undo')){result.alreadyUndone++;continue;}
        const expected=receipts.find(row=>row.phase==='publish')??receipts.find(row=>row.phase==='import');
        const current=(await tx`SELECT * FROM questions WHERE id=${item.question.id} ${dryRun ? tx`` : tx`FOR UPDATE`}`)[0];
        const [payload]=await rowsBeforeMediaBindings(tx,pkg.sha256,'question_payloads',await tx`SELECT * FROM question_payloads WHERE question_id=${item.question.id} ${dryRun ? tx`` : tx`FOR UPDATE`}`);
        const payloadReceipt=(await tx`SELECT after_data FROM question_release_rows WHERE batch_id=${pkg.sha256} AND table_name='question_payloads' AND row_id=${item.payload.id} AND phase='import'`)[0];
        if(!current||!expected||!same(current,expected.after_data)||!payloadReceipt||!same(payload,payloadReceipt.after_data)){result.needsReview.push(item.question.id);continue;}
        if(!dryRun){const after=(await tx`UPDATE questions SET status='archived',ranked_eligible=false WHERE id=${item.question.id} RETURNING *`)[0];await journal(tx,pkg.sha256,'questions',current,after,'undo');}
        result.archived++;
      }
    }, { readOnly: dryRun });
  }
  return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);const mode=args[0];const packagePath=args[1];const publishing=['publish-check','publish'].includes(mode);
  if(!['check','import','undo-check','undo','publish-check','publish'].includes(mode)||!packagePath||(publishing&&!args[2])||args.slice(publishing?3:2).some(arg=>arg!=='--allow-local'))throw new Error('Usage: question-import.mjs check|import|undo-check|undo package.json [--allow-local], or publish-check|publish package.json publication-plan.json [--allow-local]');
  const pkg=validateQuestionPackage(JSON.parse(readFileSync(packagePath,'utf8')));
  const publication=publishing?validateQuestionPublicationPlan(JSON.parse(readFileSync(args[2],'utf8')),pkg):null;
  const url=process.env.QUESTION_RELEASE_DATABASE_URL;
  if(!url||process.env.QUESTION_RELEASE_EXPECTED_PROJECT!==pkg.targetProject)throw new Error('Explicit database URL and expected project are required');
  checkQuestionImportTarget(url,pkg.targetProject,{allowLocal:args.includes('--allow-local')});
  const sql=postgres(url,{max:1,prepare:false,onnotice:()=>{},connect_timeout:10,idle_timeout:5});
  try{const result=publishing?await publishImportedQuestions(sql,pkg,publication,{dryRun:mode==='publish-check'}):mode.startsWith('undo')?await archiveImportedQuestions(sql,pkg,{dryRun:mode==='undo-check'}):await importQuestionPackage(sql,pkg,{dryRun:mode==='check'});console.log(JSON.stringify(result));}finally{await sql.end({timeout:5});}
}
